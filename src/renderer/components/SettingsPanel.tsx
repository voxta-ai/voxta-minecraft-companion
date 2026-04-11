import { createSignal, For, Show } from 'solid-js';
import type { McSettings, VisionMode, ActionInferenceTiming } from '../../shared/ipc-types';
import { settings, updateSetting } from '../stores/settings-store';
import { SettingCard } from './SettingCard';

interface ToggleItem {
    key: keyof McSettings;
    label: string;
    description: string;
}

interface SliderItem {
    key: keyof McSettings;
    label: string;
    description: string;
}

// ── Toggle data ──────────────────────────────────────────────

const EVENT_TOGGLES: ToggleItem[] = [
    { key: 'enableEventDamage', label: 'Damage Taken', description: 'Tells the AI when you take damage' },
    { key: 'enableEventDeath', label: 'Death', description: 'Notifies the AI when you die and respawn' },
    {
        key: 'enableEventUnderAttack',
        label: 'Under Attack',
        description: 'Alerts the AI when a hostile mob targets you',
    },
    {
        key: 'enableEventPlayerNearby',
        label: 'Player Nearby',
        description: 'Notifies the AI when a player enters range',
    },
    { key: 'enableEventMobNearby', label: 'Mob Nearby', description: 'Reports nearby hostile or notable mobs' },
];

const NOTE_TOGGLES: ToggleItem[] = [
    { key: 'enableNoteItemPickup', label: 'Item Pickup', description: 'Silently logs picked up items for AI context' },
    { key: 'enableNoteWeather', label: 'Weather Change', description: 'Silently logs rain/thunder changes' },
    { key: 'enableNoteTime', label: 'Time Change', description: 'Silently logs dawn/dusk transitions' },
    { key: 'enableNoteChat', label: 'Chat Messages', description: 'Forwards in-game chat to the AI' },
];

const BEHAVIOR_TOGGLES: ToggleItem[] = [
    {
        key: 'enableBotChatEcho',
        label: 'Echo Replies to MC Chat',
        description: 'Bot types its replies into Minecraft chat',
    },
    { key: 'enableAutoLook', label: 'Auto-Look at Nearby Player', description: 'Bot turns to face the nearest player' },
    {
        key: 'enableAutoDefense',
        label: 'Auto-Defend Against Mobs',
        description: 'Bot attacks hostile mobs automatically',
    },
];

const VOICE_CHANCE_SLIDERS: SliderItem[] = [
    { key: 'voiceChanceMovement', label: 'Movement', description: 'Chance the bot speaks during movement actions' },
    { key: 'voiceChanceSurvival', label: 'Survival', description: 'Chance the bot speaks during survival actions' },
    { key: 'voiceChanceCombat', label: 'Combat', description: 'Chance the bot speaks during combat' },
    { key: 'voiceChanceInteraction', label: 'Interaction', description: 'Chance the bot speaks during interactions' },
];

// ── Reusable card components ─────────────────────────────────

function ToggleCard(props: { item: ToggleItem }) {
    return (
        <SettingCard name={props.item.label} description={props.item.description}>
            <label class="toggle">
                <input
                    type="checkbox"
                    checked={settings[props.item.key] as boolean}
                    onChange={(e) => updateSetting(props.item.key, e.currentTarget.checked)}
                />
                <span class="toggle-slider" />
            </label>
        </SettingCard>
    );
}

function SliderCard(props: { item: SliderItem }) {
    return (
        <SettingCard name={props.item.label} description={props.item.description}>
            <div class="slider-control">
                <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={settings[props.item.key] as number}
                    onInput={(e) => updateSetting(props.item.key, parseInt(e.currentTarget.value, 10))}
                />
                <span class="slider-value">{settings[props.item.key] as number}%</span>
            </div>
        </SettingCard>
    );
}

// ── Section groups ───────────────────────────────────────────

