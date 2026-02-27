import { For } from 'solid-js';
import type { McSettings } from '../../shared/ipc-types';
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
                                checked={settings[item.key]}
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
    { key: 'enableVision', label: 'vision (capture MC screen)' },
];

export default function SettingsPanel() {
    return (
        <div class="action-toggles">
            <ToggleGroup title="📡 Events" items={EVENT_TOGGLES} />
            <ToggleGroup title="📊 Telemetry" items={TELEMETRY_TOGGLES} />
            <ToggleGroup title="🤖 Bot Behavior" items={BEHAVIOR_TOGGLES} />
        </div>
    );
}
