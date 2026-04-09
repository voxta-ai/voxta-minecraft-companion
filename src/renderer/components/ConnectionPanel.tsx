import { createSignal, createMemo, Show, For, createEffect } from 'solid-js';
import { status, connectVoxta, launchBot, disconnect, voxtaInfo, refreshCharacters } from '../stores/app-store';
import type { BotConfig, CharacterInfo, ChatListItem, ScenarioInfo, VoxtaConnectConfig } from '../../shared/ipc-types';
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
    lastCharacterId2?: string;
    secondMcUsername?: string;
    mcOnly?: boolean;
}

function loadSavedConfig(): SavedConfig {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const config: SavedConfig = raw ? JSON.parse(raw) : {};

        // Fix: detect host+port concatenation (e.g. "localhost25565")
        if (config.mcHost) {
            const match = config.mcHost.match(/^([a-zA-Z.-]+)(\d{4,5})$/);
            if (match) {
                config.mcHost = match[1];
                if (!config.mcPort || config.mcPort === 25565) {
                    config.mcPort = parseInt(match[2], 10);
                }
                // Save the fix immediately
                localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
            }
        }

        return config;
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
    const [mcPort, setMcPort] = createSignal(
        saved.mcPort && saved.mcPort !== 25565 ? String(saved.mcPort) : '',
    );
    const [mcVersion, setMcVersion] = createSignal(saved.mcVersion ?? '');
    const [mcUsername, setMcUsername] = createSignal(saved.mcUsername ?? '');
    const [playerMcName, setPlayerMcName] = createSignal(saved.playerMcUsername ?? '');
    const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);
    const [selectedCharacterId2, setSelectedCharacterId2] = createSignal<string | null>(null);
    const [secondMcUsername, setSecondMcUsername] = createSignal(saved.secondMcUsername ?? '');
    const [launching, setLaunching] = createSignal(false);

    // Scenario selection
    const [scenarios, setScenarios] = createSignal<ScenarioInfo[]>([]);
    const [selectedScenarioId, setSelectedScenarioId] = createSignal<string | null>(null);
    const [loadingScenarios, setLoadingScenarios] = createSignal(false);

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

    // MC-only filter (persisted)
    const [mcOnly, setMcOnly] = createSignal(saved.mcOnly ?? false);
    const displayCharacters = createMemo((): CharacterInfo[] => {
        const all = sortedCharacters();
        if (!mcOnly()) return all;
        return all.filter((c) => c.hasMcConfig);
    });

    // Refresh characters
    const [refreshing, setRefreshing] = createSignal(false);
    const handleRefresh = async (): Promise<void> => {
        setRefreshing(true);
        try {
            await Promise.all([
                refreshCharacters(),
                window.api.loadScenarios().then((list) => setScenarios(list)),
            ]);
        } catch (err) {
            console.error('Failed to refresh:', err);
        } finally {
            setRefreshing(false);
        }
    };

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

    // Fetch scenarios when Voxta connects
    createEffect(() => {
        if (isVoxtaConnected()) {
            setLoadingScenarios(true);
            window.api
                .loadScenarios()
                .then((list) => setScenarios(list))
                .catch((err) => console.error('[UI] Failed to load scenarios:', err))
                .finally(() => setLoadingScenarios(false));
        }
    });

    // Autofill player name from Voxta user profile (one-time, unless user edited)
    createEffect(() => {
        if (voxtaInfo.userName && !userEditedPlayerName()) {
            setPlayerMcName(voxtaInfo.userName);
        }
    });

    // Autofill the bot names when the character changes (unless user edited)
    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId && !userEditedBotName()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId);
            if (character) {
                setMcUsername(character.name);
            }
        }
    });

    const [userEditedBotName2, setUserEditedBotName2] = createSignal(false);
    createEffect(() => {
        const charId2 = selectedCharacterId2();
        if (charId2 && !userEditedBotName2()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId2);
            if (character) {
                setSecondMcUsername(character.name);
            }
        }
    });

    // Filter scenarios by MC only toggle
    const displayScenarios = createMemo(() => {
        const all = scenarios();
        if (!mcOnly()) return all;
        return all.filter((s) => s.client === 'Voxta.Minecraft');
    });

    // Filter chats by the selected scenario
    const filteredChats = createMemo((): ChatListItem[] => {
        const scenarioId = selectedScenarioId();
        const chats = previousChats();
        if (!scenarioId) return chats;
        return chats.filter((c) => c.scenarioId === scenarioId);
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
            setSelectedScenarioId(null);
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
        const trimmedKey = apiKey().trim();
        const config: VoxtaConnectConfig = {
            voxtaUrl: voxtaUrl().trim(),
            voxtaApiKey: trimmedKey,
        };
        saveConfig({ ...loadSavedConfig(), voxtaUrl: voxtaUrl().trim(), voxtaApiKey: trimmedKey });
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
            mcPort: parseInt(mcPort(), 10) || 25565,
            mcUsername: mcUsername(),
            mcVersion: mcVersion(),
            playerMcUsername: playerMcName(),
            characterId: charId,
            secondCharacterId: selectedCharacterId2() || undefined,
            secondMcUsername: secondMcUsername() || undefined,
            scenarioId: selectedScenarioId(),
            chatId: selectedChatId(),
            perceptionIntervalMs: 3000,
            entityRange: 32,
        };
        saveConfig({
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10) || 25565,
            mcUsername: mcUsername(),
            secondMcUsername: secondMcUsername(),
            mcVersion: mcVersion(),
            playerMcUsername: playerMcName(),
            voxtaUrl: voxtaUrl().trim(),
            voxtaApiKey: apiKey().trim(),
            lastCharacterId: charId,
            lastCharacterId2: selectedCharacterId2() || undefined,
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
        setSelectedCharacterId2(null);
        setSelectedScenarioId(null);
        setUserEditedBotName(false);
        setUserEditedBotName2(false);
        setUserEditedPlayerName(false);
        setPreviousChats([]);
        setSelectedChatId(null);
        setScenarios([]);
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
                            onInput={(e) => setApiKey(e.currentTarget.value.trim())}
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
                            <div class="field-label-row">
                                <label>Voxta Character</label>
                                <div class="field-label-row-actions">
                                    <button
                                        class="char-refresh-btn"
                                        title="Refresh characters and scenarios"
                                        disabled={refreshing()}
                                        onClick={handleRefresh}
                                    >
                                        {refreshing() ? '⏳' : '🔄'}
                                    </button>
                                    <Show when={sortedCharacters().some((c) => c.hasMcConfig)}>
                                        <label class="mc-only-toggle" title="Show only characters with Minecraft Companion configured">
                                            <input
                                                type="checkbox"
                                                checked={mcOnly()}
                                                onChange={(e) => {
                                                    const checked = e.currentTarget.checked;
                                                    setMcOnly(checked);
                                                    saveConfig({ ...loadSavedConfig(), mcOnly: checked });
                                                }}
                                            />
                                            <span class="mc-only-label">⛏️ MC only</span>
                                        </label>
                                    </Show>
                                </div>
                            </div>
                            <CustomDropdown
                                options={displayCharacters().map((char) => ({
                                    value: char.id,
                                    label: `${char.hasMcConfig ? '⛏️ ' : ''}${char.name}${char.id === voxtaInfo.defaultAssistantId ? ' ⭐' : ''}`,
                                }))}
                                value={selectedCharacterId()}
                                onChange={(val) => {
                                    setSelectedCharacterId(val);
                                    setUserEditedBotName(false);
                                }}
                                placeholder="Select a character..."
                            />
                        </div>

                        <div class="field full-width">
                            <label>Second Companion (Optional)</label>
                            <CustomDropdown
                                options={[
                                    { value: '', label: 'None' },
                                    ...displayCharacters()
                                        .filter(char => char.id !== selectedCharacterId())
                                        .map((char) => ({
                                            value: char.id,
                                            label: `${char.hasMcConfig ? '⛏️ ' : ''}${char.name}`,
                                        }))
                                ]}
                                value={selectedCharacterId2() ?? ''}
                                onChange={(val) => {
                                    setSelectedCharacterId2(val || null);
                                    setUserEditedBotName2(false);
                                }}
                                placeholder="Select a second character..."
                            />
                        </div>

                        {/* Scenario Selection */}
                        <div class="field full-width">
                            <label>Scenario</label>
                            <Show when={loadingScenarios()}>
                                <span class="field-hint">Loading scenarios...</span>
                            </Show>
                            <Show when={!loadingScenarios()}>
                                <CustomDropdown
                                    options={[
                                        { value: '', label: "None (Use Character's Scenario)" },
                                        ...displayScenarios().map((s) => ({
                                            value: s.id,
                                            label: `${s.client === 'Voxta.Minecraft' ? '⛏️ ' : ''}${s.name}`,
                                        })),
                                    ]}
                                    value={selectedScenarioId() ?? ''}
                                    onChange={(val) => {
                                        setSelectedScenarioId(val || null);
                                        setSelectedChatId(null);
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
                                        class={`chat-list-item chat-list-new ${selectedChatId() === null ? 'selected' : ''}`}
                                        onClick={() => setSelectedChatId(null)}
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
                            <label>Bot 1 Username</label>
                            <input
                                type="text"
                                value={mcUsername()}
                                onInput={(e) => {
                                    setMcUsername(e.currentTarget.value);
                                    setUserEditedBotName(true);
                                }}
                                placeholder="Character name"
                            />
                            <span class="field-hint">The primary bot's name in Minecraft</span>
                        </div>

                        <div class="field">
                            <label>Bot 2 Username (Optional)</label>
                            <input
                                type="text"
                                value={secondMcUsername()}
                                onInput={(e) => {
                                    setSecondMcUsername(e.currentTarget.value);
                                    setUserEditedBotName2(true);
                                }}
                                placeholder="Second character name..."
                                disabled={!selectedCharacterId2()}
                            />
                            <span class="field-hint">The second bot's name in Minecraft</span>
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
                                placeholder="Default: 25565"
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
