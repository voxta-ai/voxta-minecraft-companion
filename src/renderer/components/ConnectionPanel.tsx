import { createSignal, createMemo, Show, For, createEffect } from 'solid-js';
import { status, connectVoxta, launchBot, disconnect, voxtaInfo } from '../stores/app-store';
import type { BotConfig, CharacterInfo, ChatListItem, VoxtaConnectConfig } from '../../shared/ipc-types';
import CustomDropdown from './CustomDropdown';

const STORAGE_KEY = 'voxta-mc-config';

interface SavedConfig {
    mcHost?: string;
    mcPort?: number;
    mcUsername?: string;
    mcVersion?: string;
    playerMcUsername?: string;
    voxtaUrl?: string;
    voxtaApiKey?: string;
    lastCharacterId?: string;
}

function loadSavedConfig(): SavedConfig {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function saveConfig(config: SavedConfig): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

interface ConnectionPanelProps {
    onClose: () => void;
}

export default function ConnectionPanel(props: ConnectionPanelProps) {
    const saved = loadSavedConfig();

    // Phase 1 fields: Voxta connection
    const [voxtaUrl, setVoxtaUrl] = createSignal(saved.voxtaUrl ?? 'http://localhost:5384/hub');
    const [apiKey, setApiKey] = createSignal(saved.voxtaApiKey ?? '');
    const [connectingVoxta, setConnectingVoxta] = createSignal(false);

    // Phase 2 fields: MC connection
    const [mcHost, setMcHost] = createSignal(saved.mcHost ?? 'localhost');
    const [mcPort, setMcPort] = createSignal(String(saved.mcPort ?? 25565));
    const [mcVersion, setMcVersion] = createSignal(saved.mcVersion ?? '');
    const [mcUsername, setMcUsername] = createSignal(saved.mcUsername ?? '');
    const [playerMcName, setPlayerMcName] = createSignal(saved.playerMcUsername ?? '');
    const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);
    const [launching, setLaunching] = createSignal(false);

    // Chat selection
    const [previousChats, setPreviousChats] = createSignal<ChatListItem[]>([]);
    const [loadingChats, setLoadingChats] = createSignal(false);
    const [selectedChatId, setSelectedChatId] = createSignal<string | null>(null);

    // Track whether the user manually edited the name fields
    const [userEditedBotName, setUserEditedBotName] = createSignal(false);
    const [userEditedPlayerName, setUserEditedPlayerName] = createSignal(false);

    const isVoxtaConnected = () => status.voxta === 'connected';
    const isVoxtaConnecting = () => status.voxta === 'connecting' || connectingVoxta();
    const isMcConnected = () => status.mc === 'connected';
    const hasSession = () => status.sessionId !== null;
    const hasCharacters = () => voxtaInfo.characters.length > 0;

    // Track last-chat timestamp per character for sorting
    const [charLastChat, setCharLastChat] = createSignal<Record<string, string>>({});

    // Fetch all chats to build a sort order by the most recent chat
    createEffect(() => {
        if (isVoxtaConnected() && hasCharacters()) {
            const map: Record<string, string> = {};
            const promises = voxtaInfo.characters.map(async (char) => {
                const chats = await window.api.loadChats(char.id);
                if (chats.length > 0) {
                    // Use the sortable timestamp, not the humanized string
                    map[char.id] = chats[0].lastSessionTimestamp ?? '';
                }
            });
            Promise.all(promises)
                .then(() => setCharLastChat(map))
                .catch(() => {
                    /* ignore */
                });
        }
    });

    // Sort characters: favorites/recent chats first
    const sortedCharacters = createMemo((): CharacterInfo[] => {
        const map = charLastChat();
        return [...voxtaInfo.characters].sort((a, b) => {
            const aTime = map[a.id] ?? '';
            const bTime = map[b.id] ?? '';
            // Characters with chats come first, sorted by the most recent
            if (aTime && !bTime) return -1;
            if (!aTime && bTime) return 1;
            if (aTime && bTime) return bTime.localeCompare(aTime);
            return 0;
        });
    });

    // Auto-select: saved character if available, otherwise default assistant
    createEffect(() => {
        if (voxtaInfo.characters.length > 0 && !selectedCharacterId()) {
            const savedId = saved.lastCharacterId;
            const savedExists = savedId && voxtaInfo.characters.some((c) => c.id === savedId);
            setSelectedCharacterId(
                savedExists ? savedId : (voxtaInfo.defaultAssistantId ?? voxtaInfo.characters[0]?.id ?? null),
            );
        }
    });

    // Autofill player name from Voxta user profile (one-time, unless user edited)
    createEffect(() => {
        if (voxtaInfo.userName && !userEditedPlayerName()) {
            setPlayerMcName(voxtaInfo.userName);
        }
    });

    // Autofill the bot name when the character changes (unless user edited)
    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId && !userEditedBotName()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId);
            if (character) {
                setMcUsername(character.name);
            }
        }
    });

    // Load previous chats when the character changes
    const refreshChats = () => {
        const charId = selectedCharacterId();
        if (!charId) return;
        setLoadingChats(true);
        window.api
            .loadChats(charId)
            .then((chats) => {
                setPreviousChats(chats);
            })
            .catch((err) => {
                console.error('[UI] Failed to load chats:', err);
            })
            .finally(() => {
                setLoadingChats(false);
            });
    };

    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId && isVoxtaConnected()) {
            setSelectedChatId(null);
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
        if (selectedChatId() === chatId) setSelectedChatId(null);
        refreshChats();
    };

    const handleConnectVoxta = async () => {
        const config: VoxtaConnectConfig = {
            voxtaUrl: voxtaUrl(),
            voxtaApiKey: apiKey(),
        };
        saveConfig({ ...loadSavedConfig(), voxtaUrl: voxtaUrl(), voxtaApiKey: apiKey() });
        setConnectingVoxta(true);
        try {
            await connectVoxta(config);
        } catch {
            // Error shown in chat via system messages
        } finally {
            setConnectingVoxta(false);
        }
    };

    const handleLaunchBot = async () => {
        const charId = selectedCharacterId();
        if (!charId) return;

        const config: BotConfig = {
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10),
            mcUsername: mcUsername(),
            mcVersion: mcVersion(),
            playerMcUsername: playerMcName(),
            characterId: charId,
            chatId: selectedChatId(),
            perceptionIntervalMs: 3000,
            entityRange: 32,
        };
        saveConfig({
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10),
            mcUsername: mcUsername(),
            mcVersion: mcVersion(),
            playerMcUsername: playerMcName(),
            voxtaUrl: voxtaUrl(),
            voxtaApiKey: apiKey(),
            lastCharacterId: charId,
        });
        setLaunching(true);
        try {
            await launchBot(config);
            props.onClose();
        } finally {
            setLaunching(false);
        }
    };

    const handleDisconnect = async () => {
        setSelectedCharacterId(null);
        setUserEditedBotName(false);
        setUserEditedPlayerName(false);
        setPreviousChats([]);
        setSelectedChatId(null);
        await disconnect();
    };

    return (
        <div class="connection-panel">
            {/* Phase 1: Voxta Connection */}
            <div class="connection-section">
                <div class="section-title">Voxta Server</div>
                <div class="connection-fields">
                    <div class="field full-width">
                        <label>Voxta URL</label>
                        <input
                            type="text"
                            value={voxtaUrl()}
                            onInput={(e) => setVoxtaUrl(e.currentTarget.value)}
                            placeholder="http://localhost:5384/hub"
                            disabled={isVoxtaConnected()}
                        />
                    </div>
                    <div class="field full-width">
                        <label>Voxta API Key</label>
                        <input
                            type="password"
                            value={apiKey()}
                            onInput={(e) => setApiKey(e.currentTarget.value)}
                            placeholder="Leave empty if no password set"
                            disabled={isVoxtaConnected()}
                        />
                        <span class="field-hint">Only needed if you set a password in Voxta</span>
                    </div>
                </div>

                <Show when={!isVoxtaConnected()}>
                    <div class="connection-actions">
                        <button class="btn btn-connect" onClick={handleConnectVoxta} disabled={isVoxtaConnecting()}>
                            {isVoxtaConnecting() ? '⏳ Connecting...' : '🔗 Connect to Voxta'}
                        </button>
                    </div>
                </Show>
            </div>

            {/* Phase 2: Character + Chat + MC Connection (shown after Voxta connects) */}
            <Show when={isVoxtaConnected() && hasCharacters() && !hasSession()}>
                <div class="connection-section">
                    <div class="section-title">Minecraft Setup</div>
                    <div class="connection-fields">
                        <div class="field full-width">
                            <label>Voxta Character</label>
                            <CustomDropdown
                                options={sortedCharacters().map((char) => ({
                                    value: char.id,
                                    label: `${char.name}${char.id === voxtaInfo.defaultAssistantId ? ' ⭐' : ''}`,
                                }))}
                                value={selectedCharacterId()}
                                onChange={(val) => {
                                    setSelectedCharacterId(val);
                                    setUserEditedBotName(false);
                                }}
                                placeholder="Select a character..."
                            />
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
                                        class={`chat-list-item chat-list-new ${selectedChatId() === null ? 'selected' : ''}`}
                                        onClick={() => setSelectedChatId(null)}
                                    >
                                        <span class="chat-list-icon">✨</span>
                                        <span class="chat-list-label">New Chat</span>
                                    </div>
                                    <For each={previousChats()}>
                                        {(chat, index) => {
                                            const sessionNumber = previousChats().length - index();
                                            const displayName = chat.title ?? `Session #${sessionNumber}`;
                                            return (
                                                <div
                                                    class={`chat-list-item ${selectedChatId() === chat.id ? 'selected' : ''}`}
                                                    onClick={() => setSelectedChatId(chat.id)}
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

                        <div class="field">
                            <label>Bot Username</label>
                            <input
                                type="text"
                                value={mcUsername()}
                                onInput={(e) => {
                                    setMcUsername(e.currentTarget.value);
                                    setUserEditedBotName(true);
                                }}
                                placeholder="Character name"
                            />
                            <span class="field-hint">The bot's name in Minecraft</span>
                        </div>
                        <div class="field">
                            <label>Your Voxta Name</label>
                            <input
                                type="text"
                                value={playerMcName()}
                                onInput={(e) => {
                                    setPlayerMcName(e.currentTarget.value);
                                    setUserEditedPlayerName(true);
                                }}
                                placeholder="Your name"
                            />
                            <span class="field-hint">Auto-filled from your Voxta profile</span>
                        </div>
                        <div class="field">
                            <label>Server Host</label>
                            <input
                                type="text"
                                value={mcHost()}
                                onInput={(e) => setMcHost(e.currentTarget.value)}
                                placeholder="localhost"
                            />
                        </div>
                        <div class="field">
                            <label>Server Port</label>
                            <input
                                type="text"
                                value={mcPort()}
                                onInput={(e) => setMcPort(e.currentTarget.value)}
                                placeholder="25565"
                            />
                        </div>
                        <div class="field">
                            <label>Game Version</label>
                            <input
                                type="text"
                                value={mcVersion()}
                                onInput={(e) => setMcVersion(e.currentTarget.value)}
                                placeholder="Auto-detect"
                            />
                            <span class="field-hint">Leave empty to auto-detect from server</span>
                        </div>
                    </div>

                    <div class="connection-actions">
                        <button
                            class="btn btn-connect"
                            onClick={handleLaunchBot}
                            disabled={launching() || !selectedCharacterId()}
                        >
                            {launching() ? '⏳ Launching...' : selectedChatId() ? '▶️ Resume Chat' : '🚀 New Chat'}
                        </button>
                        <button class="btn btn-disconnect" onClick={handleDisconnect}>
                            ⏹ Disconnect
                        </button>
                    </div>
                </div>
            </Show>

            {/* Disconnect button (shown when connected but Phase 2 is not visible) */}
            <Show when={(isVoxtaConnected() || isMcConnected()) && (!hasCharacters() || hasSession())}>
                <div class="connection-actions" style={{ 'margin-top': '12px' }}>
                    <button class="btn btn-disconnect" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                </div>
            </Show>
        </div>
    );
}
