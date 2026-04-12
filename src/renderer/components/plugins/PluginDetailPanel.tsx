import { Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import type { HangarProjectDetail, HangarVersion } from '../../../shared/ipc-types';
import { formatDownloads, formatCategory, formatVersionRange, formatFileSize } from './plugin-utils';

interface PluginDetailPanelProps {
    selectedProject: Accessor<HangarProjectDetail | null>;
    selectedVersions: Accessor<HangarVersion[]>;
    loadingDetail: Accessor<boolean>;
    installingVersion: Accessor<string | null>;
    installedFileNames: Accessor<Set<string>>;
    onInstall: (version: HangarVersion) => void;
    renderMarkdown: (content: string) => string;
}

export default function PluginDetailPanel(props: PluginDetailPanelProps) {
    return (
        <div class="plugin-detail-panel">
            <Show
                when={props.selectedProject()}
                fallback={
                    <div class="plugin-detail-empty">
                        <i class="bi bi-puzzle"></i>
                        <p>Select a plugin to see details</p>
                    </div>
                }
            >
                {(project) => (
                    <Show when={!props.loadingDetail()} fallback={<div class="plugin-detail-loading">Loading...</div>}>
                        <div class="plugin-detail-content">
                            {/* Header */}
                            <div class="plugin-detail-header">
                                <img class="plugin-detail-icon" src={project().avatarUrl} alt="" />
                                <div class="plugin-detail-title">
                                    <h3>{project().name}</h3>
                                    <div class="plugin-detail-author">by {project().namespace.owner}</div>
                                </div>
                            </div>

                            {/* Stats */}
                            <div class="plugin-detail-stats">
                                <span><i class="bi bi-download"></i> {formatDownloads(project().stats.downloads)} downloads</span>
                                <span><i class="bi bi-star"></i> {project().stats.stars} stars</span>
                                <span class="plugin-detail-category">{formatCategory(project().category)}</span>
                            </div>

                            {/* Versions / Install */}
                            <Show when={props.selectedVersions().length > 0}>
                                <div class="plugin-detail-versions">
                                    <div class="plugin-detail-section-title">Versions</div>
                                    <div class="plugin-version-list">
                                        <For each={props.selectedVersions()}>
                                            {(version) => (
                                                <div class="plugin-version-row">
                                                    <div class="plugin-version-info">
                                                        <span
                                                            class="plugin-version-badge"
                                                            style={{ 'border-color': version.channel.color }}
                                                        >
                                                            {version.name}
                                                        </span>
                                                        <span class="plugin-version-channel">{version.channel.name}</span>
                                                        <Show when={version.downloads['PAPER']?.fileInfo}>
                                                            <span class="plugin-version-size">
                                                                {formatFileSize(version.downloads['PAPER']?.fileInfo?.sizeBytes ?? 0)}
                                                            </span>
                                                        </Show>
                                                        <Show when={version.platformDependencies?.['PAPER']?.length}>
                                                            <span class="plugin-version-mc">
                                                                MC {formatVersionRange(version.platformDependencies['PAPER'])}
                                                            </span>
                                                        </Show>
                                                    </div>
                                                    <Show
                                                        when={version.downloads['PAPER']?.downloadUrl}
                                                        fallback={<span class="plugin-version-external">External</span>}
                                                    >
                                                        <Show
                                                            when={!props.installedFileNames().has(version.downloads['PAPER']?.fileInfo?.name ?? '')}
                                                            fallback={
                                                                <span class="plugin-installed-badge">
                                                                    <i class="bi bi-check-circle-fill"></i> Installed
                                                                </span>
                                                            }
                                                        >
                                                            <button
                                                                class="btn btn-connect plugin-install-btn"
                                                                onClick={() => props.onInstall(version)}
                                                                disabled={
                                                                    props.installingVersion() === version.name ||
                                                                    serverState() === 'running'
                                                                }
                                                            >
                                                                {props.installingVersion() === version.name ? 'Installing...' : 'Install'}
                                                            </button>
                                                        </Show>
                                                    </Show>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                    <Show when={serverState() === 'running'}>
                                        <div class="server-hint">Stop the server to install plugins.</div>
                                    </Show>
                                </div>
                            </Show>

                            {/* Description */}
                            <Show when={project().mainPageContent}>
                                <div class="plugin-detail-section-title">Description</div>
                                <div
                                    class="plugin-detail-description"
                                    innerHTML={props.renderMarkdown(project().mainPageContent ?? '')}
                                />
                            </Show>
                            <Show when={!project().mainPageContent && project().description}>
                                <div class="plugin-detail-section-title">Description</div>
                                <p class="plugin-detail-short-desc">{project().description}</p>
                            </Show>
                        </div>
                    </Show>
                )}
            </Show>
        </div>
    );
}
