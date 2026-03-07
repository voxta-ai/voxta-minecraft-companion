import type { AudioChunk, AudioPlaybackEvent } from '../shared/ipc-types';
import type { VoxtaClient } from '../bot/voxta/client';
import type { ServerReplyChunkMessage } from '../bot/voxta/types';

/**
 * Manages audio download, playback ordering, and sentinel-based ack
 * for the Voxta speech pipeline. Mirrors the Voxta Talk AudioPlayback
 * pattern: downloads run in parallel, but chunks emit in order via a
 * promise chain. A sentinel callback fires speechPlaybackComplete
 * once all pending chunks are played.
 */
export class AudioPipeline {
    private downloadChain: Promise<void> = Promise.resolve();
    private epoch = 0; // Bumped on interrupt — stale downloads are discarded
    private ackPendingChunks = 0;
    private ackCallback: (() => void) | null = null;
    private emitPlayAudio: (chunk: AudioChunk) => void;

    constructor(emitPlayAudio: (chunk: AudioChunk) => void) {
        this.emitPlayAudio = emitPlayAudio;
    }

    /** Reset the download chain for a new reply */
    resetChain(): void {
        this.downloadChain = Promise.resolve();
    }

    /** Download and queue a reply chunk's audio for playback */
    processReplyChunk(
        chunk: ServerReplyChunkMessage,
        voxta: VoxtaClient,
        voxtaUrl: string,
        voxtaApiKey: string | null,
    ): void {
        if (chunk.audioUrl) {
            // audioUrl is relative — download in the main process to avoid cross-origin issues
            const baseUrl = voxtaUrl.replace(/\/hub\/?$/, '');
            const fullUrl = chunk.audioUrl.startsWith('http') ? chunk.audioUrl : `${baseUrl}${chunk.audioUrl}`;
            const headers: Record<string, string> = {};
            if (voxtaApiKey) headers['Authorization'] = `Bearer ${voxtaApiKey}`;

            // Track chunk in the ack queue
            this.ackPendingChunks++;

            // Start download immediately (parallel) but emit in order via a chain
            const epoch = this.epoch;
            const downloadPromise = fetch(fullUrl, { headers })
                .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.arrayBuffer();
                });

            this.downloadChain = this.downloadChain
                .then(() => downloadPromise)
                .then((buf) => {
                    // If audio was stopped since this chunk was queued, discard it
                    if (this.epoch !== epoch) return;
                    const b64 = Buffer.from(buf).toString('base64');
                    const dataUrl = `data:audio/wav;base64,${b64}`;
                    const audioChunk: AudioChunk = {
                        url: dataUrl,
                        messageId: chunk.messageId,
                        startIndex: chunk.startIndex,
                        endIndex: chunk.endIndex,
                        isNarration: chunk.isNarration,
                    };
                    this.emitPlayAudio(audioChunk);
                })
                .catch((err) => {
                    console.error(`[Audio] Failed to download ${fullUrl}:`, err);
                    // Ack so server flow doesn't hang
                    void voxta.speechPlaybackStart(
                        chunk.messageId, chunk.startIndex, chunk.endIndex, 0, chunk.isNarration,
                    );
                });
        } else {
            // No audio URL — immediately ack playback (matches Voxta Talk)
            void voxta.speechPlaybackStart(
                chunk.messageId, chunk.startIndex, chunk.endIndex, 0, chunk.isNarration,
            );
        }
    }

    /** Renderer reports audio started playing — relay to the server */
    handleAudioStarted(event: AudioPlaybackEvent, voxta: VoxtaClient): void {
        void voxta.speechPlaybackStart(
            event.messageId, event.startIndex, event.endIndex, event.duration, event.isNarration,
        );
    }

    /** Renderer reports audio finished playing — dequeue and check sentinel */
    handleAudioComplete(): void {
        if (this.ackPendingChunks > 0) this.ackPendingChunks--;
        this.tryFireAck();
    }

    /** Set sentinel callback — fires when all pending chunks complete */
    setSentinel(callback: () => void): void {
        this.ackCallback = callback;
        this.tryFireAck();
    }

    /** Fire sentinel callback if all chunks are done (or the queue is empty) */
    private tryFireAck(): void {
        if (this.ackPendingChunks === 0 && this.ackCallback) {
            const cb = this.ackCallback;
            this.ackCallback = null;
            cb();
        }
    }

    /** Immediately fire sentinel (interrupt/cancel) — like Voxta Talk's stop() */
    fireAckNow(): void {
        this.ackPendingChunks = 0;
        this.tryFireAck();
    }

    /** Bump epoch to discard stale downloads — call on interrupt */
    interrupt(): void {
        this.epoch++;
    }
}
