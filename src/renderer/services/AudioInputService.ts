/**
 * Client-side audio input service for the Minecraft companion.
 * Streams microphone audio to the Voxta server over a WebSocket.
 *
 * Mirrors the architecture of voxta-talk's AudioInputService:
 * - One WebSocket per session, kept alive with keepAlive during pauses
 * - pause/resume for recording stop/start within the same session
 * - Full stop after a timeout (30s) of inactivity
 * - Full restart on new session ID
 */

import { MediaRecorder, register } from 'extendable-media-recorder';
import { connect } from 'extendable-media-recorder-wav-encoder';
import type { IMediaRecorder } from 'extendable-media-recorder';

const TIMESLICE_MS = 30;
const AUDIO_BITS_PER_SECOND = 64_000;
const KEEP_ALIVE_MS = 15_000;
const RECONNECT_RETRY_MS = 1_000;
const RECORDING_OFF_TIMEOUT_MS = 30_000;

/** Forward log to main process terminal via IPC */
function log(msg: string): void {
    try {
        window.api.log(msg);
    } catch {
        console.log(msg);
    }
}

// Register WAV encoder once at module load
const registerPromise = (async () => {
    try {
        await register(await connect());
    } catch {
        // Already registered — safe to ignore
    }
})();

export class AudioInputService {
    public sessionId: string | null = null;
    public enabled = false;
    public paused = false;

    private stream: MediaStream | null = null;
    private socket: WebSocket | null = null;
    private mediaRecorder: IMediaRecorder | null = null;
    private shouldRetry = false;
    private readyToSend = false;
    private retryInProgress = false;
    private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    private recordingOffTimeout: ReturnType<typeof setTimeout> | null = null;
    private chunksSent = 0;

