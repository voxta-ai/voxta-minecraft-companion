import { createSignal, Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import { addToast } from '../../stores/toast-store';
import type { WorldInfo, WorldBackup } from '../../../shared/ipc-types';
import { formatWorldSize, sanitizeWorldName } from './world-utils';
import WorldBackupList from './WorldBackupList';

interface WorldsSectionProps {
    worlds: Accessor<WorldInfo[]>;
    refreshWorlds: () => Promise<void>;
}

export default function WorldsSection(props: WorldsSectionProps) {
    const [renamingWorld, setRenamingWorld] = createSignal<string | null>(null);
    const [renameInput, setRenameInput] = createSignal('');
    const [deletingWorld, setDeletingWorld] = createSignal<string | null>(null);
    const [creatingWorld, setCreatingWorld] = createSignal(false);
    const [newWorldName, setNewWorldName] = createSignal('');
    const [newWorldSeed, setNewWorldSeed] = createSignal('');
    const [worldBusy, setWorldBusy] = createSignal(false);
    const [worldError, setWorldError] = createSignal<string | null>(null);
    const [expandedBackups, setExpandedBackups] = createSignal<string | null>(null);
    const [backups, setBackups] = createSignal<WorldBackup[]>([]);
    const [restoringBackup, setRestoringBackup] = createSignal<string | null>(null);
    const [deletingBackup, setDeletingBackup] = createSignal<string | null>(null);

    async function handleSetActiveWorld(worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverSetActiveWorld(worldName);
            await props.refreshWorlds();
            addToast('success', `Active world set to ${worldName}`);
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Failed to set active world');
        } finally {
            setWorldBusy(false);
        }
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
            await props.refreshWorlds();
            addToast('success', `World renamed to ${newName}`);
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Failed to rename world');
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
            await props.refreshWorlds();
            addToast('success', `World "${worldName}" deleted`);
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Failed to delete world');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleCreateWorld(): Promise<void> {
        const name = sanitizeWorldName(newWorldName());
        if (!name) return;
        const seed = newWorldSeed().trim() || undefined;
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverCreateWorld(name, seed);
            setCreatingWorld(false);
            setNewWorldName('');
            setNewWorldSeed('');
            await props.refreshWorlds();
            addToast('success', `World "${name}" created`);
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Failed to create world');
        } finally {
            setWorldBusy(false);
        }
    }

    async function handleBackupWorld(worldName: string): Promise<void> {
        setWorldBusy(true);
        setWorldError(null);
        try {
            await window.api.serverBackupWorld(worldName);
            if (expandedBackups() === worldName) {
                const list = await window.api.serverGetBackups(worldName);
                setBackups(list);
            }
            await props.refreshWorlds();
            addToast('success', `Backup created for "${worldName}"`);
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Backup failed');
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
            await props.refreshWorlds();
            addToast('success', 'Backup restored successfully');
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Restore failed');
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
            await props.refreshWorlds();
            addToast('success', 'Backup deleted');
        } catch (err) {
            addToast('error', err instanceof Error ? err.message : 'Delete backup failed');
        } finally {
            setWorldBusy(false);
        }
    }

    return (
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
                                placeholder="World name..."
                                value={newWorldName()}
                                onInput={(e) => setNewWorldName(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') void handleCreateWorld();
                                    if (e.key === 'Escape') { setCreatingWorld(false); setNewWorldName(''); setNewWorldSeed(''); }
                                }}
                                disabled={worldBusy()}
                                autofocus
                            />
                            <div class="world-seed-row">
                                <input
                                    type="text"
                                    class="world-name-input"
                                    placeholder="Seed (optional)"
                                    value={newWorldSeed()}
                                    onInput={(e) => setNewWorldSeed(e.currentTarget.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleCreateWorld();
                                    }}
                                    disabled={worldBusy()}
                                />
                                <button
                                    class="world-seed-random"
                                    onClick={() => setNewWorldSeed(String(Math.floor(Math.random() * 2_000_000_000) - 1_000_000_000))}
                                    disabled={worldBusy()}
                                    title="Generate random seed"
                                >
                                    <i class="bi bi-dice-5"></i>
                                </button>
                            </div>
                            <div class="world-create-actions">
                                <button
                                    class="btn btn-connect world-create-confirm"
                                    onClick={() => void handleCreateWorld()}
                                    disabled={worldBusy() || !newWorldName().trim()}
                                >
                                    Create
                                </button>
                                <button
                                    class="world-action-cancel"
                                    onClick={() => { setCreatingWorld(false); setNewWorldName(''); setNewWorldSeed(''); }}
                                    disabled={worldBusy()}
                                >
                                    Cancel
                                </button>
                            </div>
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
                when={props.worlds().length > 0}
                fallback={<div class="server-empty-hint">No worlds found. Start the server to generate a world.</div>}
            >
                <div class="world-list">
                    <For each={props.worlds()}>
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
                                <WorldBackupList
                                    backups={backups}
                                    worldName={world.name}
                                    worldBusy={worldBusy}
                                    restoringBackup={restoringBackup}
                                    setRestoringBackup={setRestoringBackup}
                                    deletingBackup={deletingBackup}
                                    setDeletingBackup={setDeletingBackup}
                                    onRestore={(id) => void handleRestoreBackup(id)}
                                    onDelete={(id, name) => void handleDeleteBackup(id, name)}
                                />
                            </Show>
                        </>)}
                    </For>
                </div>
            </Show>
        </div>
    );
}
