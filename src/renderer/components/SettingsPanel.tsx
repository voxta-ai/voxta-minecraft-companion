import { createSignal, For, Show } from 'solid-js';
import type { McSettings, VisionMode } from '../../shared/ipc-types';
import { settings, updateSetting } from '../stores/app-store';

interface ToggleItem {
    key: keyof McSettings;
    label: string;
}

const EVENT_TOGGLES: ToggleItem[] = [
    { key: 'enableEventDamage', label: 'damage taken' },
    { key: 'enableEventDeath', label: 'death' },
    { key: 'enableEventUnderAttack', label: 'under attack' },
    { key: 'enableEventPlayerNearby', label: 'player nearby' },
    { key: 'enableEventMobNearby', label: 'mob nearby' },
];

const TELEMETRY_TOGGLES: ToggleItem[] = [
    { key: 'enableTelemetryItemPickup', label: 'item pickup' },
    { key: 'enableTelemetryActionResults', label: 'action results' },
    { key: 'enableTelemetryWeather', label: 'weather change' },
    { key: 'enableTelemetryTime', label: 'time change' },
    { key: 'enableTelemetryChat', label: 'chat messages' },
];

interface ToggleGroupProps {
    title: string;
    items: ToggleItem[];
}

function ToggleGroup(props: ToggleGroupProps) {
    return (
        <div class="action-category">
            <div class="action-category-title">{props.title}</div>
            <For each={props.items}>
                {(item) => (
                    <div class="action-item">
                        <label>{item.label}</label>
                        <label class="toggle">
                            <input
                                type="checkbox"
                                checked={settings[item.key] as boolean}
                                onChange={(e) => updateSetting(item.key, e.currentTarget.checked)}
                            />
                            <span class="toggle-slider" />
                        </label>
                    </div>
                )}
            </For>
        </div>
    );
}

const BEHAVIOR_TOGGLES: ToggleItem[] = [
    { key: 'enableBotChatEcho', label: 'echo replies to MC chat' },
    { key: 'enableAutoLook', label: 'auto-look at nearby player' },
    { key: 'enableAutoDefense', label: 'auto-defend against mobs' },
];

const VISION_OPTIONS: { value: VisionMode; label: string; description: string }[] = [
    { value: 'off', label: 'Off', description: 'No vision capture' },
    { value: 'screen', label: 'Screen', description: 'Capture your MC window' },
    { value: 'eyes', label: 'Eyes', description: 'Bot POV (spectator client)' },
];

function VisionModeSelector() {
    const [switchResult, setSwitchResult] = createSignal<string | null>(null);

    const handleCycleWindow = async (): Promise<void> => {
        const result = await window.api.cycleVisionWindow();
        setSwitchResult(result ?? 'No Minecraft windows found');
        // Clear the message after 4 seconds
        setTimeout(() => setSwitchResult(null), 4000);
    };

    return (
        <div class="action-category">
            <div class="action-category-title">👁️ Vision</div>
            <div class="action-item">
                <label>vision mode</label>
                <select
                    class="vision-select"
                    value={settings.visionMode}
                    onChange={(e) => updateSetting('visionMode', e.currentTarget.value as VisionMode)}
                >
                    <For each={VISION_OPTIONS}>
                        {(opt) => (
                            <option value={opt.value} title={opt.description}>
                                {opt.label}
                            </option>
                        )}
                    </For>
                </select>
            </div>
            <Show when={settings.visionMode === 'eyes'}>
                <div class="action-item">
                    <label>target window</label>
                    <button class="btn-switch-window" onClick={handleCycleWindow}>
                        Switch Window
                    </button>
                </div>
                <Show when={switchResult()}>
                    <div class="vision-window-info">{switchResult()}</div>
                </Show>
            </Show>
        </div>
    );
}

export default function SettingsPanel() {
    return (
        <div class="action-toggles">
            <ToggleGroup title="📡 Events" items={EVENT_TOGGLES} />
            <ToggleGroup title="📊 Telemetry" items={TELEMETRY_TOGGLES} />
            <ToggleGroup title="🤖 Bot Behavior" items={BEHAVIOR_TOGGLES} />
            <VisionModeSelector />
        </div>
    );
}
