import { onMount, onCleanup, createEffect } from 'solid-js';
import type { AudioChunk, RecordingStartEvent } from '../../shared/ipc-types';
import { AudioInputService } from '../services/AudioInputService';
import { SpatialAudioEngine } from '../services/SpatialAudioEngine';
import {
    setMicStatus,
    micMuted,
    setSpeakerStatus,
    speakerMuted,
    setSpeechPartialText,
} from '../stores/audio-store';
import { settings } from '../stores/settings-store';

/**
 * Invisible component that manages audio playback and mic streaming.
 * Uses the SpatialAudioEngine (Web Audio API) for playback with
 * spatial positioning, reverb, and echo effects.
 * Also manages client-side audio input (mic → server WebSocket).
 */
export default function AudioPlayer() {
    onMount(() => {
        const queue: AudioChunk[] = [];
        const engine = new SpatialAudioEngine();
        let isPlaying = false;
        let _currentChunkMessageId: string | null = null;

        // Apply initial settings
        engine.applySettings(settings);

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
            _currentChunkMessageId = chunk.messageId;
            setSpeakerStatus('playing');

            engine
                .playChunk(chunk.url)
                .then(({ duration, onEnded }) => {
                    // Report playback started with actual duration
                    window.api.audioStarted({
                        messageId: chunk.messageId,
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        duration,
                        isNarration: chunk.isNarration,
                    });

                    // Wait for playback to finish
                    return onEnded;
                })
                .then(() => {
                    isPlaying = false;
                    _currentChunkMessageId = null;
                    window.api.audioComplete(chunk.messageId);
                    if (queue.length === 0) {
                        setSpeakerStatus('off');
                    }
                    playNext();
                })
                .catch((err) => {
                    console.error('[Audio] Play failed:', err);
                    isPlaying = false;
                    _currentChunkMessageId = null;
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
            engine.stop();
            isPlaying = false;
            _currentChunkMessageId = null;
            setSpeakerStatus('off');
        });

        // Subscribe to spatial position updates
        const unsubSpatial = window.api.onSpatialPosition((data) => {
            engine.updatePosition(data);
        });

        // --- Audio input (mic streaming) ---
        const audioInput = new AudioInputService();

        // Track whether the server wants recording enabled (independent of user mute)
        let serverRecordingEnabled = false;

        const unsubRecordingStart = window.api.onRecordingStart((event: RecordingStartEvent) => {
            serverRecordingEnabled = true;
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
            serverRecordingEnabled = false;
            audioInput.handleRecordingRequest(false, audioInput.sessionId ?? '', '', null);
            setMicStatus('paused');
            setSpeechPartialText('');
        });

        let speechActiveTimeout: ReturnType<typeof setTimeout> | null = null;

        const unsubSpeechPartial = window.api.onSpeechPartial((text: string) => {
            setSpeechPartialText(text);
            if (text && !micMuted()) {
                // Speech detected — show active state
                if (speechActiveTimeout) clearTimeout(speechActiveTimeout);
                setMicStatus('active');
                // Auto-revert to listening after 1.5s of no new partials
                speechActiveTimeout = setTimeout(() => {
                    if (!micMuted() && audioInput.enabled && !audioInput.paused) {
                        setMicStatus('listening');
                    }
                }, 1500);
            }
        });

        // React to mic mute toggle
        createEffect(() => {
            const muted = micMuted();
            if (muted && audioInput.enabled && !audioInput.paused) {
                audioInput.pauseStreaming();
                setMicStatus('paused');
            } else if (!muted && audioInput.enabled && audioInput.paused && serverRecordingEnabled) {
                // Only resume if server actually wants recording (not during bot speech)
                audioInput.resumeStreaming();
                setMicStatus('listening');
            }
        });

        // React to speaker mute toggle — if muted mid-playback, stop current audio
        createEffect(() => {
            if (speakerMuted()) {
                queue.length = 0;
                engine.stop();
                isPlaying = false;
                _currentChunkMessageId = null;
                setSpeakerStatus('off');
            }
        });

        // React to audio settings changes — apply in real-time
        createEffect(() => {
            engine.applySettings(settings);
        });

        onCleanup(() => {
            unsubPlay();
            unsubStop();
            unsubSpatial();
            unsubRecordingStart();
            unsubRecordingStop();
            unsubSpeechPartial();
            if (speechActiveTimeout) clearTimeout(speechActiveTimeout);
            audioInput.dispose();
            engine.dispose();
            setMicStatus('off');
            setSpeakerStatus('off');
            setSpeechPartialText('');
        });
    });

    return null;
}
