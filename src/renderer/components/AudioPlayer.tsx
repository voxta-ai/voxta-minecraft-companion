import { onMount, onCleanup } from 'solid-js';
import type { AudioChunk } from '../../shared/ipc-types';

/**
 * Invisible component that manages HTML5 Audio playback.
 * Receives audio chunks from the main process via IPC, plays them in order,
 * and reports playback events back to the main process.
 *
 * This mirrors what Voxta Talk does in its browser for audio playback.
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

            isPlaying = true;
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
                playNext();
            });

            audio.addEventListener('error', () => {
                console.error('[Audio] Failed to play:', chunk.url);
                isPlaying = false;
                currentAudio = null;
                // Still ack so the server flow doesn't hang
                window.api.audioComplete(chunk.messageId);
                playNext();
            });

            audio.play().catch((err) => {
                console.error('[Audio] Play failed:', err);
                isPlaying = false;
                currentAudio = null;
                window.api.audioComplete(chunk.messageId);
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
        });

        onCleanup(() => {
            unsubPlay();
            unsubStop();
            if (currentAudio) {
                currentAudio.pause();
                currentAudio.src = '';
            }
        });
    });

    return null;
}
