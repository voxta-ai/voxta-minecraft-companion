import { createSignal } from 'solid-js';
import { status, connect, disconnect } from '../stores/app-store';
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
    const [voxtaUrl, setVoxtaUrl] = createSignal(saved.voxtaUrl ?? 'http://localhost:5384/hub');
    const [apiKey, setApiKey] = createSignal(saved.voxtaApiKey ?? '');
    const [collapsed, setCollapsed] = createSignal(false);
    const [connecting, setConnecting] = createSignal(false);

    const isConnected = () => status.mc === 'connected' || status.voxta === 'connected';
    const isConnecting = () => status.mc === 'connecting' || status.voxta === 'connecting' || connecting();

    const handleConnect = async () => {
        const config: BotConfig = {
            mcHost: mcHost(),
            mcPort: parseInt(mcPort(), 10),
            mcUsername: mcUsername(),
            mcVersion: '1.21.11',
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

    const handleDisconnect = async () => {
        await disconnect();
    };

    return (
        <div class={`connection-panel ${collapsed() ? 'collapsed' : ''}`}>
            <div class="connection-header" onClick={() => setCollapsed(!collapsed())}>
                <h2>⚡ Connection</h2>
                <div style={{ display: 'flex', 'align-items': 'center', gap: '10px' }}>
                    <span class={`status-dot ${status.mc}`} />
                    <span class="status-label">MC</span>
                    <span class={`status-dot ${status.voxta}`} />
                    <span class="status-label">Voxta</span>
                    <span style={{ 'font-size': '12px', color: 'var(--text-muted)' }}>{collapsed() ? '▶' : '▼'}</span>
                </div>
            </div>

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
                    <label>Username</label>
                    <input
                        type="text"
                        value={mcUsername()}
                        onInput={(e) => setMcUsername(e.currentTarget.value)}
                        placeholder="VoxtaBot"
                        disabled={isConnected()}
                    />
                </div>
                <div class="field">
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
                {!isConnected() ? (
                    <button
                        class="btn btn-connect"
                        onClick={handleConnect}
                        disabled={isConnecting()}
                    >
                        {isConnecting() ? '⏳ Connecting...' : '🚀 Connect'}
                    </button>
                ) : (
                    <button class="btn btn-disconnect" onClick={handleDisconnect}>
                        ⏹ Disconnect
                    </button>
                )}
            </div>
        </div>
    );
}
