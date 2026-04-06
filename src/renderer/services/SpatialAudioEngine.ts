import type { SpatialPosition, McSettings } from '../../shared/ipc-types';

/**
 * Spatial audio engine using the Web Audio API.
 * Provides distance-based volume attenuation, stereo directional panning,
 * cave-like reverb, and echo effects for the companion's voice.
 */
export class SpatialAudioEngine {
    private ctx: AudioContext | null = null;

    // Effect nodes (persistent across playbacks)
    private gainNode: GainNode | null = null;
    private pannerNode: StereoPannerNode | null = null;
    private masterGain: GainNode | null = null;

    // Reverb
    private reverbNode: ConvolverNode | null = null;
    private reverbDryGain: GainNode | null = null;
    private reverbWetGain: GainNode | null = null;

    // Echo
    private echoDelayNode: DelayNode | null = null;
    private echoFeedbackGain: GainNode | null = null;

    // Current source
    private currentSource: AudioBufferSourceNode | null = null;

    // Spatial state
    private spatialEnabled = false;
    private nearDistance = 5;
    private maxDistance = 32;
    private lastPosition: SpatialPosition | null = null;
    private lastSettings: McSettings | null = null;

    /** Initialize the AudioContext and build the audio graph */
    private ensureContext(): AudioContext {
        if (!this.ctx) {
            this.ctx = new AudioContext();
            this.buildGraph();
        }
        return this.ctx;
    }

    /** Build the Web Audio API node graph */
    private buildGraph(): void {
        const ctx = this.ctx;
        if (!ctx) return;

        // Spatial gain (distance-based volume)
        this.gainNode = ctx.createGain();

        // Stereo panner (left/right direction)
        this.pannerNode = ctx.createStereoPanner();

        // Echo (delay + feedback loop)
        this.echoDelayNode = ctx.createDelay(1.0);
        this.echoDelayNode.delayTime.value = 0.2;
        this.echoFeedbackGain = ctx.createGain();
        this.echoFeedbackGain.gain.value = 0;

        // Reverb (convolver with synthetic impulse response)
        this.reverbNode = ctx.createConvolver();
        this.reverbDryGain = ctx.createGain();
        this.reverbDryGain.gain.value = 1.0;
        this.reverbWetGain = ctx.createGain();
        this.reverbWetGain.gain.value = 0;

        // Master mix bus (collects dry + reverb + echo before spatial processing)
        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = 1.0;

        // Wire the graph:
        // source → (dry path + reverb wet path + echo) → masterGain → gainNode → pannerNode → destination
        //
        // Spatial processing (gain + pan) is LAST so it affects everything:
        // the dry voice, reverb tail, and echo repeats all get distance/direction attenuation.

        // Source → dry path
        // (source connects to reverbDryGain in playChunk)

        // Source → reverb wet path
        // (source connects to reverbWetGain in playChunk)
        this.reverbWetGain.connect(this.reverbNode);
        this.reverbNode.connect(this.masterGain);

        // Source → echo feedback loop
        // (source connects to echoDelayNode in playChunk)
        this.echoDelayNode.connect(this.echoFeedbackGain);
        this.echoFeedbackGain.connect(this.masterGain);
        this.echoFeedbackGain.connect(this.echoDelayNode); // Feedback loop

        // Dry path → master
        this.reverbDryGain.connect(this.masterGain);

        // Master → spatial gain → spatial pan → speakers
        this.masterGain.connect(this.gainNode);
        this.gainNode.connect(this.pannerNode);
        this.pannerNode.connect(ctx.destination);

        // Generate default reverb impulse
        this.updateReverbImpulse(50);

        // Re-apply settings that were set before the graph was built
        if (this.lastSettings) {
            this.applySettings(this.lastSettings);
        }
    }

