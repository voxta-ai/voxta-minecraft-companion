import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js';
import {
    serverState,
    setServerState,
    serverPort,
    setServerPort,
    serverError,
    setServerError,
    isInstalled,
    setIsInstalled,
    setupProgress,
    setSetupProgress,
    isSettingUp,
    setIsSettingUp,
    serverConsole,
    addServerConsoleLine,
    clearServerConsole,
} from '../stores/server-store';
import type {
    ServerProperties,
    PluginInfo,
    CatalogPlugin,
    WorldInfo,
    ServerState as ServerStateType,
} from '../../shared/ipc-types';

type ServerSection = 'console' | 'properties' | 'plugins' | 'worlds';

export default function ServerPanel() {
    const [activeSection, setActiveSection] = createSignal<ServerSection>('console');
    const [commandInput, setCommandInput] = createSignal('');
    const [properties, setProperties] = createSignal<ServerProperties>({});
    const [plugins, setPlugins] = createSignal<PluginInfo[]>([]);
    const [catalog, setCatalog] = createSignal<CatalogPlugin[]>([]);
    const [worlds, setWorlds] = createSignal<WorldInfo[]>([]);
    const [propsChanged, setPropsChanged] = createSignal(false);
    const [savingProps, setSavingProps] = createSignal(false);
    const [installingPlugin, setInstallingPlugin] = createSignal<string | null>(null);
    const [availableVersions, setAvailableVersions] = createSignal<string[]>([]);
    const [selectedVersion, setSelectedVersion] = createSignal('');
    const [loadingVersions, setLoadingVersions] = createSignal(false);
    const [installedVersion, setInstalledVersion] = createSignal<string | null>(null);
    const [changingVersion, setChangingVersion] = createSignal(false);
    let consoleRef: HTMLDivElement | undefined;

    // Auto-scroll console to bottom
    createEffect(() => {
        const _count = serverConsole.lines.length;
        if (consoleRef) {
            requestAnimationFrame(() => {
                if (consoleRef) consoleRef.scrollTop = consoleRef.scrollHeight;
            });
        }
    });

    // Subscribe to IPC events
    onMount(() => {
        const unsubStatus = window.api.onServerStatusChanged((status) => {
            setServerState(status.state as ServerStateType);
            setServerPort(status.port);
            setServerError(status.error);
        });

        const unsubConsole = window.api.onServerConsoleLine((line) => {
            addServerConsoleLine(line);
        });

        const unsubProgress = window.api.onServerSetupProgress((progress) => {
            setSetupProgress(progress);
        });

        // Check initial state — fetch real status from main process, don't assume idle
        void Promise.all([
            window.api.serverIsInstalled(),
            window.api.serverGetStatus(),
            window.api.serverGetInstalledVersion(),
        ]).then(([installed, status, version]) => {
            setIsInstalled(installed);
            setServerState(status.state as ServerStateType);
            setServerPort(status.port);
            setServerError(status.error);
            setInstalledVersion(version);
            if (installed) {
                void loadServerData();
            } else {
                // Fetch available versions for the setup screen
                void fetchVersions();
            }
        });

        onCleanup(() => {
            unsubStatus();
            unsubConsole();
            unsubProgress();
        });
    });

    async function loadServerData(): Promise<void> {
        const [props, pluginList, catalogList, worldList] = await Promise.all([
            window.api.serverGetProperties(),
            window.api.serverGetPlugins(),
            window.api.serverGetCatalog(),
            window.api.serverGetWorlds(),
        ]);
        setProperties(props);
        setPlugins(pluginList);
        setCatalog(catalogList);
        setWorlds(worldList);
    }

    async function fetchVersions(): Promise<void> {
        setLoadingVersions(true);
        try {
            const versions = await window.api.serverGetVersions();
            setAvailableVersions(versions);
            if (versions.length > 0 && !selectedVersion()) {
                setSelectedVersion(versions[0]); // Latest version as default
            }
        } catch (err) {
            console.error('Failed to fetch versions:', err);
        } finally {
            setLoadingVersions(false);
        }
    }

    async function handleSetup(): Promise<void> {
        const version = selectedVersion();
        if (!version) return;
        setIsSettingUp(true);
        try {
            await window.api.serverSetup(version);
            setIsInstalled(true);
            setInstalledVersion(version);
            setChangingVersion(false);
            void loadServerData();
        } catch (err) {
            console.error('Setup failed:', err);
        } finally {
            setIsSettingUp(false);
            setSetupProgress(null);
        }
    }

    async function handleChangeVersion(): Promise<void> {
        setChangingVersion(true);
        await fetchVersions();
    }

    async function handleStart(): Promise<void> {
        try {
            await window.api.serverStart();
        } catch (err) {
            console.error('Start failed:', err);
        }
    }

    async function handleStop(): Promise<void> {
        try {
            await window.api.serverStop();
        } catch (err) {
            console.error('Stop failed:', err);
        }
    }

    function handleSendCommand(): void {
        const cmd = commandInput().trim();
        if (!cmd) return;
        void window.api.serverSendCommand(cmd);
        setCommandInput('');
    }

    function updateProperty(key: string, value: string): void {
        setProperties((prev) => ({ ...prev, [key]: value }));
        setPropsChanged(true);
    }

    async function handleSaveProperties(): Promise<void> {
        setSavingProps(true);
        try {
            await window.api.serverSaveProperties(properties());
            setPropsChanged(false);
        } catch (err) {
            console.error('Save failed:', err);
        } finally {
            setSavingProps(false);
        }
    }

    async function handleInstallPlugin(pluginId: string): Promise<void> {
        setInstallingPlugin(pluginId);
        try {
            await window.api.serverInstallPlugin(pluginId);
            setPlugins(await window.api.serverGetPlugins());
        } catch (err) {
            console.error('Install failed:', err);
        } finally {
            setInstallingPlugin(null);
        }
    }

    async function handleRemovePlugin(fileName: string): Promise<void> {
        try {
            await window.api.serverRemovePlugin(fileName);
            setPlugins(await window.api.serverGetPlugins());
        } catch (err) {
            console.error('Remove failed:', err);
        }
    }

    function getStateLabel(state: string): string {
        switch (state) {
            case 'not-installed': return 'Not Installed';
            case 'idle': return 'Stopped';
            case 'starting': return 'Starting...';
            case 'running': return 'Running';
            case 'stopping': return 'Stopping...';
            case 'error': return 'Error';
            default: return state;
        }
    }

    function getStateDotClass(state: string): string {
        switch (state) {
            case 'running': return 'connected';
            case 'starting':
            case 'stopping': return 'connecting';
            case 'error': return 'error';
            default: return 'disconnected';
        }
    }

    function formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function isPluginInstalled(catalogPlugin: CatalogPlugin): boolean {
        return plugins().some((p) => p.fileName === catalogPlugin.fileName);
    }

    return (
        <div class="server-panel">
        <Show
            when={isInstalled()}
            fallback={
                <div class="server-setup">
                    <div class="server-setup-icon"><i class="bi bi-hdd-rack"></i></div>
                    <h3>Paper Server Setup</h3>
                    <p class="server-setup-desc">
                        Download and configure a Minecraft Paper server optimized for Voxta AI companions.
                        This will download from official sources and set up everything automatically.
                    </p>
                    <div class="server-compat-note">
                        <i class="bi bi-info-circle"></i>
                        Mineflayer bots currently support Minecraft 1.8 – 1.21.11.
                        Pick a version that matches your Minecraft client.
                    </div>
                    <div class="server-setup-details">
                        <div class="server-setup-item">
                            <i class="bi bi-cloud-download"></i>
                            <span>Paper Server</span>
                            <Show
                                when={!loadingVersions() && availableVersions().length > 0}
                                fallback={
                                    <span class="server-version-loading">
                                        {loadingVersions() ? 'Loading versions...' : ''}
                                    </span>
                                }
                            >
                                <select
                                    class="server-version-select"
                                    value={selectedVersion()}
                                    onChange={(e) => setSelectedVersion(e.currentTarget.value)}
                                    disabled={isSettingUp()}
                                >
                                    <For each={availableVersions()}>
                                        {(version) => <option value={version}>{version}</option>}
                                    </For>
                                </select>
                            </Show>
                        </div>
                        <div class="server-setup-item">
                            <i class="bi bi-palette"></i> SkinsRestorer Plugin
                        </div>
                        <div class="server-setup-item">
                            <i class="bi bi-gear"></i> Pre-configured settings
                        </div>
                    </div>
                    <Show when={setupProgress()}>
                        <div class="server-setup-progress">
                            <div class="server-setup-progress-label">{setupProgress()?.label}</div>
                            <div class="server-setup-progress-bar">
                                <div
                                    class="server-setup-progress-fill"
                                    style={{
                                        width: setupProgress()?.bytesTotal
                                            ? `${Math.round(((setupProgress()?.bytesDownloaded ?? 0) / (setupProgress()?.bytesTotal ?? 1)) * 100)}%`
                                            : `${Math.round(((setupProgress()?.step ?? 0) / (setupProgress()?.totalSteps ?? 1)) * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>
                    </Show>
                    <button
                        class="btn btn-connect server-setup-btn"
                        onClick={() => void handleSetup()}
                        disabled={isSettingUp() || !selectedVersion()}
                    >
                        {isSettingUp() ? 'Setting up...' : `Download & Setup Server${selectedVersion() ? ` (${selectedVersion()})` : ''}`}
                    </button>
                </div>
            }
        >
            {/* ---- Main Server Panel (installed) ---- */}
            {/* Status Bar */}
            <div class="server-status-bar">
                <div class="server-status-info">
                    <span class={`status-dot ${getStateDotClass(serverState())}`} />
                    <span class="server-status-label">{getStateLabel(serverState())}</span>
                    <Show when={serverState() === 'running'}>
                        <span class="server-port">:{serverPort()}</span>
                    </Show>
                    <span class="server-version-badge">
                        Paper {installedVersion() ?? ''}
                    </span>
                    <Show when={serverError()}>
                        <span class="server-error-msg">{serverError()}</span>
                    </Show>
                </div>
                <div class="server-status-actions">
                    <Show when={serverState() === 'idle' || serverState() === 'error'}>
                        <button
                            class="server-change-version-btn"
                            onClick={() => void handleChangeVersion()}
                            title="Change Paper version"
                        >
                            <i class="bi bi-arrow-repeat"></i>
                        </button>
                    </Show>
                    <Show
                        when={serverState() !== 'running' && serverState() !== 'starting'}
                        fallback={
                            <button
                                class="btn btn-disconnect"
                                onClick={() => void handleStop()}
                                disabled={serverState() === 'stopping'}
                            >
                                {serverState() === 'stopping' ? 'Stopping...' : 'Stop'}
                            </button>
                        }
                    >
                        <button
                            class="btn btn-connect"
                            onClick={() => void handleStart()}
                            disabled={serverState() === 'stopping'}
                        >
                            Start
                        </button>
                    </Show>
                </div>
            </div>

            {/* Version Change Panel */}
            <Show when={changingVersion()}>
                <div class="server-version-change">
                    <Show
                        when={!loadingVersions() && availableVersions().length > 0}
                        fallback={<span class="server-version-loading">{loadingVersions() ? 'Loading versions...' : ''}</span>}
                    >
                        <select
                            class="server-version-select"
                            value={selectedVersion()}
                            onChange={(e) => setSelectedVersion(e.currentTarget.value)}
                            disabled={isSettingUp()}
                        >
                            <For each={availableVersions()}>
                                {(version) => <option value={version}>{version}</option>}
                            </For>
                        </select>
                        <button
                            class="btn btn-connect"
                            onClick={() => void handleSetup()}
                            disabled={isSettingUp() || !selectedVersion()}
                        >
                            {isSettingUp() ? 'Downloading...' : 'Install'}
                        </button>
                        <button
                            class="server-change-version-cancel"
                            onClick={() => setChangingVersion(false)}
                            disabled={isSettingUp()}
                        >
                            Cancel
                        </button>
                    </Show>
                    <Show when={setupProgress()}>
                        <div class="server-setup-progress">
                            <div class="server-setup-progress-label">{setupProgress()?.label}</div>
                            <div class="server-setup-progress-bar">
                                <div
                                    class="server-setup-progress-fill"
                                    style={{
                                        width: setupProgress()?.bytesTotal
                                            ? `${Math.round(((setupProgress()?.bytesDownloaded ?? 0) / (setupProgress()?.bytesTotal ?? 1)) * 100)}%`
                                            : `${Math.round(((setupProgress()?.step ?? 0) / (setupProgress()?.totalSteps ?? 1)) * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>
                    </Show>
                </div>
            </Show>

            {/* Section Tabs */}
            <div class="server-tabs">
                <button
                    class={`server-tab ${activeSection() === 'console' ? 'active' : ''}`}
                    onClick={() => setActiveSection('console')}
                >
                    <i class="bi bi-terminal"></i> Console
                </button>
                <button
                    class={`server-tab ${activeSection() === 'plugins' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveSection('plugins');
                        void loadServerData();
                    }}
                >
                    <i class="bi bi-puzzle"></i> Plugins
                </button>
                <button
                    class={`server-tab ${activeSection() === 'properties' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveSection('properties');
                        void window.api.serverGetProperties().then(setProperties);
                    }}
                >
                    <i class="bi bi-sliders"></i> Settings
                </button>
                <button
                    class={`server-tab ${activeSection() === 'worlds' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveSection('worlds');
                        void window.api.serverGetWorlds().then(setWorlds);
                    }}
                >
                    <i class="bi bi-globe-americas"></i> Worlds
                </button>
            </div>

            {/* Console Section */}
            <Show when={activeSection() === 'console'}>
                <div class="server-console-section">
                    <div class="server-console-toolbar">
                        <span class="server-console-count">{serverConsole.lines.length} lines</span>
                        <button class="terminal-toolbar-btn" onClick={clearServerConsole}>
                            <i class="bi bi-slash-circle"></i> Clear
                        </button>
                    </div>
                    <div class="server-console-logs" ref={(el) => (consoleRef = el)}>
                        <code>
                            <For each={serverConsole.lines}>
                                {(line) => (
                                    <div class={`terminal-row ${line.level === 'error' ? 'terminal-row-error' : line.level === 'warn' ? 'terminal-row-warn' : ''}`}>
                                        <span class="terminal-timestamp">
                                            {new Date(line.timestamp).toLocaleTimeString([], {
                                                hour12: false,
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                second: '2-digit',
                                            })}
                                        </span>
                                        <div class="terminal-content">{line.text}</div>
                                    </div>
                                )}
                            </For>
                            <Show when={serverConsole.lines.length === 0}>
                                <div class="terminal-empty">Server console is empty. Start the server to see output.</div>
                            </Show>
                        </code>
                    </div>
                    <div class="server-command-bar">
                        <input
                            type="text"
                            value={commandInput()}
                            onInput={(e) => setCommandInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSendCommand();
                            }}
                            placeholder={serverState() === 'running' ? 'Type a server command...' : 'Server is not running'}
                            disabled={serverState() !== 'running'}
                        />
                        <button
                            class="btn btn-connect server-command-send"
                            onClick={handleSendCommand}
                            disabled={serverState() !== 'running' || !commandInput().trim()}
                        >
                            Send
                        </button>
                    </div>
                </div>
            </Show>

            {/* Plugins Section */}
            <Show when={activeSection() === 'plugins'}>
                <div class="server-plugins-section">
                    {/* Plugin Library */}
                    <div class="server-section-group">
                        <div class="section-title">Plugin Library</div>
                        <div class="setting-card-list">
                            <For each={catalog()}>
                                {(cp) => (
                                    <div class="setting-card">
                                        <div class="setting-card-info">
                                            <div class="setting-card-name">{cp.name}</div>
                                            <div class="setting-card-desc">{cp.description}</div>
                                        </div>
                                        <Show
                                            when={isPluginInstalled(cp)}
                                            fallback={
                                                <button
                                                    class="btn btn-connect server-plugin-btn"
                                                    onClick={() => void handleInstallPlugin(cp.id)}
                                                    disabled={installingPlugin() === cp.id || serverState() === 'running'}
                                                >
                                                    {installingPlugin() === cp.id ? 'Installing...' : 'Install'}
                                                </button>
                                            }
                                        >
                                            <span class="server-plugin-installed">
                                                <i class="bi bi-check-circle-fill"></i> Installed
                                            </span>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>

                    {/* Installed Plugins */}
                    <div class="server-section-group">
                        <div class="section-title">Installed Plugins</div>
                        <Show
                            when={plugins().length > 0}
                            fallback={<div class="server-empty-hint">No plugins installed yet.</div>}
                        >
                            <div class="setting-card-list">
                                <For each={plugins()}>
                                    {(plugin) => (
                                        <div class="setting-card">
                                            <div class="setting-card-info">
                                                <div class="setting-card-name">{plugin.name}</div>
                                                <div class="setting-card-desc">
                                                    {plugin.fileName} ({formatFileSize(plugin.fileSize)})
                                                </div>
                                            </div>
                                            <button
                                                class="server-plugin-remove-btn"
                                                onClick={() => void handleRemovePlugin(plugin.fileName)}
                                                disabled={serverState() === 'running'}
                                                title={serverState() === 'running' ? 'Stop the server first' : 'Remove plugin'}
                                            >
                                                <i class="bi bi-trash"></i>
                                            </button>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                        <Show when={serverState() === 'running'}>
                            <div class="server-hint">Stop the server to install or remove plugins.</div>
                        </Show>
                    </div>
                </div>
            </Show>

            {/* Properties Section */}
            <Show when={activeSection() === 'properties'}>
                <div class="server-properties-section">
                    <Show when={serverState() === 'running'}>
                        <div class="server-hint">Changes require a server restart to take effect.</div>
                    </Show>

                    <div class="server-section-group">
                        <div class="section-title">Game</div>
                        <div class="setting-card-list">
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Difficulty</div>
                                </div>
                                <select
                                    class="vision-select"
                                    value={properties()['difficulty'] ?? 'easy'}
                                    onChange={(e) => updateProperty('difficulty', e.currentTarget.value)}
                                >
                                    <option value="peaceful">Peaceful</option>
                                    <option value="easy">Easy</option>
                                    <option value="normal">Normal</option>
                                    <option value="hard">Hard</option>
                                </select>
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Game Mode</div>
                                </div>
                                <select
                                    class="vision-select"
                                    value={properties()['gamemode'] ?? 'survival'}
                                    onChange={(e) => updateProperty('gamemode', e.currentTarget.value)}
                                >
                                    <option value="survival">Survival</option>
                                    <option value="creative">Creative</option>
                                    <option value="adventure">Adventure</option>
                                    <option value="spectator">Spectator</option>
                                </select>
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Max Players</div>
                                </div>
                                <input
                                    type="number"
                                    class="server-prop-number"
                                    value={properties()['max-players'] ?? '5'}
                                    min="1"
                                    max="100"
                                    onChange={(e) => updateProperty('max-players', e.currentTarget.value)}
                                />
                            </div>
                        </div>
                    </div>

                    <div class="server-section-group">
                        <div class="section-title">Server</div>
                        <div class="setting-card-list">
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">MOTD</div>
                                    <div class="setting-card-desc">Message shown in the server browser</div>
                                </div>
                                <input
                                    type="text"
                                    class="server-prop-text"
                                    value={properties()['motd'] ?? 'Voxta Test Server'}
                                    onChange={(e) => updateProperty('motd', e.currentTarget.value)}
                                />
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Server Port</div>
                                </div>
                                <input
                                    type="number"
                                    class="server-prop-number"
                                    value={properties()['server-port'] ?? '25565'}
                                    min="1024"
                                    max="65535"
                                    onChange={(e) => updateProperty('server-port', e.currentTarget.value)}
                                />
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Online Mode</div>
                                    <div class="setting-card-desc">Disable for offline/bot connections</div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={properties()['online-mode'] === 'true'}
                                        onChange={(e) => updateProperty('online-mode', e.currentTarget.checked ? 'true' : 'false')}
                                    />
                                    <span class="toggle-slider" />
                                </label>
                            </div>
                        </div>
                    </div>

                    <div class="server-section-group">
                        <div class="section-title">World</div>
                        <div class="setting-card-list">
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Spawn Monsters</div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={properties()['spawn-monsters'] !== 'false'}
                                        onChange={(e) => updateProperty('spawn-monsters', e.currentTarget.checked ? 'true' : 'false')}
                                    />
                                    <span class="toggle-slider" />
                                </label>
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Spawn Animals</div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={properties()['spawn-animals'] !== 'false'}
                                        onChange={(e) => updateProperty('spawn-animals', e.currentTarget.checked ? 'true' : 'false')}
                                    />
                                    <span class="toggle-slider" />
                                </label>
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Allow Flight</div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={properties()['allow-flight'] === 'true'}
                                        onChange={(e) => updateProperty('allow-flight', e.currentTarget.checked ? 'true' : 'false')}
                                    />
                                    <span class="toggle-slider" />
                                </label>
                            </div>
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Command Blocks</div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={properties()['enable-command-block'] !== 'false'}
                                        onChange={(e) => updateProperty('enable-command-block', e.currentTarget.checked ? 'true' : 'false')}
                                    />
                                    <span class="toggle-slider" />
                                </label>
                            </div>
                        </div>
                    </div>

                    <Show when={propsChanged()}>
                        <div class="server-props-save">
                            <button
                                class="btn btn-connect"
                                onClick={() => void handleSaveProperties()}
                                disabled={savingProps()}
                            >
                                {savingProps() ? 'Saving...' : 'Save Settings'}
                            </button>
                            <span class="server-hint">Restart the server for changes to take effect.</span>
                        </div>
                    </Show>
                </div>
            </Show>

            {/* Worlds Section */}
            <Show when={activeSection() === 'worlds'}>
                <div class="server-worlds-section">
                    <Show
                        when={worlds().length > 0}
                        fallback={<div class="server-empty-hint">No worlds found. Start the server to generate a world.</div>}
                    >
                        <div class="setting-card-list">
                            <For each={worlds()}>
                                {(world) => (
                                    <div class="setting-card">
                                        <div class="setting-card-info">
                                            <div class="setting-card-name">
                                                <i class="bi bi-globe-americas"></i> {world.name}
                                            </div>
                                            <div class="setting-card-desc">{world.directory}/</div>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </div>
            </Show>
        </Show>
        </div>
    );
}
