import { createSignal, Show } from 'solid-js';
import { tunnelState, tunnelUrl, tunnelError } from '../../stores/server-store';
import { addToast } from '../../stores/toast-store';
import CopyButton from '../CopyButton';

export default function TunnelSection() {
    const [tunnelUrlInput, setTunnelUrlInput] = createSignal('');

    async function handleTunnelStart(): Promise<void> {
        try {
            await window.api.tunnelStart();
        } catch (err) {
            addToast('error', `Failed to start tunnel: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    async function handleTunnelStop(): Promise<void> {
        try {
            await window.api.tunnelStop();
        } catch (err) {
            addToast('error', `Failed to stop tunnel: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
    }

    function handleSaveTunnelUrl(): void {
        const url = tunnelUrlInput().trim();
        if (!url) return;
        void window.api.tunnelSetUrl(url);
        setTunnelUrlInput('');
    }

    return (
        <div class="tunnel-section">
            <Show when={tunnelState() === 'idle' || tunnelState() === 'not-installed'}>
                <button
                    class="tunnel-share-btn"
                    onClick={() => void handleTunnelStart()}
                >
                    <i class="bi bi-globe2"></i> Share Online
                </button>
            </Show>

            <Show when={tunnelState() === 'installing'}>
                <div class="tunnel-status-row">
                    <div class="tunnel-spinner"></div>
                    <span class="tunnel-status-text">Downloading playit.gg...</span>
                </div>
            </Show>

            <Show when={tunnelState() === 'starting'}>
                <div class="tunnel-status-row">
                    <div class="tunnel-spinner"></div>
                    <span class="tunnel-status-text">Connecting to playit.gg...</span>
                </div>
            </Show>

            <Show when={tunnelState() === 'claim-needed'}>
                <div class="tunnel-claim">
                    <div class="tunnel-claim-header">
                        <i class="bi bi-box-arrow-up-right"></i>
                        <span>Complete setup in your browser</span>
                    </div>
                    <p class="tunnel-claim-desc">
                        A browser window has opened. Sign in to claim your agent.
                    </p>
                    <div class="tunnel-status-row">
                        <div class="tunnel-spinner"></div>
                        <span class="tunnel-status-text">Waiting for approval...</span>
                    </div>
                </div>
            </Show>

            <Show when={tunnelState() === 'running'}>
                <div class="tunnel-active">
                    <Show
                        when={tunnelUrl()}
                        fallback={
                            <div class="tunnel-url-prompt">
                                <p class="tunnel-url-prompt-text">
                                    Go to your{' '}
                                    <a
                                        class="tunnel-dashboard-link"
                                        href="https://playit.gg/account/tunnels"
                                    >
                                        playit.gg dashboard
                                    </a>
                                    , create a <strong>Minecraft Java</strong> tunnel, then paste the address here:
                                </p>
                                <div class="tunnel-url-input-row">
                                    <input
                                        type="text"
                                        class="tunnel-url-input"
                                        placeholder="e.g. your-name.joinmc.link"
                                        value={tunnelUrlInput()}
                                        onInput={(e) => setTunnelUrlInput(e.currentTarget.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTunnelUrl(); }}
                                    />
                                    <button
                                        class="btn btn-connect tunnel-url-save-btn"
                                        onClick={handleSaveTunnelUrl}
                                        disabled={!tunnelUrlInput().trim()}
                                    >
                                        Save
                                    </button>
                                </div>
                            </div>
                        }
                    >
                        <div class="tunnel-address-box">
                            <span class="tunnel-address">{tunnelUrl()}</span>
                            <CopyButton
                                getText={() => tunnelUrl() ?? ''}
                                class="tunnel-copy-btn"
                                title="Copy address"
                            />
                        </div>
                    </Show>
                    <div class="tunnel-active-footer">
                        <span class="tunnel-hint">
                            {tunnelUrl() ? 'Share this address with friends to join!' : ''}
                        </span>
                        <button
                            class="tunnel-stop-btn"
                            onClick={() => void handleTunnelStop()}
                        >
                            Stop Sharing
                        </button>
                    </div>
                    <Show when={tunnelUrl()}>
                        <div class="tunnel-voice-hint">
                            <i class="bi bi-headset"></i>
                            <span>
                                To hear bot voices, friends need the{' '}
                                <a
                                    href="https://www.curseforge.com/minecraft/mc-mods/simple-voice-chat"
                                    target="_blank"
                                    rel="noopener"
                                >
                                    Simple Voice Chat
                                </a>{' '}
                                mod on their Minecraft client.
                            </span>
                        </div>
                    </Show>
                </div>
            </Show>

            <Show when={tunnelState() === 'stopping'}>
                <div class="tunnel-status-row">
                    <div class="tunnel-spinner"></div>
                    <span class="tunnel-status-text">Disconnecting...</span>
                </div>
            </Show>

            <Show when={tunnelState() === 'error'}>
                <div class="tunnel-error">
                    <span class="tunnel-error-text">
                        <i class="bi bi-exclamation-triangle"></i>
                        {tunnelError() ?? 'Tunnel error'}
                    </span>
                    <button
                        class="tunnel-retry-btn"
                        onClick={() => void handleTunnelStart()}
                    >
                        Retry
                    </button>
                </div>
            </Show>
        </div>
    );
}
