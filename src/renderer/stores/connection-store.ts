import { createStore } from 'solid-js/store';
import { onCleanup, onMount } from 'solid-js';
import type {
    BotStatus,
    CharacterInfo,
    VoxtaConnectConfig,
    VoxtaInfo,
} from '../../shared/ipc-types';

// ---- Connection / Status ----

const [status, setStatus] = createStore<BotStatus>({
    mc: 'disconnected',
    mc2: 'disconnected',
    voxta: 'disconnected',
    position: null,
    health: null,
    food: null,
    position2: null,
    health2: null,
    food2: null,
    currentAction: null,
    assistantName: null,
    assistantName2: null,
    sessionId: null,
    paused: false,
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

// ---- Voxta Info (Phase 1 result) ----

const [voxtaInfo, setVoxtaInfo] = createStore<{
    userName: string | null;
    characters: CharacterInfo[];
    defaultAssistantId: string | null;
}>({
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
    // Auto-refresh to fetch full character details (hasMcConfig) in the background
    void refreshCharacters();
    return info;
}

export async function refreshCharacters(): Promise<VoxtaInfo> {
    const info = await window.api.refreshCharacters();
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

/** End the current chat/MC session but keep the Voxta connection alive */
export async function stopSession(): Promise<void> {
    await window.api.stopSession();
}
