import { Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import type { WorldBackup } from '../../../shared/ipc-types';
import { formatWorldSize, formatBackupDate } from './world-utils';

interface WorldBackupListProps {
    backups: Accessor<WorldBackup[]>;
    worldName: string;
    worldBusy: Accessor<boolean>;
    restoringBackup: Accessor<string | null>;
    setRestoringBackup: (id: string | null) => void;
    deletingBackup: Accessor<string | null>;
    setDeletingBackup: (id: string | null) => void;
    onRestore: (backupId: string) => void;
    onDelete: (backupId: string, worldName: string) => void;
}

export default function WorldBackupList(props: WorldBackupListProps) {
    return (
        <div class="world-backup-list" onClick={(e) => e.stopPropagation()}>
            <div class="world-backup-header">
                <i class="bi bi-clock-history"></i> Backups
            </div>
            <Show
                when={props.backups().length > 0}
                fallback={<div class="world-backup-empty">No backups yet</div>}
            >
                <For each={props.backups()}>
                    {(backup) => (
                        <div class="world-backup-row">
                            <Show
                                when={props.restoringBackup() !== backup.id && props.deletingBackup() !== backup.id}
                                fallback={
                                    <div class="world-backup-confirm">
                                        <span class="world-backup-confirm-text">
                                            {props.restoringBackup() === backup.id ? 'Restore this backup?' : 'Delete this backup?'}
                                        </span>
                                        <button
                                            class={`world-backup-confirm-btn ${props.restoringBackup() === backup.id ? 'world-backup-restore-btn' : 'world-backup-delete-confirm-btn'}`}
                                            onClick={() => {
                                                if (props.restoringBackup() === backup.id) props.onRestore(backup.id);
                                                else props.onDelete(backup.id, props.worldName);
                                            }}
                                            disabled={props.worldBusy()}
                                        >
                                            {props.worldBusy() ? '...' : props.restoringBackup() === backup.id ? 'Restore' : 'Delete'}
                                        </button>
                                        <button
                                            class="world-backup-cancel-btn"
                                            onClick={() => { props.setRestoringBackup(null); props.setDeletingBackup(null); }}
                                            disabled={props.worldBusy()}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                }
                            >
                                <div class="world-backup-info">
                                    <span class="world-backup-date">{formatBackupDate(backup.timestamp)}</span>
                                    <span class="world-backup-size">{formatWorldSize(backup.sizeBytes)}</span>
                                </div>
                                <div class="world-backup-actions">
                                    <Show when={serverState() !== 'running' && serverState() !== 'starting'}>
                                        <button
                                            class="world-backup-action"
                                            onClick={() => props.setRestoringBackup(backup.id)}
                                            disabled={props.worldBusy()}
                                            title="Restore this backup"
                                        >
                                            <i class="bi bi-arrow-counterclockwise"></i>
                                        </button>
                                    </Show>
                                    <button
                                        class="world-backup-action world-backup-action-delete"
                                        onClick={() => props.setDeletingBackup(backup.id)}
                                        disabled={props.worldBusy()}
                                        title="Delete backup"
                                    >
                                        <i class="bi bi-trash3"></i>
                                    </button>
                                </div>
                            </Show>
                        </div>
                    )}
                </For>
            </Show>
        </div>
    );
}