interface ToggleGroupProps {
    title: string;
    items: ToggleItem[];
}

function ToggleGroup(props: ToggleGroupProps) {
    return (
        <div class="action-category">
            <div class="action-category-title">{props.title}</div>
            <div class="setting-card-list">
                <For each={props.items}>{(item) => <ToggleCard item={item} />}</For>
            </div>
        </div>
    );
}

interface SliderGroupProps {
    title: string;
    items: SliderItem[];
}

function SliderGroup(props: SliderGroupProps) {
    return (
        <div class="action-category">
            <div class="action-category-title">{props.title}</div>
            <div class="setting-card-list">
                <For each={props.items}>{(item) => <SliderCard item={item} />}</For>
            </div>
        </div>
    );
}

// ── Vision mode selector ─────────────────────────────────────

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

    const visionHint = () => {
        switch (settings.visionMode) {
            case 'screen':
                return 'Captures your Minecraft window — shares what you see to enrich AI context';
            case 'eyes':
                return 'Requires a second MC instance spectating the bot — sees through the bot\'s eyes';
            default:
                return 'Vision is disabled — no visual context is sent to the AI';
        }
    };

    return (
        <div class="action-category">
            <div class="action-category-title">👁️ Vision</div>
            <div class="setting-card setting-card-column">
                <div class="setting-card-name">Vision Mode</div>
                <select
                    class="vision-select"
                    value={settings.visionMode}
                    onChange={(e) => updateSetting('visionMode', e.currentTarget.value as VisionMode)}
                >
                    <For each={VISION_OPTIONS}>
                        {(opt) => (
                            <option value={opt.value}>
                                {opt.label}
                            </option>
                        )}
                    </For>
                </select>
                <span class="field-hint">{visionHint()}</span>
            </div>
            <Show when={settings.visionMode === 'eyes'}>
                <SettingCard name="Target Window" description="Select which Minecraft window to capture">
                    <button class="btn-switch-window" onClick={handleCycleWindow}>
                        Switch Window
                    </button>
                </SettingCard>
                <Show when={switchResult()}>
                    <div class="vision-window-info">{switchResult()}</div>
                </Show>
            </Show>
        </div>
    );
}

// ── Audio effects section ────────────────────────────────────

