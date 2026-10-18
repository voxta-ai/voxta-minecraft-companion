import { createSignal, For, Show, onMount, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';

interface DeviceOption {
    /** null = follow the system default device */
    id: string | null;
    label: string;
}

async function listDevices(kind: MediaDeviceKind): Promise<DeviceOption[]> {
    let devices = await navigator.mediaDevices.enumerateDevices();
    // Device labels stay empty until the page has had microphone access once
    if (devices.some((d) => d.kind === kind && !d.label)) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            // Keep the unlabeled list
        }
    }
    const matching = devices.filter((d) => d.kind === kind);
    // Chromium adds "default" and "communications" aliases; the default one becomes our
    // "follow the system" entry, the communications alias would only duplicate a device.
    const systemDefault = matching.find((d) => d.deviceId === 'default');
    const physical = matching.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
    return [
        { id: null, label: systemDefault?.label || 'System default' },
        // Chromium appends the USB vendor:product id to some labels, e.g. "(046d:0ab7)"
        ...physical.map((d, i) => ({
            id: d.deviceId,
            label: d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '') || `Device ${i + 1}`,
        })),
    ];
}

interface AudioDeviceMenuProps {
    kind: 'audioinput' | 'audiooutput';
    title: string;
    selectedId: Accessor<string | null>;
    onSelect: (id: string | null) => void;
    onClose: () => void;
}

/** Popup listing microphones or speakers, opened by right-clicking the mic or speaker button. */
export default function AudioDeviceMenu(props: AudioDeviceMenuProps) {
    const [options, setOptions] = createSignal<DeviceOption[]>([]);
    let menuRef: HTMLDivElement | undefined;

    const refresh = (): void => {
        void listDevices(props.kind).then(setOptions);
    };

    // A chosen device that has been unplugged falls back to the system default
    const isSelected = (option: DeviceOption): boolean => {
        const chosen = props.selectedId();
        if (option.id === null) return chosen === null || !options().some((o) => o.id === chosen);
        return option.id === chosen;
    };

    onMount(() => {
        refresh();
        const onPointerDown = (e: PointerEvent): void => {
            if (menuRef && e.target instanceof Node && !menuRef.contains(e.target)) props.onClose();
        };
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') props.onClose();
        };
        navigator.mediaDevices.addEventListener('devicechange', refresh);
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        onCleanup(() => {
            navigator.mediaDevices.removeEventListener('devicechange', refresh);
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        });
    });

    return (
        <div class="audio-device-menu" ref={(el) => (menuRef = el)} role="menu">
            <div class="audio-device-menu-title">{props.title}</div>
            <For each={options()}>
                {(option) => (
                    <button
                        type="button"
                        class="audio-device-menu-item"
                        role="menuitemradio"
                        aria-checked={isSelected(option)}
                        onClick={() => {
                            props.onSelect(option.id);
                            props.onClose();
                        }}
                    >
                        <span class="audio-device-menu-label">{option.label}</span>
                        <Show when={isSelected(option)}>
                            <i class="bi bi-check2" />
                        </Show>
                    </button>
                )}
            </For>
        </div>
    );
}
