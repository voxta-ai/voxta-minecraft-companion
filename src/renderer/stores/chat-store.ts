import { createStore } from 'solid-js/store';
import { onCleanup, onMount } from 'solid-js';
import type { ChatMessage } from '../../shared/ipc-types';

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
        const cleanupClear = window.api.onClearChat(() => {
            setChatMessages('messages', []);
        });
        onCleanup(() => {
            cleanup();
            cleanupClear();
        });
    });
}

export async function sendMessage(text: string): Promise<void> {
    await window.api.sendMessage(text);
}

export function clearChat(): void {
    setChatMessages('messages', []);
}
