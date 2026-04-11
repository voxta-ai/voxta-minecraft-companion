import { createSignal, onMount, Show, For } from 'solid-js';
import type { Accessor } from 'solid-js';
import { serverState } from '../../stores/server-store';
import { addToast } from '../../stores/toast-store';
import type { WhitelistEntry, OpsEntry, ServerProperties } from '../../../shared/ipc-types';

interface PlayersSectionProps {
    properties: Accessor<ServerProperties>;
    setProperties: (fn: (prev: ServerProperties) => ServerProperties) => void;
}

export default function PlayersSection(props: PlayersSectionProps) {
    const [whitelist, setWhitelist] = createSignal<WhitelistEntry[]>([]);
    const [ops, setOps] = createSignal<OpsEntry[]>([]);
    const [whitelistInput, setWhitelistInput] = createSignal('');
    const [opsInput, setOpsInput] = createSignal('');
    const [playerBusy, setPlayerBusy] = createSignal(false);
    const [removingPlayer, setRemovingPlayer] = createSignal<string | null>(null);

    onMount(() => {
        void refreshPlayers();
    });

    async function refreshPlayers(): Promise<void> {
        const [wl, opList] = await Promise.all([
            window.api.serverGetWhitelist(),
            window.api.serverGetOps(),
        ]);
        setWhitelist(wl);
        setOps(opList);
    }

    async function handleAddWhitelist(): Promise<void> {
        const name = whitelistInput().trim();
        if (!name) return;
        setPlayerBusy(true);
        try {
            await window.api.serverAddWhitelist(name);
            setWhitelistInput('');
            await refreshPlayers();
            addToast('success', `Added ${name} to whitelist`);
        } catch {
            addToast('error', `Failed to add ${name} to whitelist`);
        } finally {
            setPlayerBusy(false);
        }
    }

    async function handleRemoveWhitelist(name: string): Promise<void> {
        setRemovingPlayer(name);
        try {
            await window.api.serverRemoveWhitelist(name);
            await refreshPlayers();
            addToast('success', `Removed ${name} from whitelist`);
        } catch {
            addToast('error', `Failed to remove ${name} from whitelist`);
        } finally {
            setRemovingPlayer(null);
        }
    }

    async function handleAddOp(): Promise<void> {
        const name = opsInput().trim();
        if (!name) return;
        setPlayerBusy(true);
        try {
            await window.api.serverAddOp(name);
            setOpsInput('');
            await refreshPlayers();
            addToast('success', `Added ${name} as operator`);
        } catch {
            addToast('error', `Failed to add ${name} as operator`);
        } finally {
            setPlayerBusy(false);
        }
    }

    async function handleRemoveOp(name: string): Promise<void> {
        setRemovingPlayer(name);
        try {
            await window.api.serverRemoveOp(name);
            await refreshPlayers();
            addToast('success', `Removed ${name} from operators`);
        } catch {
            addToast('error', `Failed to remove ${name} from operators`);
        } finally {
            setRemovingPlayer(null);
        }
    }

    return (
        <div class="server-players-section">
            <Show when={serverState() === 'running'}>
                <div class="server-hint">Player changes take effect after a server restart.</div>
            </Show>

            {/* Whitelist */}
            <div class="server-section-group">
                <div class="section-title">
                    Whitelist
                    <label class="toggle" style={{ "margin-left": "auto" }}>
                        <input
                            type="checkbox"
                            checked={props.properties()['white-list'] === 'true'}
                            onChange={(e) => {
                                const value = e.currentTarget.checked ? 'true' : 'false';
                                props.setProperties((prev) => ({ ...prev, 'white-list': value }));
                                void window.api.serverSaveProperties({ ...props.properties(), 'white-list': value });
                            }}
                        />
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <Show when={props.properties()['white-list'] === 'true'}>
                    <div class="player-add-row">
                        <input
                            type="text"
                            class="player-add-input"
                            value={whitelistInput()}
                            onInput={(e) => setWhitelistInput(e.currentTarget.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') void handleAddWhitelist(); }}
                            placeholder="Player name..."
                            disabled={playerBusy()}
                        />
                        <button
                            class="btn btn-connect player-add-btn"
                            onClick={() => void handleAddWhitelist()}
                            disabled={playerBusy() || !whitelistInput().trim()}
                        >
                            Add
                        </button>
                    </div>
                    <div class="setting-card-list">
                        <For each={whitelist()}>
                            {(entry) => (
                                <div class="setting-card">
                                    <div class="setting-card-info">
                                        <div class="setting-card-name">
                                            <i class="bi bi-person"></i> {entry.name}
                                        </div>
                                    </div>
                                    <button
                                        class="server-plugin-remove-btn"
                                        onClick={() => void handleRemoveWhitelist(entry.name)}
                                        disabled={removingPlayer() === entry.name}
                                        title="Remove from whitelist"
                                    >
                                        <i class="bi bi-x-lg"></i>
                                    </button>
                                </div>
                            )}
                        </For>
                        <Show when={whitelist().length === 0}>
                            <div class="plugin-empty">No players whitelisted.</div>
                        </Show>
                    </div>
                </Show>
                <Show when={props.properties()['white-list'] !== 'true'}>
                    <div class="plugin-empty">
                        Whitelist is off — anyone can join. Enable it to restrict access.
                    </div>
                </Show>
            </div>

            {/* Operators */}
            <div class="server-section-group">
                <div class="section-title">Operators</div>
                <div class="player-add-row">
                    <input
                        type="text"
                        class="player-add-input"
                        value={opsInput()}
                        onInput={(e) => setOpsInput(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleAddOp(); }}
                        placeholder="Player name..."
                        disabled={playerBusy()}
                    />
                    <button
                        class="btn btn-connect player-add-btn"
                        onClick={() => void handleAddOp()}
                        disabled={playerBusy() || !opsInput().trim()}
                    >
                        Add
                    </button>
                </div>
                <div class="setting-card-list">
                    <For each={ops()}>
                        {(entry) => (
                            <div class="setting-card">
                                <div class="setting-card-info">
                                    <div class="setting-card-name">
                                        <i class="bi bi-shield-check"></i> {entry.name}
                                    </div>
                                    <div class="setting-card-desc">
                                        Permission level {entry.level}
                                    </div>
                                </div>
                                <button
                                    class="server-plugin-remove-btn"
                                    onClick={() => void handleRemoveOp(entry.name)}
                                    disabled={removingPlayer() === entry.name}
                                    title="Remove operator"
                                >
                                    <i class="bi bi-x-lg"></i>
                                </button>
                            </div>
                        )}
                    </For>
                    <Show when={ops().length === 0}>
                        <div class="plugin-empty">No operators configured.</div>
                    </Show>
                </div>
            </div>
        </div>
    );
}