    /** Generate a synthetic cave-like impulse response */
    private updateReverbImpulse(decayPercent: number): void {
        const ctx = this.ctx;
        if (!ctx || !this.reverbNode) return;

        const sampleRate = ctx.sampleRate;
        // Map decay 0-100 to 0.3-3.0 seconds
        const duration = 0.3 + (decayPercent / 100) * 2.7;
        const length = Math.floor(sampleRate * duration);
        const impulse = ctx.createBuffer(2, length, sampleRate);

        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                // Exponential decay noise — cave-like character
                const t = i / sampleRate;
                const decay = Math.exp(-t * (4 + (1 - decayPercent / 100) * 8));
                data[i] = (Math.random() * 2 - 1) * decay;
            }
        }

        this.reverbNode.buffer = impulse;
    }

    /** Apply settings from McSettings */
    applySettings(settings: McSettings): void {
        // Store for re-application after lazy graph init
        this.lastSettings = { ...settings };

        this.spatialEnabled = settings.enableSpatialAudio;
        this.nearDistance = settings.spatialNearDistance;
        this.maxDistance = settings.spatialMaxDistance;

        // Reverb
        if (this.reverbWetGain && this.reverbDryGain) {
            if (settings.enableReverb) {
                const wet = settings.reverbAmount / 100;
                this.reverbWetGain.gain.value = wet;
                this.reverbDryGain.gain.value = 1 - wet * 0.5; // Keep some dry signal
            } else {
                this.reverbWetGain.gain.value = 0;
                this.reverbDryGain.gain.value = 1;
            }
        }

        // Update reverb impulse when decay changes
        if (settings.enableReverb) {
            this.updateReverbImpulse(settings.reverbDecay);
        }

        // Echo
        if (this.echoDelayNode && this.echoFeedbackGain) {
            if (settings.enableEcho) {
                this.echoDelayNode.delayTime.value = settings.echoDelay / 1000;
                this.echoFeedbackGain.gain.value = settings.echoDecay / 100 * 0.7; // Cap at 0.7 to prevent runaway
            } else {
                this.echoFeedbackGain.gain.value = 0;
            }
        }

        // If spatial is disabled, reset gain and pan
        if (!this.spatialEnabled) {
            if (this.gainNode) this.gainNode.gain.value = 1;
            if (this.pannerNode) this.pannerNode.pan.value = 0;
        } else {
            // Re-apply last known position
            if (this.lastPosition) {
                this.updatePosition(this.lastPosition);
            }
        }
    }

    /** Update spatial position — called on every position tick from main process */
    updatePosition(data: SpatialPosition): void {
        this.lastPosition = data;
        if (!this.spatialEnabled || !this.gainNode || !this.pannerNode) return;

        // 3D distance (includes height — flying/digging affects volume)
        const dx = data.botX - data.playerX;
        const dy = data.botY - data.playerY;
        const dz = data.botZ - data.playerZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Volume attenuation: full within nearDistance, linear fade to 0 at maxDistance
        let volume: number;
        if (distance <= this.nearDistance) {
            volume = 1;
        } else if (distance >= this.maxDistance) {
            volume = 0;
        } else {
            volume = 1 - (distance - this.nearDistance) / (this.maxDistance - this.nearDistance);
        }

        // Stereo panning: calculate relative angle from player's perspective
        // Mineflayer entity.yaw is 180° offset from the look direction in atan2 space
        const angleToBot = Math.atan2(dx, dz);
        const relativeAngle = angleToBot - (data.playerYaw + Math.PI);

        // Front/back attenuation: reduce volume when the bot is behind the player
        // cos(0) = 1 (in front), cos(π) = -1 (behind)
        // Map to 0.3–1.0 range so it never goes fully silent from facing alone
        const facingFactor = 0.3 + 0.7 * ((1 + Math.cos(relativeAngle)) / 2);
        const now = this.ctx?.currentTime ?? 0;
        // Smooth 50ms ramp — fast enough to feel instant, slow enough to avoid clicks
        this.gainNode.gain.setTargetAtTime(volume * facingFactor, now, 0.05);

        // Map to pan: sin gives -1 (left) to +1 (right)
        const pan = Math.max(-1, Math.min(1, Math.sin(relativeAngle)));
        this.pannerNode.pan.setTargetAtTime(pan, now, 0.05);
    }

    /**
     * Play an audio chunk through the spatial effects chain.
     * Returns a promise that resolves with duration when playback starts.
     */
    async playChunk(dataUrl: string): Promise<{ duration: number; onEnded: Promise<void> }> {
        const ctx = this.ensureContext();

        // Resume suspended context (browser autoplay policy)
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }

        // Decode audio data
        const response = await fetch(dataUrl);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        // Create source node — fan out to all effect paths
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.reverbDryGain!);   // Dry path
        source.connect(this.reverbWetGain!);   // Reverb wet path
        source.connect(this.echoDelayNode!);   // Echo path
        this.currentSource = source;

        // Track when playback ends
        const onEnded = new Promise<void>((resolve) => {
            source.addEventListener('ended', () => {
                if (this.currentSource === source) {
                    this.currentSource = null;
                }
                resolve();
            });
        });

        source.start(0);

        return {
            duration: Math.round(audioBuffer.duration * 1000),
            onEnded,
        };
    }

    /** Immediately stop current playback */
    stop(): void {
        if (this.currentSource) {
            try {
                this.currentSource.stop();
            } catch {
                // Already stopped
            }
            this.currentSource = null;
        }
    }

    /** Play a short test tone through the effects chain (for settings preview) */
    async playTestVoice(): Promise<void> {
        const ctx = this.ensureContext();
        if (ctx.state === 'suspended') {
            await ctx.resume();
        }

        // Generate a short synthetic "voice-like" tone (300ms)
        const sampleRate = ctx.sampleRate;
        const duration = 0.4;
        const length = Math.floor(sampleRate * duration);
        const buffer = ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);

        // Mix a few harmonics to sound vaguely voice-like
        const baseFreq = 150; // ~male voice fundamental
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-t * 4) * (1 - Math.exp(-t * 50)); // Attack + decay
            data[i] =
                envelope *
                0.3 *
                (Math.sin(2 * Math.PI * baseFreq * t) +
                    0.5 * Math.sin(2 * Math.PI * baseFreq * 2 * t) +
                    0.3 * Math.sin(2 * Math.PI * baseFreq * 3 * t) +
                    0.1 * Math.sin(2 * Math.PI * baseFreq * 5 * t));
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.reverbDryGain!);   // Dry path
        source.connect(this.reverbWetGain!);   // Reverb wet path
        source.connect(this.echoDelayNode!);   // Echo path

        return new Promise<void>((resolve) => {
            source.addEventListener('ended', () => resolve());
            source.start(0);
        });
    }

    /** Clean up resources */
    dispose(): void {
        this.stop();
        if (this.ctx) {
            void this.ctx.close();
            this.ctx = null;
        }
    }
}
