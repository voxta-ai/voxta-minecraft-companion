import { createSignal, Show, For, createEffect } from 'solid-js';
import { status, connectVoxta, launchBot, disconnect, voxtaInfo } from '../stores/app-store';
import type { BotConfig, VoxtaConnectConfig } from '../../shared/ipc-types';

const STORAGE_KEY = 'voxta-mc-config';

interface SavedConfig {
    mcHost?: string;
    mcPort?: number;
    mcUsername?: string;
    playerMcUsername?: string;
    voxtaUrl?: string;
    voxtaApiKey?: string;
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
    const [mcUsername, setMcUsername] = createSignal(saved.mcUsername ?? '');
    const [playerMcName, setPlayerMcName] = createSignal(saved.playerMcUsername ?? '');
    const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);
    const [launching, setLaunching] = createSignal(false);

    // Track whether the user manually edited the name fields
    const [userEditedBotName, setUserEditedBotName] = createSignal(false);
    const [userEditedPlayerName, setUserEditedPlayerName] = createSignal(false);

    const isVoxtaConnected = () => status.voxta === 'connected';
    const isVoxtaConnecting = () => status.voxta === 'connecting' || connectingVoxta();
    const isMcConnected = () => status.mc === 'connected';
    const hasSession = () => status.sessionId !== null;
    const hasCharacters = () => voxtaInfo.characters.length > 0;

    // Auto-select first character when available
    createEffect(() => {
        if (voxtaInfo.characters.length > 0 && !selectedCharacterId()) {
            setSelectedCharacterId(voxtaInfo.defaultAssistantId ?? voxtaInfo.characters[0]?.id ?? null);
        }
    });

    // Auto-fill player name from Voxta user profile (one-time, unless user edited)
    createEffect(() => {
        if (voxtaInfo.userName && !userEditedPlayerName()) {
            setPlayerMcName(voxtaInfo.userName);
        }
    });

    // Auto-fill bot name when character changes (unless user edited)
    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId && !userEditedBotName()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId);
            if (character) {
                setMcUsername(character.name);
            }
        }
    });

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
            mcVersion: '1.21.11',
            playerMcUsername: playerMcName(),
            characterId: charId,
            perceptionIntervalMs: 3000,
            entityRange: 32,
        };
        saveConfig({
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10),
            mcUsername: mcUsername(),
            playerMcUsername: playerMcName(),
            voxtaUrl: voxtaUrl(),
            voxtaApiKey: apiKey(),
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
                        <button
                            class="btn btn-connect"
                            onClick={handleConnectVoxta}
                            disabled={isVoxtaConnecting()}
                        >
                            {isVoxtaConnecting() ? '⏳ Connecting...' : '🔗 Connect to Voxta'}
                        </button>
                    </div>
                </Show>
            </div>

            {/* Phase 2: Character + MC Connection (shown after Voxta connects) */}
            <Show when={isVoxtaConnected() && hasCharacters() && !hasSession()}>
                <div class="connection-section">
                    <div class="section-title">Minecraft Setup</div>
                    <div class="connection-fields">
                        <div class="field full-width">
                            <label>Voxta Character</label>
                            <select
                                class="character-select"
                                value={selectedCharacterId() ?? ''}
                                onChange={(e) => {
                                    setSelectedCharacterId(e.currentTarget.value);
                                    setUserEditedBotName(false); // Reset so auto-fill works with new character
                                }}
                            >
                                <For each={voxtaInfo.characters}>
                                    {(char) => (
                                        <option value={char.id}>
                                            {char.name} {char.id === voxtaInfo.defaultAssistantId ? '⭐' : ''}
                                        </option>
                                    )}
                                </For>
                            </select>
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
                    </div>

                    <div class="connection-actions">
                        <button
                            class="btn btn-connect"
                            onClick={handleLaunchBot}
                            disabled={launching() || !selectedCharacterId()}
                        >
                            {launching() ? '⏳ Launching...' : '🚀 Launch Bot'}
                        </button>
                        <button class="btn btn-disconnect" onClick={handleDisconnect}>
                            ⏹ Disconnect
                        </button>
                    </div>
                </div>
            </Show>

            {/* Disconnect button (shown when connected but Phase 2 is not visible) */}
            <Show when={(isVoxtaConnected() || isMcConnected()) && (!hasCharacters() || hasSession())}>
                <div class="connection-actions" style={{ "margin-top": "12px" }}>
                    <button class="btn btn-disconnect" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                </div>
            </Show>
        </div>
    );
}
