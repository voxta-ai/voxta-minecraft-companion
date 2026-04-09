import { createMemo } from 'solid-js';
import {
    micStatus,
    micMuted,
    setMicMuted,
    speakerStatus,
    speakerMuted,
    setSpeakerMuted,
} from '../stores/audio-store';

/**
 * Mic + Speaker toggle buttons for the chat input bar.
 *
 * Mic states:
 *   disabled  — user muted the mic (gray, mute icon)
 *   paused    — bot speaking / server stopped recording (amber, outline icon)
 *   listening — ready, waiting for speech (soft blue, filled icon)
 *   active    — user speaking, audio being captured (bright cyan, pulse animation)
 */
export default function AudioIcons() {
    // ---- Mic icon logic ----
    const micIconClass = createMemo(() => {
        if (micMuted()) return 'bi-mic-mute-fill';
        switch (micStatus()) {
            case 'active':
                return 'bi-mic-fill';
            case 'listening':
                return 'bi-mic-fill';
            case 'paused':
                return 'bi-mic';
            default:
                return 'bi-mic-mute';
        }
    });

    const micColorClass = createMemo(() => {
        if (micMuted()) return 'audio-icon-disabled';
        switch (micStatus()) {
            case 'active':
                return 'audio-icon-speaking';
            case 'listening':
                return 'audio-icon-listening';
            case 'paused':
                return 'audio-icon-paused';
            default:
                return 'audio-icon-disabled';
        }
    });

    const micTitle = createMemo(() => {
        if (micMuted()) return 'Microphone disabled (click to enable)';
        switch (micStatus()) {
            case 'active':
                return 'Speaking... (click to disable)';
            case 'listening':
                return 'Listening for speech (click to disable)';
            case 'paused':
                return 'Microphone paused — waiting for bot (click to disable)';
            default:
                return 'Microphone off';
        }
    });

    // ---- Speaker icon logic ----
    const speakerIconClass = createMemo(() => {
        if (speakerMuted()) return 'bi-volume-mute-fill';
        switch (speakerStatus()) {
            case 'playing':
                return 'bi-volume-up-fill';
            default:
                return 'bi-volume-down';
        }
    });

    const speakerColorClass = createMemo(() => {
        if (speakerMuted()) return 'audio-icon-disabled';
        switch (speakerStatus()) {
            case 'playing':
                return 'audio-icon-playing';
            default:
                return 'audio-icon-paused';
        }
    });

    const speakerTitle = createMemo(() => {
        if (speakerMuted()) return 'Speaker disabled (click to enable)';
        switch (speakerStatus()) {
            case 'playing':
                return 'Playing audio... (click to disable)';
            default:
                return 'Speaker on (click to disable)';
        }
    });

    return (
        <div class="audio-icons">
            <button
                class={`audio-icon-btn ${micColorClass()}`}
                onClick={() => setMicMuted(!micMuted())}
                title={micTitle()}
                type="button"
            >
                <i class={`bi ${micIconClass()}`} />
            </button>
            <button
                class={`audio-icon-btn ${speakerColorClass()}`}
                onClick={() => setSpeakerMuted(!speakerMuted())}
                title={speakerTitle()}
                type="button"
            >
                <i class={`bi ${speakerIconClass()}`} />
            </button>
        </div>
    );
}