function AudioEffects() {
    const [testing, setTesting] = createSignal(false);
    // Lazy-init a dedicated engine for test previews
    let testEngine: import('../services/SpatialAudioEngine').SpatialAudioEngine | null = null;

    const getTestEngine = async (): Promise<import('../services/SpatialAudioEngine').SpatialAudioEngine> => {
        if (!testEngine) {
            const { SpatialAudioEngine } = await import('../services/SpatialAudioEngine');
            testEngine = new SpatialAudioEngine();
        }
        testEngine.applySettings(settings);
        return testEngine;
    };

    const handleTestVoice = async (): Promise<void> => {
        setTesting(true);
        try {
            const engine = await getTestEngine();
            await engine.playTestVoice();
        } catch (err) {
            console.error('[Audio] Test voice failed:', err);
        } finally {
            setTesting(false);
        }
    };

    return (
        <div class="action-category">
            <div class="action-category-title">🔊 Audio Effects</div>

            {/* Spatial Audio */}
            <SettingCard name="Spatial Audio" description="Distance-based volume and stereo panning — use headphones">
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={settings.enableSpatialAudio}
                        onChange={(e) => updateSetting('enableSpatialAudio', e.currentTarget.checked)}
                    />
                    <span class="toggle-slider" />
                </label>
            </SettingCard>
            <Show when={settings.enableSpatialAudio}>
                <SettingCard name="Near Distance" description="Full volume within this range (blocks)">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="1"
                            max="16"
                            step="1"
                            value={settings.spatialNearDistance}
                            onInput={(e) => updateSetting('spatialNearDistance', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.spatialNearDistance}</span>
                    </div>
                </SettingCard>
                <SettingCard name="Max Distance" description="Silent beyond this range (blocks)">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="8"
                            max="64"
                            step="2"
                            value={settings.spatialMaxDistance}
                            onInput={(e) => updateSetting('spatialMaxDistance', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.spatialMaxDistance}</span>
                    </div>
                </SettingCard>
            </Show>

            {/* Reverb */}
            <SettingCard name="Reverb" description="Cave-like echo ambience">
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={settings.enableReverb}
                        onChange={(e) => updateSetting('enableReverb', e.currentTarget.checked)}
                    />
                    <span class="toggle-slider" />
                </label>
            </SettingCard>
            <Show when={settings.enableReverb}>
                <SettingCard name="Amount" description="Wet/dry mix">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={settings.reverbAmount}
                            onInput={(e) => updateSetting('reverbAmount', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.reverbAmount}%</span>
                    </div>
                </SettingCard>
                <SettingCard name="Decay" description="How long the reverb tail lasts">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={settings.reverbDecay}
                            onInput={(e) => updateSetting('reverbDecay', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.reverbDecay}%</span>
                    </div>
                </SettingCard>
            </Show>

            {/* Echo */}
            <SettingCard name="Echo" description="Delayed voice repetition">
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={settings.enableEcho}
                        onChange={(e) => updateSetting('enableEcho', e.currentTarget.checked)}
                    />
                    <span class="toggle-slider" />
                </label>
            </SettingCard>
            <Show when={settings.enableEcho}>
                <SettingCard name="Delay" description="Time between echoes">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="100"
                            max="500"
                            step="25"
                            value={settings.echoDelay}
                            onInput={(e) => updateSetting('echoDelay', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.echoDelay}ms</span>
                    </div>
                </SettingCard>
                <SettingCard name="Feedback" description="How many times the echo repeats">
                    <div class="slider-control">
                        <input
                            type="range"
                            min="0"
                            max="100"
                            step="5"
                            value={settings.echoDecay}
                            onInput={(e) => updateSetting('echoDecay', parseInt(e.currentTarget.value, 10))}
                        />
                        <span class="slider-value">{settings.echoDecay}%</span>
                    </div>
                </SettingCard>
            </Show>

            {/* Test button */}
            <SettingCard name="Preview" description="Play a test tone through the effects chain">
                <button
                    class="btn-test-voice"
                    disabled={testing()}
                    onClick={handleTestVoice}
                >
                    {testing() ? '...' : '🔊 Test'}
                </button>
            </SettingCard>
        </div>
    );
}

// ── Main settings panel ──────────────────────────────────────

export default function SettingsPanel() {
    return (
        <div class="action-toggles">
            <ToggleGroup title="📡 Events" items={EVENT_TOGGLES} />
            <ToggleGroup title="📋 Notes" items={NOTE_TOGGLES} />
            <SliderGroup title="🎲 Voice Chance" items={VOICE_CHANCE_SLIDERS} />
            <ToggleGroup title="🤖 Bot Behavior" items={BEHAVIOR_TOGGLES} />
            <div class="action-category">
                <div class="action-category-title">🧠 Action Inference</div>
                <div class="setting-card setting-card-column">
                    <div class="setting-card-name">Timing</div>
                    <select
                        class="vision-select"
                        value={settings.actionInferenceTiming}
                        onChange={(e) =>
                            updateSetting('actionInferenceTiming', e.currentTarget.value as ActionInferenceTiming)
                        }
                    >
                        <option value="user">On user message</option>
                        <option value="afterChar">After character reply</option>
                    </select>
                    <span class="field-hint">
                        {settings.actionInferenceTiming === 'user'
                            ? 'More precise actions, but slower — AI decides the action before replying'
                            : 'Faster replies — AI speaks first, then picks an action (recommended)'}
                    </span>
                </div>
            </div>
            <VisionModeSelector />
            <AudioEffects />
        </div>
    );
}
