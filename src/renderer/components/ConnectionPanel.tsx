import { createSignal, Show, For, createEffect } from 'solid-js';
import { status, connect, disconnect, characters, startChat } from '../stores/app-store';
import type { BotConfig } from '../../shared/ipc-types';

const STORAGE_KEY = 'voxta-mc-config';

function loadSavedConfig(): Partial<BotConfig> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function saveConfig(config: BotConfig): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export default function ConnectionPanel() {
    const saved = loadSavedConfig();

    const [mcHost, setMcHost] = createSignal(saved.mcHost ?? 'localhost');
    const [mcPort, setMcPort] = createSignal(String(saved.mcPort ?? 25565));
    const [mcUsername, setMcUsername] = createSignal(saved.mcUsername ?? 'VoxtaBot');
    const [playerMcName, setPlayerMcName] = createSignal(saved.playerMcUsername ?? 'Player');
    const [voxtaUrl, setVoxtaUrl] = createSignal(saved.voxtaUrl ?? 'http://localhost:5384/hub');
    const [apiKey, setApiKey] = createSignal(saved.voxtaApiKey ?? '');
    const [connecting, setConnecting] = createSignal(false);
    const [selectedCharacterId, setSelectedCharacterId] = createSignal<string | null>(null);

    const isConnected = () => status.mc === 'connected' || status.voxta === 'connected';
    const isConnecting = () => status.mc === 'connecting' || status.voxta === 'connecting' || connecting();
    const hasSession = () => status.sessionId !== null;
    const showCharacterPicker = () => isConnected() && characters.list.length > 0 && !hasSession();

    createEffect(() => {
        if (characters.list.length > 0 && !selectedCharacterId()) {
            setSelectedCharacterId(characters.defaultId ?? characters.list[0]?.id ?? null);
        }
    });

    const handleConnect = async () => {
        const config: BotConfig = {
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10),
            mcUsername: mcUsername(),
            mcVersion: '1.21.11',
            playerMcUsername: playerMcName(),
            voxtaUrl: voxtaUrl(),
            voxtaApiKey: apiKey(),
            perceptionIntervalMs: 3000,
            entityRange: 32,
        };
        saveConfig(config);
        setConnecting(true);
        try {
            await connect(config);
        } finally {
            setConnecting(false);
        }
    };

    const handleStartChat = async () => {
        const charId = selectedCharacterId();
        if (!charId) return;
        await startChat(charId);
    };

    const handleDisconnect = async () => {
        setSelectedCharacterId(null);
        await disconnect();
    };

    return (
        <div class="connection-panel">
            <div class="connection-fields">
                <div class="field">
                    <label>MC Host</label>
                    <input
                        type="text"
                        value={mcHost()}
                        onInput={(e) => setMcHost(e.currentTarget.value)}
                        placeholder="localhost"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field">
                    <label>MC Port</label>
                    <input
                        type="text"
                        value={mcPort()}
                        onInput={(e) => setMcPort(e.currentTarget.value)}
                        placeholder="25565"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field">
                    <label>Bot Name (in Minecraft)</label>
                    <input
                        type="text"
                        value={mcUsername()}
                        onInput={(e) => setMcUsername(e.currentTarget.value)}
                        placeholder="VoxtaBot"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field">
                    <label>Your Minecraft Name</label>
                    <input
                        type="text"
                        value={playerMcName()}
                        onInput={(e) => setPlayerMcName(e.currentTarget.value)}
                        placeholder="Your in-game name"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field full-width">
                    <label>Voxta URL</label>
                    <input
                        type="text"
                        value={voxtaUrl()}
                        onInput={(e) => setVoxtaUrl(e.currentTarget.value)}
                        placeholder="http://localhost:5384/hub"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field full-width">
                    <label>API Key</label>
                    <input
                        type="password"
                        value={apiKey()}
                        onInput={(e) => setApiKey(e.currentTarget.value)}
                        placeholder="Voxta API key"
                        disabled={isConnected()}
                    />
                </div>
            </div>

            <div class="connection-actions">
                <Show when={!isConnected()}>
                    <button
                        class="btn btn-connect"
                        onClick={handleConnect}
                        disabled={isConnecting()}
                    >
                        {isConnecting() ? '⏳ Connecting...' : '🚀 Connect'}
                    </button>
                </Show>

                <Show when={showCharacterPicker()}>
                    <select
                        class="character-select"
                        value={selectedCharacterId() ?? ''}
                        onChange={(e) => setSelectedCharacterId(e.currentTarget.value)}
                    >
                        <For each={characters.list}>
                            {(char) => (
                                <option value={char.id}>
                                    {char.name} {char.id === characters.defaultId ? '⭐' : ''}
                                </option>
                            )}
                        </For>
                    </select>
                    <button class="btn btn-connect" onClick={handleStartChat}>
                        💬 Start Chat
                    </button>
                </Show>

                <Show when={isConnected()}>
                    <button class="btn btn-disconnect" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                </Show>
            </div>
        </div>
    );
}
