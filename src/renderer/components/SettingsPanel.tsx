import { createSignal, For, Show } from 'solid-js';
import type { McSettings, VisionMode, ActionInferenceTiming } from '../../shared/ipc-types';
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

const NOTE_TOGGLES: ToggleItem[] = [
    { key: 'enableNoteItemPickup', label: 'item pickup' },
    { key: 'enableNoteWeather', label: 'weather change' },
    { key: 'enableNoteTime', label: 'time change' },
    { key: 'enableNoteChat', label: 'chat messages' },
];

interface SliderItem {
    key: keyof McSettings;
    label: string;
}

const VOICE_CHANCE_SLIDERS: SliderItem[] = [
    { key: 'voiceChanceMovement', label: 'movement' },
    { key: 'voiceChanceSurvival', label: 'survival' },
    { key: 'voiceChanceCombat', label: 'combat' },
    { key: 'voiceChanceInteraction', label: 'interaction' },
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

interface SliderGroupProps {
    title: string;
    items: SliderItem[];
}

function SliderGroup(props: SliderGroupProps) {
    return (
        <div class="action-category">
            <div class="action-category-title">{props.title}</div>
            <For each={props.items}>
                {(item) => (
                    <div class="action-item">
                        <label>{item.label}</label>
                        <div class="slider-control">
                            <input
                                type="range"
                                min="0"
                                max="100"
                                step="5"
                                value={settings[item.key] as number}
                                onInput={(e) => updateSetting(item.key, parseInt(e.currentTarget.value, 10))}
                            />
                            <span class="slider-value">{settings[item.key] as number}%</span>
                        </div>
                    </div>
                )}
            </For>
        </div>
    );
}

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
            <ToggleGroup title="📋 Notes" items={NOTE_TOGGLES} />
            <SliderGroup title="🎲 Voice Chance" items={VOICE_CHANCE_SLIDERS} />
            <ToggleGroup title="🤖 Bot Behavior" items={BEHAVIOR_TOGGLES} />
            <div class="action-category">
                <div class="action-category-title">🧠 Action Inference</div>
                <div class="action-item">
                    <label>timing</label>
                    <select
                        class="vision-select"
                        value={settings.actionInferenceTiming}
                        onChange={(e) => updateSetting('actionInferenceTiming', e.currentTarget.value as ActionInferenceTiming)}
                    >
                        <option value="user">On user message</option>
                        <option value="afterChar">After character reply</option>
                    </select>
                </div>
            </div>
            <VisionModeSelector />
        </div>
    );
}
