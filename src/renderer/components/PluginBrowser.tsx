import { createSignal, createEffect, Show, For, onMount } from 'solid-js';
import { marked } from 'marked';
import { serverState } from '../stores/server-store';
import { addToast } from '../stores/toast-store';
import type {
    HangarProject,
    HangarProjectDetail,
    HangarVersion,
    PluginInfo,
    PluginUpdateInfo,
} from '../../shared/ipc-types';

type PluginTab = 'browse' | 'installed';

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

function formatDownloads(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function formatCategory(cat: string): string {
    return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function compareMcVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function formatVersionRange(versions: string[]): string {
    if (versions.length <= 2) return versions.join(', ');
    const sorted = [...versions].sort(compareMcVersions);
    return `${sorted[0]} – ${sorted[sorted.length - 1]}`;
}

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PluginBrowser() {
    const [activeTab, setActiveTab] = createSignal<PluginTab>('browse');
    const [searchQuery, setSearchQuery] = createSignal('');
    const [searchResults, setSearchResults] = createSignal<HangarProject[]>([]);
    const [totalResults, setTotalResults] = createSignal(0);
    const [isSearching, setIsSearching] = createSignal(false);
    const [selectedProject, setSelectedProject] = createSignal<HangarProjectDetail | null>(null);
    const [selectedVersions, setSelectedVersions] = createSignal<HangarVersion[]>([]);
    const [loadingDetail, setLoadingDetail] = createSignal(false);
    const [installingVersion, setInstallingVersion] = createSignal<string | null>(null);
    const [installedPlugins, setInstalledPlugins] = createSignal<PluginInfo[]>([]);
    const [installedFileNames, setInstalledFileNames] = createSignal<Set<string>>(new Set());
    const [loadingMore, setLoadingMore] = createSignal(false);
    const [removingPlugin, setRemovingPlugin] = createSignal<string | null>(null);
    const [confirmRemove, setConfirmRemove] = createSignal<string | null>(null);
    const [pluginUpdates, setPluginUpdates] = createSignal<PluginUpdateInfo[]>([]);
    const [checkingUpdates, setCheckingUpdates] = createSignal(false);
    let searchTimeout: ReturnType<typeof setTimeout> | undefined;

    onMount(() => {
        // Load popular plugins on open
        void performSearch('');
        void refreshInstalled();
    });

    async function performSearch(query: string): Promise<void> {
        setIsSearching(true);
        setSelectedProject(null);
        try {
            const result = await window.api.hangarSearch(query);
            setSearchResults(result.result);
            setTotalResults(result.pagination.count);
        } catch (err) {
            console.error('Hangar search failed:', err);
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    }

    async function loadMore(): Promise<void> {
        if (loadingMore() || isSearching()) return;
        const current = searchResults();
        if (current.length >= totalResults()) return;
        setLoadingMore(true);
        try {
            const result = await window.api.hangarSearch(searchQuery(), current.length);
            setSearchResults([...current, ...result.result]);
            setTotalResults(result.pagination.count);
        } catch (err) {
            console.error('Load more failed:', err);
        } finally {
            setLoadingMore(false);
        }
    }

    function handleResultScroll(e: Event): void {
        const el = e.target as HTMLDivElement;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
            void loadMore();
        }
    }

    function handleSearchInput(value: string): void {
        setSearchQuery(value);
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            void performSearch(value);
        }, 400);
    }

    async function selectProject(project: HangarProject): Promise<void> {
        setLoadingDetail(true);
        try {
            const [detail, versions] = await Promise.all([
                window.api.hangarGetProject(project.namespace.owner, project.namespace.slug),
                window.api.hangarGetVersions(project.namespace.owner, project.namespace.slug),
            ]);
            // mainPageContent is in search results but null on project endpoint — use search data as fallback
            if (!detail.mainPageContent && project.mainPageContent) {
                detail.mainPageContent = project.mainPageContent;
            }
            setSelectedProject(detail);
            setSelectedVersions(versions);
        } catch (err) {
            console.error('Failed to load plugin details:', err);
        } finally {
            setLoadingDetail(false);
        }
    }

    async function handleInstall(version: HangarVersion): Promise<void> {
        const project = selectedProject();
        if (!project) return;
        setInstallingVersion(version.name);
        try {
            await window.api.hangarInstallPlugin(
                project.namespace.owner,
                project.namespace.slug,
                version.name,
            );
            await refreshInstalled();
            addToast('success', `Installed ${project.name} v${version.name}`);
        } catch (err) {
            addToast('error', `Failed to install plugin: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setInstallingVersion(null);
        }
    }

    async function handleRemove(fileName: string): Promise<void> {
        setRemovingPlugin(fileName);
        try {
            await window.api.serverRemovePlugin(fileName);
            setConfirmRemove(null);
            await refreshInstalled();
            addToast('success', `Removed ${fileName}`);
        } catch (err) {
            addToast('error', `Failed to remove plugin: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setRemovingPlugin(null);
        }
    }

    async function refreshInstalled(): Promise<void> {
        const plugins = await window.api.serverGetPlugins();
        setInstalledPlugins(plugins);
        setInstalledFileNames(new Set(plugins.map((p) => p.fileName)));
    }

    async function viewOnHangar(owner: string, slug: string): Promise<void> {
        setActiveTab('browse');
        setLoadingDetail(true);
        try {
            const [detail, versions] = await Promise.all([
                window.api.hangarGetProject(owner, slug),
                window.api.hangarGetVersions(owner, slug),
            ]);
            setSelectedProject(detail);
            setSelectedVersions(versions);
        } catch (err) {
            console.error('Failed to load plugin details:', err);
        } finally {
            setLoadingDetail(false);
        }
    }

    async function checkForUpdates(): Promise<void> {
        setCheckingUpdates(true);
        try {
            const updates = await window.api.checkPluginUpdates();
            setPluginUpdates(updates);
        } catch (err) {
            console.error('Failed to check plugin updates:', err);
        } finally {
            setCheckingUpdates(false);
        }
    }

    function getUpdateForPlugin(fileName: string): PluginUpdateInfo | undefined {
        return pluginUpdates().find((u) => u.fileName === fileName);
    }

    async function handleUpdate(update: PluginUpdateInfo): Promise<void> {
        setInstallingVersion(update.latestVersion);
        try {
            await window.api.hangarInstallPlugin(update.hangarOwner, update.hangarSlug, update.latestVersion);
            await refreshInstalled();
            // Re-check updates to clear the badge
            setPluginUpdates((prev) => prev.filter((u) => u.fileName !== update.fileName));
            addToast('success', `Updated to v${update.latestVersion}`);
        } catch (err) {
            addToast('error', `Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setInstallingVersion(null);
        }
    }

    function renderMarkdown(content: string): string {
        return marked.parse(content, { async: false }) as string;
    }

    return (
        <div class="plugin-browser">
            {/* Tab Bar */}
            <div class="plugin-tabs">
                <button
                    class={`plugin-tab ${activeTab() === 'browse' ? 'active' : ''}`}
                    onClick={() => setActiveTab('browse')}
                >
                    <i class="bi bi-shop"></i> Browse
                </button>
                <button
                    class={`plugin-tab ${activeTab() === 'installed' ? 'active' : ''}`}
                    onClick={() => {
                        setActiveTab('installed');
                        void refreshInstalled();
                    }}
                >
                    <i class="bi bi-box-seam"></i> Installed ({installedPlugins().length})
                </button>
            </div>

            {/* Browse Tab */}
            <Show when={activeTab() === 'browse'}>
                <div class="plugin-split">
                    {/* Left Panel: Search + Results */}
                    <div class="plugin-list-panel">
                        <div class="plugin-search">
                            <i class="bi bi-search"></i>
                            <input
                                type="text"
                                value={searchQuery()}
                                onInput={(e) => handleSearchInput(e.currentTarget.value)}
                                placeholder="Search plugins..."
                            />
                            <Show when={searchQuery()}>
                                <button
                                    class="plugin-search-clear"
                                    onClick={() => {
                                        setSearchQuery('');
                                        void performSearch('');
                                    }}
                                >
                                    <i class="bi bi-x"></i>
                                </button>
                            </Show>
                        </div>

                        <div class="plugin-result-count">
                            <Show when={!isSearching()} fallback={<span>Searching...</span>}>
                                <span>{totalResults()} plugins</span>
                            </Show>
                        </div>

                        <div class="plugin-result-list" onScroll={handleResultScroll}>
                            <For each={searchResults()}>
                                {(project) => (
                                    <button
                                        class={`plugin-result-card ${
                                            selectedProject()?.namespace.slug === project.namespace.slug
                                                ? 'selected'
                                                : ''
                                        }`}
                                        onClick={() => void selectProject(project)}
                                    >
                                        <img
                                            class="plugin-result-icon"
                                            src={project.avatarUrl}
                                            alt=""
                                            loading="lazy"
                                        />
                                        <div class="plugin-result-info">
                                            <div class="plugin-result-name">{project.name}</div>
                                            <div class="plugin-result-desc">{project.description}</div>
                                            <div class="plugin-result-meta">
                                                <span><i class="bi bi-download"></i> {formatDownloads(project.stats.downloads)}</span>
                                                <span><i class="bi bi-star"></i> {project.stats.stars}</span>
                                            </div>
                                        </div>
                                    </button>
                                )}
                            </For>
                            <Show when={!isSearching() && searchResults().length === 0}>
                                <div class="plugin-empty">No plugins found.</div>
                            </Show>
                            <Show when={loadingMore()}>
                                <div class="plugin-loading-more">Loading more...</div>
                            </Show>
                        </div>
                    </div>

                    {/* Right Panel: Detail */}
                    <div class="plugin-detail-panel">
                        <Show
                            when={selectedProject()}
                            fallback={
                                <div class="plugin-detail-empty">
                                    <i class="bi bi-puzzle"></i>
                                    <p>Select a plugin to see details</p>
                                </div>
                            }
                        >
                            {(project) => (
                                <Show when={!loadingDetail()} fallback={<div class="plugin-detail-loading">Loading...</div>}>
                                    <div class="plugin-detail-content">
                                        {/* Header */}
                                        <div class="plugin-detail-header">
                                            <img
                                                class="plugin-detail-icon"
                                                src={project().avatarUrl}
                                                alt=""
                                            />
                                            <div class="plugin-detail-title">
                                                <h3>{project().name}</h3>
                                                <div class="plugin-detail-author">
                                                    by {project().namespace.owner}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Stats */}
                                        <div class="plugin-detail-stats">
                                            <span><i class="bi bi-download"></i> {formatDownloads(project().stats.downloads)} downloads</span>
                                            <span><i class="bi bi-star"></i> {project().stats.stars} stars</span>
                                            <span class="plugin-detail-category">
                                                {formatCategory(project().category)}
                                            </span>
                                        </div>

                                        {/* Versions / Install */}
                                        <Show when={selectedVersions().length > 0}>
                                            <div class="plugin-detail-versions">
                                                <div class="plugin-detail-section-title">Versions</div>
                                                <div class="plugin-version-list">
                                                    <For each={selectedVersions()}>
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
                                                                    fallback={
                                                                        <span class="plugin-version-external">External</span>
                                                                    }
                                                                >
                                                                    <Show
                                                                        when={!installedFileNames().has(version.downloads['PAPER']?.fileInfo?.name ?? '')}
                                                                        fallback={
                                                                            <span class="plugin-installed-badge">
                                                                                <i class="bi bi-check-circle-fill"></i> Installed
                                                                            </span>
                                                                        }
                                                                    >
                                                                        <button
                                                                            class="btn btn-connect plugin-install-btn"
                                                                            onClick={() => void handleInstall(version)}
                                                                            disabled={
                                                                                installingVersion() === version.name ||
                                                                                serverState() === 'running'
                                                                            }
                                                                        >
                                                                            {installingVersion() === version.name ? 'Installing...' : 'Install'}
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
                                                innerHTML={renderMarkdown(project().mainPageContent ?? '')}
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
                </div>
            </Show>

            {/* Installed Tab */}
            <Show when={activeTab() === 'installed'}>
                <div class="plugin-installed-list">
                    <div class="plugin-update-toolbar">
                        <button
                            class="btn btn-sm plugin-check-updates-btn"
                            onClick={() => void checkForUpdates()}
                            disabled={checkingUpdates() || installedPlugins().length === 0}
                        >
                            <i class={`bi ${checkingUpdates() ? 'bi-arrow-repeat spinning' : 'bi-arrow-repeat'}`}></i>
                            {checkingUpdates() ? 'Checking...' : 'Check for Updates'}
                        </button>
                        <Show when={pluginUpdates().length > 0}>
                            <span class="plugin-update-count">
                                {pluginUpdates().length} update{pluginUpdates().length > 1 ? 's' : ''} available
                            </span>
                        </Show>
                    </div>
                    <Show
                        when={installedPlugins().length > 0}
                        fallback={<div class="plugin-empty">No plugins installed yet.</div>}
                    >
                        <For each={installedPlugins()}>
                            {(plugin) => {
                                const update = (): PluginUpdateInfo | undefined => getUpdateForPlugin(plugin.fileName);
                                return (
                                    <div class="setting-card">
                                        <Show
                                            when={confirmRemove() !== plugin.fileName}
                                            fallback={
                                                <div class="plugin-remove-confirm">
                                                    <span class="plugin-remove-confirm-text">
                                                        Remove <strong>{plugin.name}</strong>?
                                                    </span>
                                                    <button
                                                        class="plugin-remove-confirm-btn"
                                                        onClick={() => void handleRemove(plugin.fileName)}
                                                        disabled={removingPlugin() === plugin.fileName || serverState() === 'running'}
                                                    >
                                                        {removingPlugin() === plugin.fileName ? 'Removing...' : 'Remove'}
                                                    </button>
                                                    <button
                                                        class="plugin-remove-cancel-btn"
                                                        onClick={() => setConfirmRemove(null)}
                                                        disabled={removingPlugin() === plugin.fileName}
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
                                                            onClick={() => void viewOnHangar(plugin.hangarOwner!, plugin.hangarSlug!)}
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
                                                                    {' '}— requires MC {formatVersionRange(upd().supportedMcVersions)}
                                                                </Show>
                                                            </span>
                                                            <button
                                                                class={`btn btn-sm plugin-update-btn ${upd().compatible ? '' : 'plugin-update-btn-warn'}`}
                                                                onClick={() => void handleUpdate(upd())}
                                                                disabled={
                                                                    installingVersion() === upd().latestVersion ||
                                                                    serverState() === 'running'
                                                                }
                                                                title={!upd().compatible ? 'This version may not be compatible with your server' : ''}
                                                            >
                                                                {installingVersion() === upd().latestVersion
                                                                    ? 'Updating...'
                                                                    : upd().compatible ? 'Update' : 'Update Anyway'}
                                                            </button>
                                                        </div>
                                                    )}
                                                </Show>
                                            </div>
                                            <button
                                                class="server-plugin-remove-btn"
                                                onClick={() => setConfirmRemove(plugin.fileName)}
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
            </Show>
        </div>
    );
}
