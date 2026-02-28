import { createStore } from 'solid-js/store';
import { onCleanup, onMount } from 'solid-js';
import type { BotStatus, ChatMessage, ActionToggle, CharacterInfo, McSettings, VoxtaConnectConfig, VoxtaInfo } from '../../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../../shared/ipc-types';

// ---- Connection / Status Store ----

const [status, setStatus] = createStore<BotStatus>({
    mc: 'disconnected',
    voxta: 'disconnected',
    position: null,
    health: null,
    food: null,
    currentAction: null,
    assistantName: null,
    sessionId: null,
});

export { status };

export function useStatusListener(): void {
    onMount(() => {
        const cleanup = window.api.onStatusChanged((newStatus) => {
            setStatus(newStatus);
        });
        onCleanup(cleanup);
    });
}

// ---- Voxta Info Store (Phase 1 result) ----

const [voxtaInfo, setVoxtaInfo] = createStore<{ userName: string | null; characters: CharacterInfo[]; defaultAssistantId: string | null }>({
    userName: null,
    characters: [],
    defaultAssistantId: null,
});

export { voxtaInfo };

export async function connectVoxta(config: VoxtaConnectConfig): Promise<VoxtaInfo> {
    const info = await window.api.connectVoxta(config);
    setVoxtaInfo({
        userName: info.userName,
        characters: info.characters,
        defaultAssistantId: info.defaultAssistantId,
    });
    return info;
}

export async function launchBot(config: Parameters<typeof window.api.launchBot>[0]): Promise<void> {
    await window.api.launchBot(config);
}

export async function disconnect(): Promise<void> {
    await window.api.disconnect();
    setVoxtaInfo({ userName: null, characters: [], defaultAssistantId: null });
}

// ---- Chat Store ----

const [chatMessages, setChatMessages] = createStore<{ messages: ChatMessage[] }>({
    messages: [],
});

export { chatMessages };

export function useChatListener(): void {
    onMount(() => {
        const cleanup = window.api.onChatMessage((msg) => {
            setChatMessages('messages', (prev) => {
                const last = prev[prev.length - 1];
                // Collapse consecutive identical messages into a repeat count
                if (last && last.sender === msg.sender && last.text === msg.text) {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                        ...last,
                        repeatCount: (last.repeatCount ?? 1) + 1,
                    };
                    return updated;
                }
                return [...prev, msg];
            });
        });
        onCleanup(cleanup);
    });
}

export async function sendMessage(text: string): Promise<void> {
    await window.api.sendMessage(text);
}

export function clearChat(): void {
    setChatMessages('messages', []);
}

// ---- Action Store ----

const [actions, setActions] = createStore<{ list: ActionToggle[] }>({
    list: [],
});

export { actions };

export async function loadActions(): Promise<void> {
    const result = await window.api.getActions();
    setActions('list', result);
}

export async function toggleAction(name: string, enabled: boolean): Promise<void> {
    await window.api.toggleAction(name, enabled);
    setActions('list', (a) => a.name === name, 'enabled', enabled);
}

// ---- Settings Store ----

const SETTINGS_KEY = 'voxta-mc-settings';

function loadSavedSettings(): McSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
}

const [settings, setSettings] = createStore<McSettings>(loadSavedSettings());

// Sync saved settings to the main process on startup
// (without this, main starts with DEFAULT_SETTINGS until user changes a toggle)
window.api.updateSettings({ ...settings });

export { settings };

export function updateSetting<K extends keyof McSettings>(key: K, value: McSettings[K]): void {
    setSettings(key, value);
    const updated = { ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
    window.api.updateSettings(updated);
}

export function getSettings(): McSettings {
    return { ...settings };
}
