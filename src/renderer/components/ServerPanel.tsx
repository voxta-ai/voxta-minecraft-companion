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
import PluginBrowser from './PluginBrowser';
import type {
    ServerProperties,
    ServerConfig,
    WorldInfo,
    WorldBackup,
    ServerState as ServerStateType,
} from '../../shared/ipc-types';

type ServerSection = 'console' | 'properties' | 'plugins' | 'worlds';

function formatWorldSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function ServerPanel() {
    const [activeSection, setActiveSection] = createSignal<ServerSection>('worlds');
    const [commandInput, setCommandInput] = createSignal('');
    const [properties, setProperties] = createSignal<ServerProperties>({});
    const [worlds, setWorlds] = createSignal<WorldInfo[]>([]);
    const [propsChanged, setPropsChanged] = createSignal(false);
    const [savingProps, setSavingProps] = createSignal(false);
    const [availableVersions, setAvailableVersions] = createSignal<string[]>([]);
    const [selectedVersion, setSelectedVersion] = createSignal('');
    const [loadingVersions, setLoadingVersions] = createSignal(false);
    const [installedVersion, setInstalledVersion] = createSignal<string | null>(null);
    const [changingVersion, setChangingVersion] = createSignal(false);

    // Server config state
    const [memoryMb, setMemoryMb] = createSignal(1024);
    const [autoStart, setAutoStart] = createSignal(false);
    const [configChanged, setConfigChanged] = createSignal(false);
    const [savingConfig, setSavingConfig] = createSignal(false);

    // World management state
    const [renamingWorld, setRenamingWorld] = createSignal<string | null>(null);
    const [renameInput, setRenameInput] = createSignal('');
    const [deletingWorld, setDeletingWorld] = createSignal<string | null>(null);
    const [creatingWorld, setCreatingWorld] = createSignal(false);
    const [newWorldName, setNewWorldName] = createSignal('');
    const [worldBusy, setWorldBusy] = createSignal(false);
    const [worldError, setWorldError] = createSignal<string | null>(null);
    const [expandedBackups, setExpandedBackups] = createSignal<string | null>(null);
    const [backups, setBackups] = createSignal<WorldBackup[]>([]);
    const [restoringBackup, setRestoringBackup] = createSignal<string | null>(null);
    const [deletingBackup, setDeletingBackup] = createSignal<string | null>(null);

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
        const unsubConsole = window.api.onServerConsoleLine((line) => {
            addServerConsoleLine(line);
        });

        const unsubProgress = window.api.onServerSetupProgress((progress) => {
            setSetupProgress(progress);
        });

        // Load panel-specific data (server state is already tracked globally)
        void window.api.serverGetInstalledVersion().then((version) => {
            setInstalledVersion(version);
        });
        if (isInstalled()) {
            void loadServerData();
        } else {
            void fetchVersions();
        }

        onCleanup(() => {
            unsubConsole();
            unsubProgress();
        });
    });

    async function loadServerData(): Promise<void> {
        const [props, worldList, config] = await Promise.all([
            window.api.serverGetProperties(),
            window.api.serverGetWorlds(),
            window.api.serverGetConfig(),
        ]);
        setProperties(props);
        setWorlds(worldList);
        setMemoryMb(config.memoryMb);
        setAutoStart(config.autoStart);
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

    function handleResetDefaults(): void {
        setProperties({
            'difficulty': 'easy',
            'gamemode': 'survival',
            'max-players': '5',
            'motd': 'Voxta Test Server',
            'server-port': '25565',
            'online-mode': 'false',
            'spawn-monsters': 'true',
            'spawn-animals': 'true',
            'allow-flight': 'false',
            'enable-command-block': 'true',
        });
        setMemoryMb(1024);
        setAutoStart(false);
        setPropsChanged(true);
        setConfigChanged(true);
    }

    async function handleSaveConfig(): Promise<void> {
        setSavingConfig(true);
        try {
            await window.api.serverSaveConfig({ memoryMb: memoryMb(), autoStart: autoStart() });
            setConfigChanged(false);
        } catch (err) {
            console.error('Save config failed:', err);
        } finally {
            setSavingConfig(false);
        }
    }

    async function refreshWorlds(): Promise<void> {
        const worldList = await window.api.serverGetWorlds();
        setWorlds(worldList);
    }

    async function handleSetActiveWorld(worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverSetActiveWorld(worldName);
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Failed to set active world');
        } finally {
            setWorldBusy(false);
        }
    }

    function sanitizeWorldName(name: string): string {
        return name.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    }

    async function handleRenameWorld(): Promise<void> {
        const oldName = renamingWorld();
        const newName = sanitizeWorldName(renameInput());
        if (!oldName || !newName || newName === oldName) {
            setRenamingWorld(null);
            return;
        }
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverRenameWorld(oldName, newName);
            setRenamingWorld(null);
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Failed to rename world');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleDeleteWorld(worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverDeleteWorld(worldName);
            setDeletingWorld(null);
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Failed to delete world');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleCreateWorld(): Promise<void> {
        const name = sanitizeWorldName(newWorldName());
        if (!name) return;
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverCreateWorld(name);
            setCreatingWorld(false);
            setNewWorldName('');
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Failed to create world');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleBackupWorld(worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverBackupWorld(worldName);
            // Refresh backups if this world's backups are expanded
            if (expandedBackups() === worldName) {
                const list = await window.api.serverGetBackups(worldName);
                setBackups(list);
            }
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Backup failed');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleToggleBackups(worldName: string): Promise<void> {
        if (expandedBackups() === worldName) {
            setExpandedBackups(null);
            setBackups([]);
            return;
        }
        setExpandedBackups(worldName);
        const list = await window.api.serverGetBackups(worldName);
        setBackups(list);
    }

    async function handleRestoreBackup(backupId: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverRestoreBackup(backupId);
            setRestoringBackup(null);
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Restore failed');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleDeleteBackup(backupId: string, worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverDeleteBackup(backupId);
            setDeletingBackup(null);
            const list = await window.api.serverGetBackups(worldName);
            setBackups(list);
            if (list.length === 0) {
                setExpandedBackups(null);
            }
            await refreshWorlds();
        } catch (err) {
            setWorldError(err instanceof Error ? err.message : 'Delete backup failed');
        } finally {
            setWorldBusy(false);
        }
    }

    function formatBackupDate(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
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

    return (
        <div class={`server-panel ${activeSection() === 'plugins' ? 'server-panel-wide' : ''}`}>
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
                    class={`server-tab ${activeSection() === 'worlds' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveSection('worlds');
                        void refreshWorlds();
                    }}
                >
                    <i class="bi bi-globe-americas"></i> Worlds
                </button>
                <button
                    class={`server-tab ${activeSection() === 'console' ? 'active' : ''}`}
                    onClick={() => setActiveSection('console')}
                >
                    <i class="bi bi-terminal"></i> Console
                </button>
                <button
                    class={`server-tab ${activeSection() === 'plugins' ? 'active' : ''}`}
                    onClick={() => setActiveSection('plugins')}
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
                <PluginBrowser />
            </Show>

            {/* Properties Section */}
            <Show when={activeSection() === 'properties'}>
                <div class="server-properties-section">
                    <Show when={serverState() === 'running'}>
                        <div class="server-hint">Changes require a server restart to take effect.</div>
                    </Show>

                    <div class="server-section-group">
                        <div class="section-title">Startup</div>
                        <div class="setting-card-list">
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Auto-start server</div>
                                    <div class="setting-card-desc">
                                        Automatically start the server when connecting to Voxta
                                    </div>
                                </div>
                                <label class="toggle">
                                    <input
                                        type="checkbox"
                                        checked={autoStart()}
                                        onChange={(e) => {
                                            const checked = e.currentTarget.checked;
                                            setAutoStart(checked);
                                            void window.api.serverSaveConfig({
                                                memoryMb: memoryMb(),
                                                autoStart: checked,
                                            });
                                        }}
                                    />
                                    <span class="toggle-slider"></span>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div class="server-section-group">
                        <div class="section-title">Performance</div>
                        <div class="setting-card-list">
                            <div class="setting-card setting-card-column">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Server Memory (RAM)</div>
                                    <div class="setting-card-desc">
                                        More memory allows larger worlds and more plugins
                                    </div>
                                </div>
                                <div class="memory-slider-row">
                                    <input
                                        type="range"
                                        class="memory-slider"
                                        min="512"
                                        max="8192"
                                        step="512"
                                        value={memoryMb()}
                                        onInput={(e) => {
                                            setMemoryMb(parseInt(e.currentTarget.value, 10));
                                            setConfigChanged(true);
                                        }}
                                    />
                                    <span class="memory-value">
                                        {memoryMb() >= 1024 ? `${(memoryMb() / 1024).toFixed(memoryMb() % 1024 === 0 ? 0 : 1)} GB` : `${memoryMb()} MB`}
                                    </span>
                                </div>
                                <div class="memory-labels">
                                    <span>512 MB</span>
                                    <span>8 GB</span>
                                </div>
                            </div>
                        </div>
                    </div>

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

                    <div class="server-section-group">
                        <div class="setting-card-list">
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">Reset to Defaults</div>
                                    <div class="setting-card-desc">Restore all settings to their original values</div>
                                </div>
                                <button
                                    class="server-reset-btn"
                                    onClick={handleResetDefaults}
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="server-props-save">
                        <button
                            class="btn btn-connect"
                            onClick={() => {
                                if (propsChanged()) void handleSaveProperties();
                                if (configChanged()) void handleSaveConfig();
                            }}
                            disabled={savingProps() || savingConfig() || (!propsChanged() && !configChanged())}
                        >
                            {savingProps() || savingConfig() ? 'Saving...' : 'Save Settings'}
                        </button>
                        <Show when={propsChanged() || configChanged()}>
                            <span class="server-hint">Restart the server for changes to take effect.</span>
                        </Show>
                    </div>
                </div>
            </Show>

            {/* Worlds Section */}
            <Show when={activeSection() === 'worlds'}>
                <div class="server-worlds-section">
                    {/* Error banner */}
                    <Show when={worldError()}>
                        <div class="world-error">
                            <i class="bi bi-exclamation-triangle"></i> {worldError()}
                            <button class="world-error-dismiss" onClick={() => setWorldError(null)}>
                                <i class="bi bi-x"></i>
                            </button>
                        </div>
                    </Show>

                    {/* Toolbar */}
                    <div class="world-toolbar">
                        <Show
                            when={!creatingWorld()}
                            fallback={
                                <div class="world-create-form">
                                    <input
                                        type="text"
                                        class="world-name-input"
                                        placeholder="Enter world name..."
                                        value={newWorldName()}
                                        onInput={(e) => setNewWorldName(e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') void handleCreateWorld();
                                            if (e.key === 'Escape') { setCreatingWorld(false); setNewWorldName(''); }
                                        }}
                                        disabled={worldBusy()}
                                        autofocus
                                    />
                                    <button
                                        class="btn btn-connect world-create-confirm"
                                        onClick={() => void handleCreateWorld()}
                                        disabled={worldBusy() || !newWorldName().trim()}
                                    >
                                        Create
                                    </button>
                                    <button
                                        class="world-action-cancel"
                                        onClick={() => { setCreatingWorld(false); setNewWorldName(''); }}
                                        disabled={worldBusy()}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            }
                        >
                            <button
                                class="world-new-btn"
                                onClick={() => { setCreatingWorld(true); setWorldError(null); }}
                                disabled={serverState() === 'running' || serverState() === 'starting'}
                                title={serverState() === 'running' ? 'Stop the server first' : 'Create a new world'}
                            >
                                <i class="bi bi-plus-lg"></i> New World
                            </button>
                        </Show>
                    </div>

                    <Show when={serverState() === 'running' || serverState() === 'starting'}>
                        <div class="server-hint world-running-hint">
                            <i class="bi bi-info-circle"></i> Stop the server to manage worlds.
                        </div>
                    </Show>

                    <Show
                        when={worlds().length > 0}
                        fallback={<div class="server-empty-hint">No worlds found. Start the server to generate a world.</div>}
                    >
                        <div class="world-list">
                            <For each={worlds()}>
                                {(world) => (<>
                                    <div
                                        class={`world-card ${world.isActive ? 'world-card-active' : ''}`}
                                        onClick={() => {
                                            if (!world.isActive && serverState() !== 'running' && serverState() !== 'starting' && !worldBusy() && !deletingWorld() && !renamingWorld()) {
                                                void handleSetActiveWorld(world.name);
                                            }
                                        }}
                                    >
                                        {/* Delete confirmation overlay */}
                                        <Show when={deletingWorld() === world.name}>
                                            <div class="world-delete-confirm">
                                                <div class="world-delete-confirm-text">
                                                    <i class="bi bi-exclamation-triangle"></i>
                                                    Delete <strong>{world.name}</strong> permanently?
                                                </div>
                                                <div class="world-delete-confirm-actions">
                                                    <button
                                                        class="btn btn-disconnect world-delete-yes"
                                                        onClick={(e) => { e.stopPropagation(); void handleDeleteWorld(world.name); }}
                                                        disabled={worldBusy()}
                                                    >
                                                        {worldBusy() ? 'Deleting...' : 'Delete'}
                                                    </button>
                                                    <button
                                                        class="world-action-cancel"
                                                        onClick={(e) => { e.stopPropagation(); setDeletingWorld(null); }}
                                                        disabled={worldBusy()}
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        </Show>

                                        {/* Normal card content */}
                                        <Show when={deletingWorld() !== world.name}>
                                            <div class="world-card-left">
                                                <div class={`world-radio ${world.isActive ? 'world-radio-active' : ''}`}>
                                                    <div class="world-radio-dot" />
                                                </div>
                                                <div class="world-card-info">
                                                    <Show
                                                        when={renamingWorld() !== world.name}
                                                        fallback={
                                                            <div class="world-rename-form" onClick={(e) => e.stopPropagation()}>
                                                                <input
                                                                    type="text"
                                                                    class="world-name-input"
                                                                    value={renameInput()}
                                                                    onInput={(e) => setRenameInput(e.currentTarget.value)}
                                                                    onKeyDown={(e) => {
                                                                        if (e.key === 'Enter') void handleRenameWorld();
                                                                        if (e.key === 'Escape') setRenamingWorld(null);
                                                                    }}
                                                                    disabled={worldBusy()}
                                                                    autofocus
                                                                />
                                                                <button
                                                                    class="world-rename-save"
                                                                    onClick={() => void handleRenameWorld()}
                                                                    disabled={worldBusy() || !renameInput().trim()}
                                                                    title="Save"
                                                                >
                                                                    <i class="bi bi-check-lg"></i>
                                                                </button>
                                                                <button
                                                                    class="world-rename-cancel"
                                                                    onClick={() => setRenamingWorld(null)}
                                                                    disabled={worldBusy()}
                                                                    title="Cancel"
                                                                >
                                                                    <i class="bi bi-x-lg"></i>
                                                                </button>
                                                            </div>
                                                        }
                                                    >
                                                        <div class="world-card-name">
                                                            {world.name}
                                                            <Show when={world.isActive && serverState() === 'running'}>
                                                                <span class="world-live-tag">Live</span>
                                                            </Show>
                                                        </div>
                                                        <div class="world-card-meta">
                                                            <Show
                                                                when={world.sizeBytes > 0}
                                                                fallback={
                                                                    <span class="world-card-pending">
                                                                        <i class="bi bi-clock"></i> Will be generated on next start
                                                                    </span>
                                                                }
                                                            >
                                                                <span class="world-card-size">
                                                                    <i class="bi bi-hdd"></i> {formatWorldSize(world.sizeBytes)}
                                                                </span>
                                                            </Show>
                                                        </div>
                                                    </Show>
                                                </div>
                                            </div>
                                            <div class="world-card-actions">
                                                <Show when={world.sizeBytes > 0}>
                                                    <button
                                                        class="world-action-btn"
                                                        onClick={(e) => { e.stopPropagation(); void handleBackupWorld(world.name); }}
                                                        disabled={worldBusy()}
                                                        title="Backup world"
                                                    >
                                                        <i class="bi bi-download"></i>
                                                    </button>
                                                </Show>
                                                <Show when={world.backupCount > 0}>
                                                    <button
                                                        class={`world-action-btn ${expandedBackups() === world.name ? 'world-action-btn-active' : ''}`}
                                                        onClick={(e) => { e.stopPropagation(); void handleToggleBackups(world.name); }}
                                                        disabled={worldBusy()}
                                                        title={`${world.backupCount} backup${world.backupCount > 1 ? 's' : ''}`}
                                                    >
                                                        <i class="bi bi-clock-history"></i>
                                                    </button>
                                                </Show>
                                                <Show when={serverState() !== 'running' && serverState() !== 'starting'}>
                                                    <button
                                                        class="world-action-btn"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setRenamingWorld(world.name);
                                                            setRenameInput(world.name);
                                                            setWorldError(null);
                                                        }}
                                                        disabled={worldBusy()}
                                                        title="Rename world"
                                                    >
                                                        <i class="bi bi-pencil"></i>
                                                    </button>
                                                    <button
                                                        class="world-action-btn world-delete-btn"
                                                        onClick={(e) => { e.stopPropagation(); setDeletingWorld(world.name); setWorldError(null); }}
                                                        disabled={worldBusy()}
                                                        title="Delete world"
                                                    >
                                                        <i class="bi bi-trash3"></i>
                                                    </button>
                                                </Show>
                                            </div>
                                        </Show>
                                    </div>
                                    {/* Backup list */}
                                    <Show when={expandedBackups() === world.name}>
                                        <div class="world-backup-list" onClick={(e) => e.stopPropagation()}>
                                            <div class="world-backup-header">
                                                <i class="bi bi-clock-history"></i> Backups
                                            </div>
                                            <Show
                                                when={backups().length > 0}
                                                fallback={<div class="world-backup-empty">No backups yet</div>}
                                            >
                                                <For each={backups()}>
                                                    {(backup) => (
                                                        <div class="world-backup-row">
                                                            <Show
                                                                when={restoringBackup() !== backup.id && deletingBackup() !== backup.id}
                                                                fallback={
                                                                    <div class="world-backup-confirm">
                                                                        <span class="world-backup-confirm-text">
                                                                            {restoringBackup() === backup.id ? 'Restore this backup?' : 'Delete this backup?'}
                                                                        </span>
                                                                        <button
                                                                            class={`world-backup-confirm-btn ${restoringBackup() === backup.id ? 'world-backup-restore-btn' : 'world-backup-delete-confirm-btn'}`}
                                                                            onClick={() => {
                                                                                if (restoringBackup() === backup.id) void handleRestoreBackup(backup.id);
                                                                                else void handleDeleteBackup(backup.id, world.name);
                                                                            }}
                                                                            disabled={worldBusy()}
                                                                        >
                                                                            {worldBusy() ? '...' : restoringBackup() === backup.id ? 'Restore' : 'Delete'}
                                                                        </button>
                                                                        <button
                                                                            class="world-backup-cancel-btn"
                                                                            onClick={() => { setRestoringBackup(null); setDeletingBackup(null); }}
                                                                            disabled={worldBusy()}
                                                                        >
                                                                            Cancel
                                                                        </button>
                                                                    </div>
                                                                }
                                                            >
                                                                <div class="world-backup-info">
                                                                    <span class="world-backup-date">{formatBackupDate(backup.timestamp)}</span>
                                                                    <span class="world-backup-size">{formatWorldSize(backup.sizeBytes)}</span>
                                                                </div>
                                                                <div class="world-backup-actions">
                                                                    <Show when={serverState() !== 'running' && serverState() !== 'starting'}>
                                                                        <button
                                                                            class="world-backup-action"
                                                                            onClick={() => setRestoringBackup(backup.id)}
                                                                            disabled={worldBusy()}
                                                                            title="Restore this backup"
                                                                        >
                                                                            <i class="bi bi-arrow-counterclockwise"></i>
                                                                        </button>
                                                                    </Show>
                                                                    <button
                                                                        class="world-backup-action world-backup-action-delete"
                                                                        onClick={() => setDeletingBackup(backup.id)}
                                                                        disabled={worldBusy()}
                                                                        title="Delete backup"
                                                                    >
                                                                        <i class="bi bi-trash3"></i>
                                                                    </button>
                                                                </div>
                                                            </Show>
                                                        </div>
                                                    )}
                                                </For>
                                            </Show>
                                        </div>
                                    </Show>
                                </>)}
                            </For>
                        </div>
                    </Show>
                </div>
            </Show>
        </Show>
        </div>
    );
}
