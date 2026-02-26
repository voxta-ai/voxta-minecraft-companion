import { For } from 'solid-js';
import type { McSettings } from '../../shared/ipc-types';
import { settings, updateSetting } from '../stores/app-store';

interface ToggleItem {
    key: keyof McSettings;
    label: string;
}

const ACTION_TOGGLES: ToggleItem[] = [
    { key: 'enableFollowPlayer', label: 'follow player' },
    { key: 'enableGoTo', label: 'go to' },
    { key: 'enableLookAt', label: 'look at' },
    { key: 'enableStop', label: 'stop' },
    { key: 'enableMineBlock', label: 'mine block' },
    { key: 'enableAttack', label: 'attack' },
    { key: 'enableSay', label: 'say' },
    { key: 'enableEquip', label: 'equip' },
    { key: 'enableGiveItem', label: 'give item' },
    { key: 'enableCollectItems', label: 'collect items' },
];

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

export default function SettingsPanel() {
    return (
        <div class="action-toggles">
            <ToggleGroup title="⚙️ Actions" items={ACTION_TOGGLES} />
            <ToggleGroup title="📡 Events" items={EVENT_TOGGLES} />
            <ToggleGroup title="📊 Telemetry" items={TELEMETRY_TOGGLES} />
        </div>
    );
}
