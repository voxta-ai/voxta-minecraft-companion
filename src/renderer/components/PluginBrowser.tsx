import { createSignal, Show, onMount } from 'solid-js';
import { marked } from 'marked';
import { addToast } from '../stores/toast-store';
import type {
    HangarProject,
    HangarProjectDetail,
    HangarVersion,
    PluginInfo,
    PluginUpdateInfo,
} from '../../shared/ipc-types';
import PluginSearchPanel from './plugins/PluginSearchPanel';
import PluginDetailPanel from './plugins/PluginDetailPanel';
import InstalledPluginsPanel from './plugins/InstalledPluginsPanel';

type PluginTab = 'browse' | 'installed';

// Configure marked for safe rendering
marked.setOptions({ breaks: true, gfm: true });

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
        void performSearch('');
        void refreshInstalled();
    });

    // ---- Data fetching ----

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

    async function refreshInstalled(): Promise<void> {
        const plugins = await window.api.serverGetPlugins();
        setInstalledPlugins(plugins);
        setInstalledFileNames(new Set(plugins.map((p) => p.fileName)));
    }

    // ---- Event handlers ----

    function handleSearchInput(value: string): void {
        setSearchQuery(value);
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => void performSearch(value), 400);
    }

    function handleClearSearch(): void {
        setSearchQuery('');
        void performSearch('');
    }

    function handleResultScroll(e: Event): void {
        const el = e.target as HTMLDivElement;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 50) {
            void loadMore();
        }
    }

    async function selectProject(project: HangarProject): Promise<void> {
        setLoadingDetail(true);
        try {
            const [detail, versions] = await Promise.all([
                window.api.hangarGetProject(project.namespace.owner, project.namespace.slug),
                window.api.hangarGetVersions(project.namespace.owner, project.namespace.slug),
            ]);
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
            await window.api.hangarInstallPlugin(project.namespace.owner, project.namespace.slug, version.name);
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

    async function handleUpdate(update: PluginUpdateInfo): Promise<void> {
        setInstallingVersion(update.latestVersion);
        try {
            await window.api.hangarInstallPlugin(update.hangarOwner, update.hangarSlug, update.latestVersion);
            await refreshInstalled();
            setPluginUpdates((prev) => prev.filter((u) => u.fileName !== update.fileName));
            addToast('success', `Updated to v${update.latestVersion}`);
        } catch (err) {
            addToast('error', `Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setInstallingVersion(null);
        }
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

    function renderMarkdown(content: string): string {
        return marked.parse(content, { async: false });
    }

    // ---- Render ----

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
                    <PluginSearchPanel
                        searchQuery={searchQuery}
                        onSearchInput={handleSearchInput}
                        onClearSearch={handleClearSearch}
                        searchResults={searchResults}
                        isSearching={isSearching}
                        totalResults={totalResults}
                        loadingMore={loadingMore}
                        selectedProject={selectedProject}
                        onSelectProject={(p) => void selectProject(p)}
                        onScroll={handleResultScroll}
                    />
                    <PluginDetailPanel
                        selectedProject={selectedProject}
                        selectedVersions={selectedVersions}
                        loadingDetail={loadingDetail}
                        installingVersion={installingVersion}
                        installedFileNames={installedFileNames}
                        onInstall={(v) => void handleInstall(v)}
                        renderMarkdown={renderMarkdown}
                    />
                </div>
            </Show>

            {/* Installed Tab */}
            <Show when={activeTab() === 'installed'}>
                <InstalledPluginsPanel
                    installedPlugins={installedPlugins}
                    pluginUpdates={pluginUpdates}
                    checkingUpdates={checkingUpdates}
                    removingPlugin={removingPlugin}
                    installingVersion={installingVersion}
                    confirmRemove={confirmRemove}
                    setConfirmRemove={setConfirmRemove}
                    onCheckUpdates={() => void checkForUpdates()}
                    onRemove={(f) => void handleRemove(f)}
                    onUpdate={(u) => void handleUpdate(u)}
                    onViewOnHangar={(o, s) => void viewOnHangar(o, s)}
                    getUpdateForPlugin={(f) => pluginUpdates().find((u) => u.fileName === f)}
                />
            </Show>
        </div>
    );
}
