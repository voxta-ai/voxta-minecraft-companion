import { createSignal, createEffect, Show } from 'solid-js';
import { status, connectVoxta, launchBot, disconnect, voxtaInfo } from '../stores/connection-store';
import { serverState, serverPort as managedServerPort } from '../stores/server-store';
import type { BotConfig, ScenarioInfo, VoxtaConnectConfig } from '../../shared/ipc-types';
import CharacterSelector from './CharacterSelector';
import ChatList from './ChatList';

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

    // Phase 1: Voxta connection
    const [voxtaUrl, setVoxtaUrl] = createSignal(saved.voxtaUrl ?? 'http://localhost:5384/hub');
    const [apiKey, setApiKey] = createSignal(saved.voxtaApiKey ?? '');
    const [connectingVoxta, setConnectingVoxta] = createSignal(false);

    // Phase 2: Character + Chat selection
    const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);
    const [selectedCharacterId2, setSelectedCharacterId2] = createSignal<string | null>(null);
    const [selectedScenarioId, setSelectedScenarioId] = createSignal<string | null>(null);
    const [selectedChatId, setSelectedChatId] = createSignal<string | null>(null);
    const [scenarios, setScenarios] = createSignal<ScenarioInfo[]>([]);
    const [loadingScenarios, setLoadingScenarios] = createSignal(false);

    // Phase 2: MC config
    const [mcHost, setMcHost] = createSignal(saved.mcHost ?? 'localhost');
    const [mcPort, setMcPort] = createSignal(
        saved.mcPort && saved.mcPort !== 25565 ? String(saved.mcPort) : '',
    );
    const [mcVersion, setMcVersion] = createSignal(saved.mcVersion ?? '');
    const [mcUsername, setMcUsername] = createSignal(saved.mcUsername ?? '');
    const [playerMcName, setPlayerMcName] = createSignal(saved.playerMcUsername ?? '');
    const [secondMcUsername, setSecondMcUsername] = createSignal(saved.secondMcUsername ?? '');
    const [showAdvanced, setShowAdvanced] = createSignal(false);
    const [launching, setLaunching] = createSignal(false);

    // Track whether the user manually edited the name fields
    const [userEditedBotName, setUserEditedBotName] = createSignal(false);
    const [userEditedBotName2, setUserEditedBotName2] = createSignal(false);
    const [userEditedPlayerName, setUserEditedPlayerName] = createSignal(false);

    // MC-only filter state (toggled by CharacterSelector, read here for ChatList)
    const [mcOnly, setMcOnly] = createSignal(saved.mcOnly ?? false);

    const isVoxtaConnected = () => status.voxta === 'connected';
    const isVoxtaConnecting = () => status.voxta === 'connecting' || connectingVoxta();
    const isMcConnected = () => status.mc === 'connected';
    const hasSession = () => status.sessionId !== null;
    const hasCharacters = () => voxtaInfo.characters.length > 0;

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

    // Autofill bot names when the character changes (unless user edited)
    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId && !userEditedBotName()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId);
            if (character) setMcUsername(character.name);
        }
    });

    createEffect(() => {
        const charId2 = selectedCharacterId2();
        if (charId2 && !userEditedBotName2()) {
            const character = voxtaInfo.characters.find((c) => c.id === charId2);
            if (character) setSecondMcUsername(character.name);
        }
    });

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
            mcHost: mcHost() || 'localhost',
            mcPort: parseInt(mcPort(), 10) || managedServerPort(),
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
            mcHost: mcHost() || 'localhost',
            mcPort: parseInt(mcPort(), 10) || managedServerPort(),
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
        setSelectedChatId(null);
        setScenarios([]);
        await disconnect();
    };

    return (
        <div class="connection-panel">
            <div class="connection-compat-badge">
                <i class="bi bi-controller"></i> Supported Minecraft: 1.8 – 1.21.11
            </div>
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

            {/* Phase 2: Character + Chat + MC Connection */}
            <Show when={isVoxtaConnected() && hasCharacters() && !hasSession()}>
                <div class="connection-section">
                    <div class="section-title">Minecraft Setup</div>
                    <div class="connection-fields">
                        <CharacterSelector
                            selectedCharacterId={selectedCharacterId}
                            setSelectedCharacterId={setSelectedCharacterId}
                            selectedCharacterId2={selectedCharacterId2}
                            setSelectedCharacterId2={setSelectedCharacterId2}
                            onCharacterChange={() => setUserEditedBotName(false)}
                            onCharacter2Change={() => setUserEditedBotName2(false)}
                            onMcOnlyChange={(checked) => setMcOnly(checked)}
                            onScenariosLoaded={(list) => setScenarios(list)}
                        />

                        <ChatList
                            characterId={selectedCharacterId}
                            isVoxtaConnected={isVoxtaConnected}
                            scenarios={scenarios}
                            loadingScenarios={loadingScenarios}
                            selectedScenarioId={selectedScenarioId}
                            setSelectedScenarioId={setSelectedScenarioId}
                            selectedChatId={selectedChatId}
                            setSelectedChatId={setSelectedChatId}
                            mcOnly={mcOnly}
                        />

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
                        <button
                            class="advanced-toggle"
                            onClick={() => setShowAdvanced(!showAdvanced())}
                        >
                            <i class={`bi bi-chevron-${showAdvanced() ? 'up' : 'down'}`}></i>
                            Advanced
                        </button>
                        <Show when={showAdvanced()}>
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
                                    placeholder={`Default: ${managedServerPort()}`}
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
                        </Show>
                    </div>

                    <div class="connection-actions">
                        <button
                            class={`btn btn-connect ${serverState() !== 'running' && !launching() ? 'btn-waiting' : ''}`}
                            onClick={handleLaunchBot}
                            disabled={launching() || !selectedCharacterId() || serverState() !== 'running'}
                            title={serverState() !== 'running' ? 'Start the server first' : ''}
                        >
                            {launching()
                                ? '⏳ Launching...'
                                : serverState() === 'starting'
                                    ? '⏳ Starting server...'
                                    : serverState() === 'stopping'
                                        ? '⏳ Server stopping...'
                                        : serverState() !== 'running'
                                            ? '⏳ Waiting for server...'
                                            : selectedChatId() ? '▶️ Resume Chat' : '🚀 New Chat'}
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
