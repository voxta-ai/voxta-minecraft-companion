import { Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { setupProgress, isSettingUp } from '../../stores/server-store';

interface ServerSetupProps {
    availableVersions: Accessor<string[]>;
    selectedVersion: Accessor<string>;
    setSelectedVersion: (v: string) => void;
    loadingVersions: Accessor<boolean>;
    onSetup: () => void;
}

export default function ServerSetup(props: ServerSetupProps) {
    return (
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
                        when={!props.loadingVersions() && props.availableVersions().length > 0}
                        fallback={
                            <span class="server-version-loading">
                                {props.loadingVersions() ? 'Loading versions...' : ''}
                            </span>
                        }
                    >
                        <select
                            class="server-version-select"
                            value={props.selectedVersion()}
                            onChange={(e) => props.setSelectedVersion(e.currentTarget.value)}
                            disabled={isSettingUp()}
                        >
                            <For each={props.availableVersions()}>
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
                onClick={props.onSetup}
                disabled={isSettingUp() || !props.selectedVersion()}
            >
                {isSettingUp() ? 'Setting up...' : `Download & Setup Server${props.selectedVersion() ? ` (${props.selectedVersion()})` : ''}`}
            </button>
        </div>
    );
}
