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
 * Mirrors voxta-talk's RecordingIcon.tsx visual states using Bootstrap Icons.
 */
export default function AudioIcons() {
    // ---- Mic icon logic ----
    const micIconClass = createMemo(() => {
        if (micMuted()) return 'bi-mic-mute';
        switch (micStatus()) {
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
            case 'listening':
                return 'audio-icon-active';
            case 'paused':
                return 'audio-icon-on';
            default:
                return 'audio-icon-disabled';
        }
    });

    const micTitle = createMemo(() => {
        if (micMuted()) return 'Microphone muted (click to unmute)';
        switch (micStatus()) {
            case 'listening':
                return 'Listening... (click to mute)';
            case 'paused':
                return 'Microphone paused (click to mute)';
            default:
                return 'Microphone off';
        }
    });

    // ---- Speaker icon logic ----
    const speakerIconClass = createMemo(() => {
        if (speakerMuted()) return 'bi-volume-mute';
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
                return 'audio-icon-active';
            default:
                return 'audio-icon-on';
        }
    });

    const speakerTitle = createMemo(() => {
        if (speakerMuted()) return 'Speaker muted (click to unmute)';
        switch (speakerStatus()) {
            case 'playing':
                return 'Playing audio... (click to mute)';
            default:
                return 'Speaker on (click to mute)';
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
