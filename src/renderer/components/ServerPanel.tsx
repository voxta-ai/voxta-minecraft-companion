import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import {
    serverState,
    serverPort,
    serverError,
    isInstalled,
    setIsInstalled,
    setupProgress,
    setSetupProgress,
    isSettingUp,
    setIsSettingUp,
} from '../stores/server-store';
import { addToast } from '../stores/toast-store';
import PluginBrowser from './PluginBrowser';
import ServerSetup from './server/ServerSetup';
import TunnelSection from './server/TunnelSection';
import ConsoleSection from './server/ConsoleSection';
import PlayersSection from './server/PlayersSection';
import PropertiesSection from './server/PropertiesSection';
import WorldsSection from './server/WorldsSection';
import type { ServerProperties, WorldInfo } from '../../shared/ipc-types';

type ServerSection = 'console' | 'properties' | 'plugins' | 'worlds' | 'players';

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

export default function ServerPanel() {
    const [activeSection, setActiveSection] = createSignal<ServerSection>('worlds');
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

    // Subscribe to IPC events
    onMount(() => {
        const unsubProgress = window.api.onServerSetupProgress((progress) => {
            setSetupProgress(progress);
        });

        void window.api.serverGetInstalledVersion().then((version) => {
            setInstalledVersion(version);
        });
        if (isInstalled()) {
            void loadServerData();
        } else {
            void fetchVersions();
        }

        onCleanup(() => {
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
                setSelectedVersion(versions[0]);
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

    async function handleStart(): Promise<void> {
        try {
            await window.api.serverStart();
        } catch (err) {
            addToast('error', `Failed to start server: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    async function handleStop(): Promise<void> {
        try {
            await window.api.serverStop();
        } catch (err) {
            addToast('error', `Failed to stop server: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
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
            addToast('success', 'Server properties saved');
        } catch (err) {
            addToast('error', `Failed to save properties: ${err instanceof Error ? err.message : 'Unknown error'}`);
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
            addToast('success', 'Server configuration saved');
        } catch (err) {
            addToast('error', `Failed to save config: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setSavingConfig(false);
        }
    }

    async function refreshWorlds(): Promise<void> {
        const worldList = await window.api.serverGetWorlds();
        setWorlds(worldList);
    }

    return (
        <div class={`server-panel ${activeSection() === 'plugins' ? 'server-panel-wide' : ''}`}>
        <Show
            when={isInstalled()}
            fallback={
                <ServerSetup
                    availableVersions={availableVersions}
                    selectedVersion={selectedVersion}
                    setSelectedVersion={setSelectedVersion}
                    loadingVersions={loadingVersions}
                    onSetup={() => void handleSetup()}
                />
            }
        >
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
                            onClick={() => {
                                setChangingVersion(true);
                                void fetchVersions();
                            }}
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
                            {availableVersions().map((version) => (
                                <option value={version}>{version}</option>
                            ))}
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

            {/* Sharing Section */}
            <Show when={serverState() === 'running'}>
                <TunnelSection />
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
                    class={`server-tab ${activeSection() === 'players' ? 'active' : ''}`}
                    onClick={() => setActiveSection('players')}
                >
                    <i class="bi bi-people"></i> Players
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

            {/* Tab Content */}
            <Show when={activeSection() === 'console'}>
                <ConsoleSection />
            </Show>

            <Show when={activeSection() === 'plugins'}>
                <PluginBrowser />
            </Show>

            <Show when={activeSection() === 'players'}>
                <PlayersSection
                    properties={properties}
                    setProperties={setProperties}
                />
            </Show>

            <Show when={activeSection() === 'properties'}>
                <PropertiesSection
                    properties={properties}
                    updateProperty={updateProperty}
                    propsChanged={propsChanged}
                    savingProps={savingProps}
                    onSaveProperties={() => void handleSaveProperties()}
                    onResetDefaults={handleResetDefaults}
                    memoryMb={memoryMb}
                    setMemoryMb={setMemoryMb}
                    autoStart={autoStart}
                    setAutoStart={setAutoStart}
                    configChanged={configChanged}
                    setConfigChanged={setConfigChanged}
                    savingConfig={savingConfig}
                    onSaveConfig={() => void handleSaveConfig()}
                />
            </Show>

            <Show when={activeSection() === 'worlds'}>
                <WorldsSection
                    worlds={worlds}
                    refreshWorlds={refreshWorlds}
                />
            </Show>
        </Show>
        </div>
    );
}
