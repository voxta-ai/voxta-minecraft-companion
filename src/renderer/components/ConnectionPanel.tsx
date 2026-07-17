import { createSignal, createEffect, Show } from 'solid-js';
import { status, connectVoxta, launchBot, disconnect, voxtaInfo } from '../stores/connection-store';
import { serverState, serverPort as managedServerPort, isInstalled } from '../stores/server-store';
import type { BotConfig, ScenarioInfo, VoxtaConnectConfig } from '../../shared/ipc-types';
import CharacterSelector from './CharacterSelector';
import ChatList from './ChatList';
import ConnectionStepper from './ConnectionStepper';

type WizardStep = 'companion' | 'chat';

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
    const [secondMcUsername, setSecondMcUsername] = createSignal(saved.secondMcUsername ?? '');
    const [launching, setLaunching] = createSignal(false);

    // Which Minecraft server the bot connects to. Defaults to the app's
    // built-in server when it's installed, otherwise a custom (external) one.
    // null = follow the default; true/false = user override.
    const [customServerOverride, setCustomServerOverride] = createSignal<boolean | null>(null);
    const useCustomServer = () => customServerOverride() ?? !isInstalled();

    // Wizard navigation: which guided step is showing, and whether the user
    // chose to edit their saved setup instead of using Quick Start.
    const [step, setStep] = createSignal<WizardStep>('companion');
    const [changeSetup, setChangeSetup] = createSignal(false);

    // MC-only filter state (toggled by CharacterSelector, read here for ChatList)
    const [mcOnly, setMcOnly] = createSignal(saved.mcOnly ?? false);

    const isVoxtaConnected = () => status.voxta === 'connected';
    const isVoxtaConnecting = () => status.voxta === 'connecting' || connectingVoxta();
    const isMcConnected = () => status.mc === 'connected';
    const hasSession = () => status.sessionId !== null;
    const hasCharacters = () => voxtaInfo.characters.length > 0;

    const characterName = () =>
        voxtaInfo.characters.find((c) => c.id === selectedCharacterId())?.name ?? '';

    // True when a previously-used character is available to one-click launch.
    const savedCharValid = () =>
        !!saved.lastCharacterId && voxtaInfo.characters.some((c) => c.id === saved.lastCharacterId);

    const showQuickStart = () =>
        isVoxtaConnected() && hasCharacters() && !hasSession() && savedCharValid() && !changeSetup();

    // Which top-level view the panel renders.
    const view = (): 'connect' | 'quickstart' | 'guided' | 'connected' => {
        if (!isVoxtaConnected() && !isMcConnected()) return 'connect';
        if (hasSession() || !hasCharacters()) return 'connected';
        if (showQuickStart()) return 'quickstart';
        return 'guided';
    };

    const currentStepKey = () => (view() === 'connect' ? 'connect' : step());

    // The bundled/managed server is mid-transition — wait briefly so the user
    // doesn't try to connect during startup/shutdown. Any other state (running,
    // stopped, not-installed) is fine: if the user is pointing at their own
    // server, the connection attempt will succeed; otherwise it'll fail with a
    // clear error. Host/port can't reliably distinguish "managed" from "user's
    // own server on localhost:25565".
    const isManagedServerTransitioning = () =>
        serverState() === 'starting' || serverState() === 'stopping';

    // Auto-select: saved character if available, otherwise default assistant
    createEffect(() => {
        if (voxtaInfo.characters.length > 0 && !selectedCharacterId()) {
            const savedId = saved.lastCharacterId;
            const savedExists = savedId && voxtaInfo.characters.some((c) => c.id === savedId);
            setSelectedCharacterId(
                savedExists ? savedId : (voxtaInfo.defaultAssistantId ?? voxtaInfo.characters[0]?.id ?? null),
            );
            // Restore the saved second companion so Quick Start launches the same pair.
            const savedId2 = saved.lastCharacterId2;
            if (savedId2 && voxtaInfo.characters.some((c) => c.id === savedId2)) {
                setSelectedCharacterId2(savedId2);
            }
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

    // Sync MC bot usernames from selected Voxta characters
    createEffect(() => {
        const charId = selectedCharacterId();
        if (charId) {
            const character = voxtaInfo.characters.find((c) => c.id === charId);
            if (character) setMcUsername(character.name);
        }
    });

    createEffect(() => {
        const charId2 = selectedCharacterId2();
        if (charId2) {
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

        const custom = useCustomServer();
        const config: BotConfig = {
            mcHost: custom ? (mcHost() || 'localhost') : 'localhost',
            mcPort: custom ? (parseInt(mcPort(), 10) || managedServerPort()) : managedServerPort(),
            mcUsername: mcUsername(),
            mcVersion: custom ? mcVersion() : '',
            playerMcUsername: '',
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
            playerMcUsername: '',
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
        setSelectedChatId(null);
        setScenarios([]);
        await disconnect();
    };

    return (
        <div class="connection-panel">
            <div class="connection-scroll">
                <Show when={view() === 'connect' || view() === 'guided'}>
                    <ConnectionStepper current={currentStepKey} />
                </Show>

                {/* Step 1: Connect to Voxta */}
                <Show when={view() === 'connect'}>
                    <div class="connection-compat-badge">
                        <i class="bi bi-controller"></i> Supported Minecraft: 1.8 – 1.21.11
                    </div>
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
                                />
                            </div>
                            <div class="field full-width">
                                <label>Voxta API Key</label>
                                <input
                                    type="password"
                                    value={apiKey()}
                                    onInput={(e) => setApiKey(e.currentTarget.value.trim())}
                                    placeholder="Leave empty if no password set"
                                />
                                <span class="field-hint">Only needed if you set a password in Voxta</span>
                            </div>
                        </div>
                    </div>
                </Show>

                {/* Quick Start: one-click launch for a returning setup */}
                <Show when={view() === 'quickstart'}>
                    <div class="quick-start">
                        <div class="quick-start-emblem"><i class="bi bi-controller"></i></div>
                        <h3>Ready to play</h3>
                        <p>Jump straight back in with <strong>{characterName()}</strong>.</p>
                        <div class="quick-start-links">
                            <button
                                class="link-btn"
                                onClick={() => {
                                    setChangeSetup(true);
                                    setStep('chat');
                                }}
                            >
                                Resume a previous chat
                            </button>
                            <span class="quick-start-sep">·</span>
                            <button
                                class="link-btn"
                                onClick={() => {
                                    setChangeSetup(true);
                                    setStep('companion');
                                }}
                            >
                                Change setup
                            </button>
                        </div>
                    </div>
                </Show>

                {/* Step 2: Choose companion */}
                <Show when={view() === 'guided' && step() === 'companion'}>
                    <div class="connection-section">
                        <div class="section-title">Choose your companion</div>
                        <div class="connection-fields">
                            <CharacterSelector
                                selectedCharacterId={selectedCharacterId}
                                setSelectedCharacterId={setSelectedCharacterId}
                                selectedCharacterId2={selectedCharacterId2}
                                setSelectedCharacterId2={setSelectedCharacterId2}
                                onMcOnlyChange={(checked) => setMcOnly(checked)}
                                onScenariosLoaded={(list) => setScenarios(list)}
                            />
                        </div>
                    </div>
                </Show>

                {/* Step 3: Scenario & chat */}
                <Show when={view() === 'guided' && step() === 'chat'}>
                    <div class="connection-section">
                        <div class="section-title">Scenario &amp; chat</div>
                        <div class="connection-fields">
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

                            <div class="field full-width">
                                <label>Minecraft Server</label>
                                <div class="server-mode">
                                    <button
                                        type="button"
                                        class="server-mode-btn"
                                        classList={{ active: !useCustomServer() }}
                                        onClick={() => setCustomServerOverride(false)}
                                    >
                                        Built-in
                                    </button>
                                    <button
                                        type="button"
                                        class="server-mode-btn"
                                        classList={{ active: useCustomServer() }}
                                        onClick={() => setCustomServerOverride(true)}
                                    >
                                        Custom
                                    </button>
                                </div>
                                <span class="field-hint">
                                    {useCustomServer()
                                        ? 'Connect the bot to your own Minecraft server.'
                                        : "Use this app's built-in server (auto-started for you)."}
                                </span>
                            </div>

                            <Show when={useCustomServer()}>
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
                    </div>
                </Show>

                {/* Connected + running session */}
                <Show when={view() === 'connected'}>
                    <div class="quick-start">
                        <div class="quick-start-emblem connected"><i class="bi bi-check-circle-fill"></i></div>
                        <h3>Connected</h3>
                        <p>Your companion session is running.</p>
                    </div>
                </Show>
            </div>

            {/* Action footer — sits outside the scroll region */}
            <Show when={view() === 'connect'}>
                <div class="connection-actions">
                    <button class="btn btn-connect push-right" onClick={handleConnectVoxta} disabled={isVoxtaConnecting()}>
                        {isVoxtaConnecting() ? '⏳ Connecting...' : '🔗 Connect to Voxta'}
                    </button>
                </div>
            </Show>

            <Show when={view() === 'quickstart'}>
                <div class="connection-actions">
                    <button class="btn btn-disconnect" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                    <button
                        class={`btn btn-connect push-right ${isManagedServerTransitioning() && !launching() ? 'btn-waiting' : ''}`}
                        onClick={() => {
                            setSelectedChatId(null);
                            void handleLaunchBot();
                        }}
                        disabled={launching() || !selectedCharacterId() || isManagedServerTransitioning()}
                        title={isManagedServerTransitioning() ? 'Wait for the server to finish starting' : ''}
                    >
                        {launching() ? '⏳ Launching...' : `🚀 Start with ${characterName()}`}
                    </button>
                </div>
            </Show>

            <Show when={view() === 'guided' && step() === 'companion'}>
                <div class="connection-actions">
                    <Show when={savedCharValid()}>
                        <button class="wizard-back" onClick={() => setChangeSetup(false)}>
                            ← Back
                        </button>
                    </Show>
                    <button
                        class="btn btn-connect"
                        onClick={() => setStep('chat')}
                        disabled={!selectedCharacterId()}
                    >
                        Next: Chat →
                    </button>
                </div>
            </Show>

            <Show when={view() === 'guided' && step() === 'chat'}>
                <div class="connection-actions">
                    <button class="wizard-back" onClick={() => setStep('companion')}>
                        ← Back
                    </button>
                    <button
                        class={`btn btn-connect ${isManagedServerTransitioning() && !launching() ? 'btn-waiting' : ''}`}
                        onClick={handleLaunchBot}
                        disabled={launching() || !selectedCharacterId() || isManagedServerTransitioning()}
                        title={isManagedServerTransitioning() ? 'Wait for the server to finish starting' : ''}
                    >
                        {launching()
                            ? '⏳ Launching...'
                            : selectedChatId() ? '▶️ Resume Chat' : '🚀 New Chat'}
                    </button>
                </div>
            </Show>

            <Show when={view() === 'connected'}>
                <div class="connection-actions">
                    <button class="btn btn-disconnect push-right" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                </div>
            </Show>
        </div>
    );
}
