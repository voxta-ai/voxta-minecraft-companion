/**
 * Client-side audio input service for the Minecraft companion.
 * Streams microphone audio to the Voxta server over a WebSocket,
 * replicating how Voxta Talk handles audio input.
 *
 * The server controls when to start/stop via recordingRequest messages.
 * Uses getUserMedia with echoCancellation to prevent the AI's voice
 * from being transcribed as user speech.
 */

import { MediaRecorder, register } from 'extendable-media-recorder';
import { connect } from 'extendable-media-recorder-wav-encoder';
import type { IMediaRecorder } from 'extendable-media-recorder';

const TIMESLICE_MS = 30;
const AUDIO_BITS_PER_SECOND = 64_000;
const KEEP_ALIVE_MS = 15_000;
const RECONNECT_RETRY_MS = 1_000;

// Register WAV encoder once at module load
const registerPromise = (async () => {
    try {
        await register(await connect());
    } catch {
        // Already registered — safe to ignore
    }
})();

export class AudioInputService {
    private sessionId: string | null = null;
    private enabled = false;
    private paused = false;
    private stream: MediaStream | null = null;
    private socket: WebSocket | null = null;
    private mediaRecorder: IMediaRecorder | null = null;
    private shouldRetry = false;
    private readyToSend = false;
    private keepAliveInterval: ReturnType<typeof setInterval> | null = null;

    /** Start streaming mic audio to the server */
    async startStreaming(sessionId: string, voxtaBaseUrl: string, apiKey: string | null): Promise<void> {
        // Wait for WAV encoder registration
        await registerPromise;

        if (this.enabled) {
            if (this.sessionId === sessionId) {
                // Same session — just resume if paused
                if (this.paused) {
                    this.resumeStreaming();
                }
                return;
            }
            // Different session — restart
            this.stopStreaming();
        }

        this.sessionId = sessionId;
        this.enabled = true;
        this.shouldRetry = true;

        try {
            // Request mic with echo cancellation
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // Create MediaRecorder with WAV format
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType: 'audio/wav',
                audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
            });

            this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
                if (
                    !this.paused &&
                    this.readyToSend &&
                    event.data.size > 0 &&
                    this.socket?.readyState === WebSocket.OPEN
                ) {
                    this.socket.send(event.data);
                }
            };

            // Build WebSocket URL with auth token
            const wsProtocol = voxtaBaseUrl.startsWith('https') ? 'wss' : 'ws';
            const host = voxtaBaseUrl.replace(/^https?:\/\//, '');
            let wsUrl = `${wsProtocol}://${host}/ws/audio/input/stream?sessionId=${sessionId}`;
            if (apiKey) {
                wsUrl += `&access_token=${encodeURIComponent(apiKey)}`;
            }

            await this.connectWebSocket(wsUrl);

            // Start recording
            this.mediaRecorder.start(TIMESLICE_MS);
            console.log('[AudioInput] Started streaming');
        } catch (error) {
            console.error('[AudioInput] Error starting:', error);
            this.stopStreaming();
        }
    }

    /** Stop streaming and release all resources */
    stopStreaming(): void {
        if (!this.enabled) return;

        this.enabled = false;
        this.shouldRetry = false;
        this.readyToSend = false;
        this.paused = false;

        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.mediaRecorder = null;

        if (this.socket) {
            this.socket.onerror = () => { /* noop */ };
            this.socket.onclose = () => { /* noop */ };
            this.socket.close();
        }
        this.socket = null;

        console.log('[AudioInput] Stopped streaming');
    }

    /** Pause mic streaming (keep connection alive) — called when AI starts speaking */
    pauseStreaming(): void {
        if (!this.enabled || this.paused) return;
        this.paused = true;
        this.keepAliveInterval = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'keepalive' }));
            }
        }, KEEP_ALIVE_MS);
        console.log('[AudioInput] Paused streaming');
    }

    /** Resume mic streaming — called when AI stops speaking */
    resumeStreaming(): void {
        if (!this.enabled || !this.paused) return;
        this.paused = false;
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        console.log('[AudioInput] Resumed streaming');
    }

    private async connectWebSocket(url: string): Promise<void> {
        this.readyToSend = false;

        if (this.socket) {
            this.socket.onerror = () => { /* noop */ };
            this.socket.onclose = () => { /* noop */ };
            if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
            this.socket = null;
        }

        const ws = new WebSocket(url);
        this.socket = ws;

        return new Promise<void>((resolve, reject) => {
            ws.onopen = () => {
                if (!this.shouldRetry || this.socket !== ws) {
                    ws.close();
                    return;
                }

                // Send audio specs as the first message (same as Voxta Talk)
                ws.send(JSON.stringify({
                    contentType: 'audio/wav',
                    sampleRate: 16_000,
                    channels: 1,
                    bitsPerSample: 16,
                    bufferMilliseconds: TIMESLICE_MS,
                }));
                this.readyToSend = true;
                console.log('[AudioInput] WebSocket connected');
                resolve();
            };

            ws.onerror = () => {
                if (this.socket !== ws) return;
                ws.onerror = () => { /* noop */ };
                ws.onclose = () => { /* noop */ };
                this.handleReconnect(url, resolve, reject);
            };

            ws.onclose = () => {
                if (this.socket !== ws) return;
                ws.onerror = () => { /* noop */ };
                ws.onclose = () => { /* noop */ };
                this.handleReconnect(url, resolve, reject);
            };
        });
    }

    private handleReconnect(
        url: string,
        resolve: () => void,
        reject: (e: Error) => void,
    ): void {
        if (!this.shouldRetry) return;

        console.log('[AudioInput] WebSocket disconnected, retrying...');
        setTimeout(() => {
            if (!this.shouldRetry) return;
            this.connectWebSocket(url).then(resolve).catch(reject);
        }, RECONNECT_RETRY_MS);
    }

    /** Clean up everything */
    dispose(): void {
        this.stopStreaming();
    }
}
