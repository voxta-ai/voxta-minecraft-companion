import { createSignal, onMount, Show } from 'solid-js';
import SetupProgressBar from './SetupProgressBar';
import { serverState, isInstalled, setupProgress, isSettingUp } from '../stores/server-store';
import { loadPropertiesAndConfig } from '../stores/server-properties-store';
import PluginBrowser from './PluginBrowser';
import ServerSetup from './server/ServerSetup';
import ServerStatusBar from './server/ServerStatusBar';
import TunnelSection from './server/TunnelSection';
import ConsoleSection from './server/ConsoleSection';
import PlayersSection from './server/PlayersSection';
import PropertiesSection from './server/PropertiesSection';
import WorldsSection from './server/WorldsSection';
import { useServerSetup } from './server/use-server-setup';
import type { WorldInfo } from '../../shared/ipc-types';

type ServerSection = 'console' | 'properties' | 'plugins' | 'worlds' | 'players';

export default function ServerPanel() {
    const [activeSection, setActiveSection] = createSignal<ServerSection>('worlds');
    const [worlds, setWorlds] = createSignal<WorldInfo[]>([]);
    const [changingVersion, setChangingVersion] = createSignal(false);
    const {
        availableVersions,
        selectedVersion,
        setSelectedVersion,
        loadingVersions,
        installedVersion,
        fetchVersions,
        runSetup,
    } = useServerSetup();

    onMount(() => {
        if (isInstalled()) {
            void loadServerData();
        } else {
            void fetchVersions();
        }
    });

    async function loadServerData(): Promise<void> {
        const [, worldList] = await Promise.all([
            loadPropertiesAndConfig(),
            window.api.serverGetWorlds(),
        ]);
        setWorlds(worldList);
    }

    async function handleSetup(): Promise<void> {
        if (await runSetup()) {
            setChangingVersion(false);
            void loadServerData();
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
            <ServerStatusBar
                installedVersion={installedVersion}
                actions={
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
                }
            />

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
                        <SetupProgressBar progress={setupProgress} />
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
                        void loadPropertiesAndConfig();
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
                <PlayersSection />
            </Show>

            <Show when={activeSection() === 'properties'}>
                <PropertiesSection />
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
