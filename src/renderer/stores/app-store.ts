import { createStore } from 'solid-js/store';
import { onCleanup, onMount } from 'solid-js';
import type { BotStatus, ChatMessage, ActionToggle } from '../../shared/ipc-types';

// ---- Connection / Status Store ----

const [status, setStatus] = createStore<BotStatus>({
    mc: 'disconnected',
    voxta: 'disconnected',
    position: null,
    health: null,
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

export async function connect(config: Parameters<typeof window.api.connect>[0]): Promise<void> {
    await window.api.connect(config);
}

export async function disconnect(): Promise<void> {
    await window.api.disconnect();
}

// ---- Chat Store ----

const [chatMessages, setChatMessages] = createStore<{ messages: ChatMessage[] }>({
    messages: [],
});

export { chatMessages };

export function useChatListener(): void {
    onMount(() => {
        const cleanup = window.api.onChatMessage((msg) => {
            setChatMessages('messages', (prev) => [...prev, msg]);
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
