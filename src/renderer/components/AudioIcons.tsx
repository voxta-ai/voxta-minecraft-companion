import { createMemo, createSignal, Show } from 'solid-js';
import AudioDeviceMenu from './AudioDeviceMenu';
import {
    micStatus,
    micMuted,
    setMicMuted,
    micDeviceId,
    setMicDeviceId,
    speakerStatus,
    speakerMuted,
    setSpeakerMuted,
    speakerDeviceId,
    setSpeakerDeviceId,
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
    const [openMenu, setOpenMenu] = createSignal<'mic' | 'speaker' | null>(null);

    // ---- Mic icon logic ----
    const micIconClass = createMemo(() => {
        if (micMuted()) return 'bi-mic-mute-fill';
        switch (micStatus()) {
            case 'active':
            case 'listening':
                return 'bi-mic-fill';
            default:
                // 'paused' or 'off' while not muted — outline mic (not mute icon)
                return 'bi-mic';
        }
    });

    const micColorClass = createMemo(() => {
        if (micMuted()) return 'audio-icon-disabled';
        switch (micStatus()) {
            case 'active':
                return 'audio-icon-speaking';
            case 'listening':
                return 'audio-icon-listening';
            default:
                // 'paused' or 'off' while not muted — show as idle, not disabled
                return 'audio-icon-paused';
        }
    });

    const micTitle = createMemo(() => {
        const state = (() => {
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
        })();
        return `${state}\nRight-click to choose the microphone`;
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
        const state = (() => {
            if (speakerMuted()) return 'Speaker disabled (click to enable)';
            switch (speakerStatus()) {
                case 'playing':
                    return 'Playing audio... (click to disable)';
                default:
                    return 'Speaker on (click to disable)';
            }
        })();
        return `${state}\nRight-click to choose the speaker`;
    });

    return (
        <div class="audio-icons">
            <div class="audio-device-menu-anchor">
                <button
                    class={`audio-icon-btn ${micColorClass()}`}
                    onClick={() => setMicMuted(!micMuted())}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setOpenMenu('mic');
                    }}
                    title={openMenu() ? '' : micTitle()}
                    type="button"
                >
                    <i class={`bi ${micIconClass()}`} />
                </button>
                <Show when={openMenu() === 'mic'}>
                    <AudioDeviceMenu
                        kind="audioinput"
                        title="Microphone"
                        selectedId={micDeviceId}
                        onSelect={setMicDeviceId}
                        onClose={() => setOpenMenu(null)}
                    />
                </Show>
            </div>
            <div class="audio-device-menu-anchor">
                <button
                    class={`audio-icon-btn ${speakerColorClass()}`}
                    onClick={() => setSpeakerMuted(!speakerMuted())}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setOpenMenu('speaker');
                    }}
                    title={openMenu() ? '' : speakerTitle()}
                    type="button"
                >
                    <i class={`bi ${speakerIconClass()}`} />
                </button>
                <Show when={openMenu() === 'speaker'}>
                    <AudioDeviceMenu
                        kind="audiooutput"
                        title="Speaker"
                        selectedId={speakerDeviceId}
                        onSelect={setSpeakerDeviceId}
                        onClose={() => setOpenMenu(null)}
                    />
                </Show>
            </div>
        </div>
    );
}
