import { Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import type { PluginInfo, PluginUpdateInfo } from '../../../shared/ipc-types';
import { formatVersionRange, formatFileSize } from './plugin-utils';

interface InstalledPluginsPanelProps {
    installedPlugins: Accessor<PluginInfo[]>;
    pluginUpdates: Accessor<PluginUpdateInfo[]>;
    checkingUpdates: Accessor<boolean>;
    removingPlugin: Accessor<string | null>;
    installingVersion: Accessor<string | null>;
    confirmRemove: Accessor<string | null>;
    setConfirmRemove: (fileName: string | null) => void;
    onCheckUpdates: () => void;
    onRemove: (fileName: string) => void;
    onUpdate: (update: PluginUpdateInfo) => void;
    onViewOnHangar: (owner: string, slug: string) => void;
    getUpdateForPlugin: (fileName: string) => PluginUpdateInfo | undefined;
}

export default function InstalledPluginsPanel(props: InstalledPluginsPanelProps) {
    return (
        <div class="plugin-installed-list">
            <div class="plugin-update-toolbar">
                <button
                    class="btn btn-sm plugin-check-updates-btn"
                    onClick={props.onCheckUpdates}
                    disabled={props.checkingUpdates() || props.installedPlugins().length === 0}
                >
                    <i class={`bi ${props.checkingUpdates() ? 'bi-arrow-repeat spinning' : 'bi-arrow-repeat'}`}></i>
                    {props.checkingUpdates() ? 'Checking...' : 'Check for Updates'}
                </button>
                <Show when={props.pluginUpdates().length > 0}>
                    <span class="plugin-update-count">
                        {props.pluginUpdates().length} update{props.pluginUpdates().length > 1 ? 's' : ''} available
                    </span>
                </Show>
            </div>
            <Show
                when={props.installedPlugins().length > 0}
                fallback={<div class="plugin-empty">No plugins installed yet.</div>}
            >
                <For each={props.installedPlugins()}>
                    {(plugin) => {
                        const update = (): PluginUpdateInfo | undefined => props.getUpdateForPlugin(plugin.fileName);
                        return (
                            <div class="setting-card">
                                <Show
                                    when={props.confirmRemove() !== plugin.fileName}
                                    fallback={
                                        <div class="plugin-remove-confirm">
                                            <span class="plugin-remove-confirm-text">
                                                Remove <strong>{plugin.name}</strong>?
                                            </span>
                                            <button
                                                class="plugin-remove-confirm-btn"
                                                onClick={() => props.onRemove(plugin.fileName)}
                                                disabled={props.removingPlugin() === plugin.fileName || serverState() === 'running'}
                                            >
                                                {props.removingPlugin() === plugin.fileName ? 'Removing...' : 'Remove'}
                                            </button>
                                            <button
                                                class="plugin-remove-cancel-btn"
                                                onClick={() => props.setConfirmRemove(null)}
                                                disabled={props.removingPlugin() === plugin.fileName}
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    }
                                >
                                    <div class="setting-card-info">
                                        <div class="setting-card-name">
                                            <Show
                                                when={plugin.hangarOwner && plugin.hangarSlug}
                                                fallback={<span>{plugin.name}</span>}
                                            >
                                                <button
                                                    class="plugin-name-link"
                                                    onClick={() => props.onViewOnHangar(plugin.hangarOwner!, plugin.hangarSlug!)}
                                                    title="View on Hangar"
                                                >
                                                    {plugin.name} <i class="bi bi-box-arrow-up-right"></i>
                                                </button>
                                            </Show>
                                            <Show when={plugin.installedVersion}>
                                                <span class="plugin-version-label">v{plugin.installedVersion}</span>
                                            </Show>
                                        </div>
                                        <div class="setting-card-desc">
                                            {plugin.fileName} ({formatFileSize(plugin.fileSize)})
                                            <Show when={!plugin.hangarOwner}>
                                                <span class="plugin-source-label">Manually installed</span>
                                            </Show>
                                        </div>
                                        <Show when={update()}>
                                            {(upd) => (
                                                <div class={`plugin-update-banner ${upd().compatible ? '' : 'incompatible'}`}>
                                                    <i class={`bi ${upd().compatible ? 'bi-arrow-up-circle-fill' : 'bi-exclamation-triangle-fill'}`}></i>
                                                    <span>
                                                        v{upd().latestVersion} available
                                                        <Show when={!upd().compatible}>
                                                            {' '} — requires MC {formatVersionRange(upd().supportedMcVersions)}
                                                        </Show>
                                                    </span>
                                                    <button
                                                        class={`btn btn-sm plugin-update-btn ${upd().compatible ? '' : 'plugin-update-btn-warn'}`}
                                                        onClick={() => props.onUpdate(upd())}
                                                        disabled={
                                                            props.installingVersion() === upd().latestVersion ||
                                                            serverState() === 'running'
                                                        }
                                                        title={!upd().compatible ? 'This version may not be compatible with your server' : ''}
                                                    >
                                                        {props.installingVersion() === upd().latestVersion
                                                            ? 'Updating...'
                                                            : upd().compatible ? 'Update' : 'Update Anyway'}
                                                    </button>
                                                </div>
                                            )}
                                        </Show>
                                    </div>
                                    <button
                                        class="server-plugin-remove-btn"
                                        onClick={() => props.setConfirmRemove(plugin.fileName)}
                                        disabled={serverState() === 'running'}
                                        title={serverState() === 'running' ? 'Stop the server first' : 'Remove plugin'}
                                    >
                                        <i class="bi bi-trash"></i>
                                    </button>
                                </Show>
                            </div>
                        );
                    }}
                </For>
            </Show>
            <Show when={serverState() === 'running'}>
                <div class="server-hint">Stop the server to manage plugins.</div>
            </Show>
        </div>
    );
}
