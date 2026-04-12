import { createSignal, createEffect, createMemo, Show, For } from 'solid-js';
import type { ChatListItem, ScenarioInfo } from '../../shared/ipc-types';
import CustomDropdown from './CustomDropdown';

interface ChatListProps {
    characterId: () => string | null;
    isVoxtaConnected: () => boolean;
    scenarios: () => ScenarioInfo[];
    loadingScenarios: () => boolean;
    selectedScenarioId: () => string | null;
    setSelectedScenarioId: (id: string | null) => void;
    selectedChatId: () => string | null;
    setSelectedChatId: (id: string | null) => void;
    mcOnly: () => boolean;
}

export default function ChatList(props: ChatListProps) {
    const [previousChats, setPreviousChats] = createSignal<ChatListItem[]>([]);
    const [loadingChats, setLoadingChats] = createSignal(false);

    const displayScenarios = createMemo(() => {
        const all = props.scenarios();
        if (!props.mcOnly()) return all;
        return all.filter((s) => s.client === 'Voxta.Minecraft');
    });

    const filteredChats = createMemo((): ChatListItem[] => {
        const scenarioId = props.selectedScenarioId();
        const chats = previousChats();
        if (!scenarioId) return chats;
        return chats.filter((c) => c.scenarioId === scenarioId);
    });

    const refreshChats = () => {
        const charId = props.characterId();
        if (!charId) return;
        setLoadingChats(true);
        window.api
            .loadChats(charId)
            .then((chats) => setPreviousChats(chats))
            .catch((err) => console.error('[UI] Failed to load chats:', err))
            .finally(() => setLoadingChats(false));
    };

    // Reload chats when the character changes
    createEffect(() => {
        const charId = props.characterId();
        if (charId && props.isVoxtaConnected()) {
            props.setSelectedScenarioId(null);
            props.setSelectedChatId(null);
            setPreviousChats([]);
            refreshChats();
        }
    });

    const handleFavorite = async (e: MouseEvent, chatId: string, currentFav: boolean) => {
        e.stopPropagation();
        await window.api.favoriteChat(chatId, !currentFav);
        refreshChats();
    };

    const handleDelete = async (e: MouseEvent, chatId: string) => {
        e.stopPropagation();
        await window.api.deleteChat(chatId);
        if (props.selectedChatId() === chatId) props.setSelectedChatId(null);
        refreshChats();
    };

    return (
        <>
            {/* Scenario Selection */}
            <div class="field full-width">
                <label>Scenario</label>
                <Show when={props.loadingScenarios()}>
                    <span class="field-hint">Loading scenarios...</span>
                </Show>
                <Show when={!props.loadingScenarios()}>
                    <CustomDropdown
                        options={[
                            { value: '', label: "None (Use Character's Scenario)" },
                            ...displayScenarios().map((s) => ({
                                value: s.id,
                                label: `${s.client === 'Voxta.Minecraft' ? '⛏️ ' : ''}${s.name}`,
                            })),
                        ]}
                        value={props.selectedScenarioId() ?? ''}
                        onChange={(val) => {
                            props.setSelectedScenarioId(val || null);
                            props.setSelectedChatId(null);
                        }}
                        placeholder="Select a scenario..."
                    />
                    <span class="field-hint">
                        Override the character's default scenario (e.g. custom Minecraft rules)
                    </span>
                </Show>
            </div>

            {/* Chat Selection */}
            <div class="field full-width">
                <label>Chat</label>
                <Show when={loadingChats()}>
                    <span class="field-hint">Loading chats...</span>
                </Show>
                <Show when={!loadingChats()}>
                    <div class="chat-list">
                        <div
                            class={`chat-list-item chat-list-new ${props.selectedChatId() === null ? 'selected' : ''}`}
                            onClick={() => props.setSelectedChatId(null)}
                        >
                            <span class="chat-list-icon">✨</span>
                            <span class="chat-list-label">New Chat</span>
                        </div>
                        <For each={filteredChats()}>
                            {(chat, index) => {
                                const sessionNumber = filteredChats().length - index();
                                const displayName = chat.title ?? `Session #${sessionNumber}`;
                                return (
                                    <div
                                        class={`chat-list-item ${props.selectedChatId() === chat.id ? 'selected' : ''}`}
                                        onClick={() => props.setSelectedChatId(chat.id)}
                                        title={`Created: ${chat.created}`}
                                    >
                                        <span class="chat-list-icon">{chat.favorite ? '⭐' : '💬'}</span>
                                        <div class="chat-list-info">
                                            <span class="chat-list-label">{displayName}</span>
                                            <span class="chat-list-meta">
                                                {chat.lastSession ?? chat.created}
                                            </span>
                                        </div>
                                        <div class="chat-list-actions">
                                            <span
                                                class="chat-action-btn"
                                                onClick={(e) => handleFavorite(e, chat.id, chat.favorite)}
                                                title={chat.favorite ? 'Unfavorite' : 'Favorite'}
                                            >
                                                {chat.favorite ? '★' : '☆'}
                                            </span>
                                            <span
                                                class="chat-action-btn chat-action-delete"
                                                onClick={(e) => handleDelete(e, chat.id)}
                                                title="Delete chat"
                                            >
                                                🗑
                                            </span>
                                        </div>
                                    </div>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </div>
        </>
    );
}
