import { createSignal, createEffect, Show } from 'solid-js';
import type { Accessor } from 'solid-js';
import { isInstalled, serverPort as managedServerPort } from '../stores/server-store';
import ServerSetup from './server/ServerSetup';
import ServerStatusBar from './server/ServerStatusBar';
import WorldsSection from './server/WorldsSection';
import { useServerSetup } from './server/use-server-setup';
import type { WorldInfo } from '../../shared/ipc-types';

interface ServerStepProps {
    useCustomServer: Accessor<boolean>;
    setUseCustomServer: (custom: boolean) => void;
    mcHost: Accessor<string>;
    setMcHost: (host: string) => void;
    mcPort: Accessor<string>;
    setMcPort: (port: string) => void;
    mcVersion: Accessor<string>;
    setMcVersion: (version: string) => void;
}

/**
 * Connection wizard step for the Minecraft server: the built-in server (setup, start/stop,
 * world selection) or the address of the user's own server.
 */
export default function ServerStep(props: ServerStepProps) {
    const [worlds, setWorlds] = createSignal<WorldInfo[]>([]);
    const {
        availableVersions,
        selectedVersion,
        setSelectedVersion,
        loadingVersions,
        installedVersion,
        fetchVersions,
        runSetup,
    } = useServerSetup();

    async function refreshWorlds(): Promise<void> {
        setWorlds(await window.api.serverGetWorlds());
    }

    createEffect(() => {
        if (props.useCustomServer()) return;
        if (isInstalled()) {
            void refreshWorlds();
        } else if (availableVersions().length === 0) {
            void fetchVersions();
        }
    });

    return (
        <div class="connection-section">
            <div class="section-title">Minecraft server</div>
            <div class="connection-fields">
                <div class="field full-width">
                    <div class="server-mode">
                        <button
                            type="button"
                            class="server-mode-btn"
                            classList={{ active: !props.useCustomServer() }}
                            onClick={() => props.setUseCustomServer(false)}
                        >
                            Built-in
                        </button>
                        <button
                            type="button"
                            class="server-mode-btn"
                            classList={{ active: props.useCustomServer() }}
                            onClick={() => props.setUseCustomServer(true)}
                        >
                            Custom
                        </button>
                    </div>
                    <span class="field-hint">
                        {props.useCustomServer()
                            ? 'Connect the bot to your own Minecraft server. It must run Minecraft 26.1 or older; add ViaVersion to it so newer game versions can join.'
                            : "Use this app's built-in server. Pick the world you and your companion will play in."}
                    </span>
                </div>

                <Show when={!props.useCustomServer()}>
                    <div class="field full-width">
                        <Show
                            when={isInstalled()}
                            fallback={
                                <ServerSetup
                                    availableVersions={availableVersions}
                                    selectedVersion={selectedVersion}
                                    setSelectedVersion={setSelectedVersion}
                                    loadingVersions={loadingVersions}
                                    onSetup={() => void runSetup()}
                                />
                            }
                        >
                            <ServerStatusBar installedVersion={installedVersion} hideStart />
                            <WorldsSection worlds={worlds} refreshWorlds={refreshWorlds} />
                        </Show>
                    </div>
                </Show>

                <Show when={props.useCustomServer()}>
                    <div class="field">
                        <label>Server Host</label>
                        <input
                            type="text"
                            value={props.mcHost()}
                            onInput={(e) => props.setMcHost(e.currentTarget.value)}
                            placeholder="localhost"
                        />
                    </div>
                    <div class="field">
                        <label>Server Port</label>
                        <input
                            type="text"
                            value={props.mcPort()}
                            onInput={(e) => props.setMcPort(e.currentTarget.value)}
                            placeholder={`Default: ${managedServerPort()}`}
                        />
                    </div>
                    <div class="field">
                        <label>Game Version</label>
                        <input
                            type="text"
                            value={props.mcVersion()}
                            onInput={(e) => props.setMcVersion(e.currentTarget.value)}
                            placeholder="Auto-detect"
                        />
                        <span class="field-hint">Leave empty to auto-detect from server</span>
                    </div>
                </Show>
            </div>
        </div>
    );
}