    /** Start streaming — acquires mic, connects WebSocket, starts MediaRecorder */
    async startStreaming(sessionId: string, voxtaBaseUrl: string, apiKey: string | null): Promise<void> {
        await registerPromise;

        if (this.enabled) {
            if (this.sessionId === sessionId) {
                // Same session — stop and restart (matches voxta-talk behavior)
                this.stopStreaming();
            } else {
                return;
            }
        }

        this.sessionId = sessionId;
        this.enabled = true;
        this.shouldRetry = true;
        this.chunksSent = 0;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

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
                    this.chunksSent++;
                }
            };

            // Build WebSocket URL
            const wsProtocol = voxtaBaseUrl.startsWith('https') ? 'wss' : 'ws';
            const host = voxtaBaseUrl.replace(/^https?:\/\//, '');
            let wsUrl = `${wsProtocol}://${host}/ws/audio/input/stream?sessionId=${sessionId}`;
            if (apiKey) {
                wsUrl += `&access_token=${encodeURIComponent(apiKey)}`;
            }

            await this.connectWebSocket(sessionId, wsUrl);

            this.mediaRecorder.start(TIMESLICE_MS);

            // Monitor mic track
            const track = this.stream.getAudioTracks()[0];
            if (track) {
                track.addEventListener('ended', () => {
                    log('[AudioInput] Mic track ended unexpectedly!');
                });
                log(
                    `[AudioInput] Started streaming (track: ${track.readyState}, enabled: ${track.enabled}, muted: ${track.muted})`,
                );
            }
        } catch (error) {
            log(`[AudioInput] Error starting: ${error instanceof Error ? error.message : String(error)}`);
            this.stopStreaming();
        }
    }

    /** Full stop — releases mic, WebSocket, MediaRecorder */
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
        if (this.recordingOffTimeout) {
            clearTimeout(this.recordingOffTimeout);
            this.recordingOffTimeout = null;
        }
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.mediaRecorder = null;
        if (this.socket) {
            this.socket.onerror = () => {
                /* noop */
            };
            this.socket.onclose = () => {
                /* noop */
            };
            this.socket.close();
        }
        this.socket = null;

        log(`[AudioInput] Stopped streaming (${this.chunksSent} chunks sent total)`);
    }

    /** Pause — stop sending data, send keepAlives to keep WebSocket alive */
    pauseStreaming(): void {
        if (!this.enabled || this.paused) return;
        this.paused = true;
        this.keepAliveInterval = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'keepalive' }));
            } else {
                log(`[AudioInput] Keepalive skipped — socket state: ${this.socket?.readyState ?? 'null'}`);
            }
        }, KEEP_ALIVE_MS);
        log(`[AudioInput] Paused (socket: ${this.socket?.readyState ?? 'null'}, chunks sent: ${this.chunksSent})`);
    }

    /** Resume — start sending data again */
    resumeStreaming(): void {
        if (!this.enabled || !this.paused) return;
        this.paused = false;
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }

        const socketState = this.socket?.readyState ?? -1;
        const recorderState = this.mediaRecorder?.state ?? 'null';
        const track = this.stream?.getAudioTracks()[0];
        const trackState = track ? `${track.readyState}, enabled=${track.enabled}, muted=${track.muted}` : 'no track';

        log(
            `[AudioInput] Resumed (socket: ${socketState}, recorder: ${recorderState}, track: ${trackState})`,
        );

        if (socketState !== WebSocket.OPEN) {
            log('[AudioInput] WARNING: WebSocket is NOT open after resume!');
        }
        if (recorderState !== 'recording') {
            log(`[AudioInput] WARNING: MediaRecorder state is "${recorderState}", expected "recording"!`);
        }

        // Verify data is flowing 2s after resume
        const chunksAtResume = this.chunksSent;
        setTimeout(() => {
            if (!this.enabled || this.paused) return;
            const chunksSinceResume = this.chunksSent - chunksAtResume;
            if (chunksSinceResume === 0) {
                log('[AudioInput] WARNING: No audio chunks sent in 2s after resume! Mic data is NOT flowing.');
            } else {
                log(`[AudioInput] Heartbeat OK: ${chunksSinceResume} chunks sent in 2s after resume`);
            }
        }, 2000);
    }

    /**
     * Handle recording request from server (matches voxta-talk RecordingService logic).
     * START: start or resume streaming
     * STOP: pause streaming + arm 30s timeout to fully stop
     */
    handleRecordingRequest(
        enabled: boolean,
        sessionId: string,
        voxtaBaseUrl: string,
        apiKey: string | null,
    ): void {
        if (enabled) {
            if (this.recordingOffTimeout) {
                clearTimeout(this.recordingOffTimeout);
                this.recordingOffTimeout = null;
            }

            const isNewSession = this.sessionId !== sessionId;

            if (!this.enabled || isNewSession) {
                if (isNewSession && this.enabled) {
                    this.stopStreaming();
                }
                void this.startStreaming(sessionId, voxtaBaseUrl, apiKey);
            } else if (this.paused) {
                this.resumeStreaming();
            }
        } else {
            if (this.enabled) {
                if (!this.paused) {
                    this.pauseStreaming();
                }
                // Arm 30s timeout to fully stop (matches voxta-talk)
                if (!this.recordingOffTimeout) {
                    this.recordingOffTimeout = setTimeout(() => {
                        if (this.enabled) {
                            log('[AudioInput] Recording off timeout (30s) — stopping');
                            this.stopStreaming();
                        }
                    }, RECORDING_OFF_TIMEOUT_MS);
                }
            }
        }
    }

    private async connectWebSocket(sessionId: string, url: string): Promise<void> {
        this.readyToSend = false;

        if (this.socket) {
            this.socket.onerror = () => {
                /* noop */
            };
            this.socket.onclose = () => {
                /* noop */
            };
            if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
            this.socket = null;
        }

        log('[AudioInput] Connecting WebSocket...');
        const ws = new WebSocket(url);
        this.socket = ws;

        return new Promise<void>((resolve, reject) => {
            ws.onopen = () => {
                if (!this.shouldRetry || this.socket !== ws) {
                    ws.close();
                    return;
                }

                ws.send(
                    JSON.stringify({
                        contentType: 'audio/wav',
                        sampleRate: 16_000,
                        channels: 1,
                        bitsPerSample: 16,
                        bufferMilliseconds: TIMESLICE_MS,
                    }),
                );
                this.readyToSend = true;
                log('[AudioInput] WebSocket connected');
                resolve();
            };

            ws.onerror = (event) => {
                if (this.socket !== ws) return;
                log(`[AudioInput] WebSocket error: ${JSON.stringify(event)}`);
                ws.onerror = () => {
                    /* noop */
                };
                ws.onclose = () => {
                    /* noop */
                };
                this.handleReconnect(sessionId, url, resolve, reject);
            };

            ws.onclose = (event) => {
                if (this.socket !== ws) return;
                log(
                    `[AudioInput] WebSocket closed (code: ${event.code}, reason: "${event.reason}", clean: ${event.wasClean})`,
                );
                ws.onerror = () => {
                    /* noop */
                };
                ws.onclose = () => {
                    /* noop */
                };
                this.handleReconnect(sessionId, url, resolve, reject);
            };
        });
    }

    private handleReconnect(
        sessionId: string,
        url: string,
        resolve: () => void,
        reject: (e: Error) => void,
    ): void {
        if (this.retryInProgress) return;
        if (this.sessionId !== sessionId) return;
        if (!this.shouldRetry) return;

        this.retryInProgress = true;
        log('[AudioInput] WebSocket disconnected, retrying...');
        setTimeout(() => {
            if (this.sessionId !== sessionId) {
                this.retryInProgress = false;
                return;
            }
            this.connectWebSocket(sessionId, url).then(resolve).catch(reject);
            this.retryInProgress = false;
        }, RECONNECT_RETRY_MS);
    }

    dispose(): void {
        this.stopStreaming();
    }
}
