import { Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { HangarProject, HangarProjectDetail } from '../../../shared/ipc-types';
import { formatDownloads } from './plugin-utils';

interface PluginSearchPanelProps {
    searchQuery: Accessor<string>;
    onSearchInput: (value: string) => void;
    onClearSearch: () => void;
    searchResults: Accessor<HangarProject[]>;
    isSearching: Accessor<boolean>;
    totalResults: Accessor<number>;
    loadingMore: Accessor<boolean>;
    selectedProject: Accessor<HangarProjectDetail | null>;
    onSelectProject: (project: HangarProject) => void;
    onScroll: (e: Event) => void;
}

export default function PluginSearchPanel(props: PluginSearchPanelProps) {
    return (
        <div class="plugin-list-panel">
            <div class="plugin-search">
                <i class="bi bi-search"></i>
                <input
                    type="text"
                    value={props.searchQuery()}
                    onInput={(e) => props.onSearchInput(e.currentTarget.value)}
                    placeholder="Search plugins..."
                />
                <Show when={props.searchQuery()}>
                    <button class="plugin-search-clear" onClick={props.onClearSearch}>
                        <i class="bi bi-x"></i>
                    </button>
                </Show>
            </div>

            <div class="plugin-result-count">
                <Show when={!props.isSearching()} fallback={<span>Searching...</span>}>
                    <span>{props.totalResults()} plugins</span>
                </Show>
            </div>

            <div class="plugin-result-list" onScroll={props.onScroll}>
                <For each={props.searchResults()}>
                    {(project) => (
                        <button
                            class={`plugin-result-card ${
                                props.selectedProject()?.namespace.slug === project.namespace.slug
                                    ? 'selected'
                                    : ''
                            }`}
                            onClick={() => props.onSelectProject(project)}
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
                <Show when={!props.isSearching() && props.searchResults().length === 0}>
                    <div class="plugin-empty">No plugins found.</div>
                </Show>
                <Show when={props.loadingMore()}>
                    <div class="plugin-loading-more">Loading more...</div>
                </Show>
            </div>
        </div>
    );
}
