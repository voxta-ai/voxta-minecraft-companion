import { onMount, onCleanup, createEffect } from 'solid-js';
import type { AudioChunk, RecordingStartEvent } from '../../shared/ipc-types';
import { AudioInputService } from '../services/AudioInputService';
import {
    setMicStatus,
    micMuted,
    setSpeakerStatus,
    speakerMuted,
    setSpeechPartialText,
} from '../stores/audio-store';

/**
 * Invisible component that manages HTML5 Audio playback and mic streaming.
 * Receives audio chunks from the main process via IPC, plays them in order,
 * and reports playback events back to the main process.
 * Also manages client-side audio input (mic → server WebSocket).
 */
export default function AudioPlayer() {
    onMount(() => {
        const queue: AudioChunk[] = [];
        let currentAudio: HTMLAudioElement | null = null;
        let isPlaying = false;

        function playNext(): void {
            if (isPlaying || queue.length === 0) return;

            const chunk = queue.shift();
            if (!chunk) return;

            // If speaker is muted, skip playback but still ack the server
            if (speakerMuted()) {
                window.api.audioComplete(chunk.messageId);
                playNext();
                return;
            }

            isPlaying = true;
            setSpeakerStatus('playing');
            const audio = new Audio(chunk.url);
            currentAudio = audio;

            audio.addEventListener('loadedmetadata', () => {
                const durationMs = Math.round(audio.duration * 1000);
                window.api.audioStarted({
                    messageId: chunk.messageId,
                    startIndex: chunk.startIndex,
                    endIndex: chunk.endIndex,
                    duration: durationMs,
                    isNarration: chunk.isNarration,
                });
            });

            audio.addEventListener('ended', () => {
                isPlaying = false;
                currentAudio = null;
                window.api.audioComplete(chunk.messageId);
                if (queue.length === 0) {
                    setSpeakerStatus('off');
                }
                playNext();
            });

            audio.addEventListener('error', () => {
                console.error('[Audio] Failed to play:', chunk.url);
                isPlaying = false;
                currentAudio = null;
                // Still ack so the server flow doesn't hang
                window.api.audioComplete(chunk.messageId);
                if (queue.length === 0) {
                    setSpeakerStatus('off');
                }
                playNext();
            });

            audio.play().catch((err) => {
                console.error('[Audio] Play failed:', err);
                isPlaying = false;
                currentAudio = null;
                window.api.audioComplete(chunk.messageId);
                if (queue.length === 0) {
                    setSpeakerStatus('off');
                }
                playNext();
            });
        }

        const unsubPlay = window.api.onPlayAudio((chunk: AudioChunk) => {
            queue.push(chunk);
            playNext();
        });

        const unsubStop = window.api.onStopAudio(() => {
            // Instantly stop — this is the key for clean interruption
            queue.length = 0;
            if (currentAudio) {
                const audio = currentAudio;
                currentAudio = null;
                isPlaying = false;
                audio.pause();
                audio.src = '';
            }
            setSpeakerStatus('off');
        });

        // --- Audio input (mic streaming) ---
        const audioInput = new AudioInputService();

        const unsubRecordingStart = window.api.onRecordingStart((event: RecordingStartEvent) => {
            if (!micMuted()) {
                audioInput.handleRecordingRequest(true, event.sessionId, event.voxtaBaseUrl, event.voxtaApiKey);
                setMicStatus('listening');
            } else {
                // Still track the session but don't start streaming
                audioInput.sessionId = event.sessionId;
                setMicStatus('paused');
            }
        });

        const unsubRecordingStop = window.api.onRecordingStop(() => {
            audioInput.handleRecordingRequest(false, audioInput.sessionId ?? '', '', null);
            setMicStatus('paused');
            setSpeechPartialText('');
        });

        const unsubSpeechPartial = window.api.onSpeechPartial((text: string) => {
            setSpeechPartialText(text);
        });

        // React to mic mute toggle
        createEffect(() => {
            const muted = micMuted();
            if (muted && audioInput.enabled && !audioInput.paused) {
                audioInput.pauseStreaming();
                setMicStatus('paused');
            } else if (!muted && audioInput.enabled && audioInput.paused) {
                audioInput.resumeStreaming();
                setMicStatus('listening');
            }
        });

        // React to speaker mute toggle — if muted mid-playback, stop current audio
        createEffect(() => {
            if (speakerMuted()) {
                queue.length = 0;
                if (currentAudio) {
                    const audio = currentAudio;
                    currentAudio = null;
                    isPlaying = false;
                    audio.pause();
                    audio.src = '';
                    // Don't ack — the server will continue its flow normally
                }
                setSpeakerStatus('off');
            }
        });

        onCleanup(() => {
            unsubPlay();
            unsubStop();
            unsubRecordingStart();
            unsubRecordingStop();
            unsubSpeechPartial();
            audioInput.dispose();
            setMicStatus('off');
            setSpeakerStatus('off');
            setSpeechPartialText('');
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.src = '';
            }
        });
    });

    return null;
}
