import { Show } from 'solid-js';
import { status } from '../stores/connection-store';
import { serverState } from '../stores/server-store';

export default function StatusBar() {
    const isDualBot = () => !!status.assistantName2;

    const serverStatusClass = () => {
        switch (serverState()) {
            case 'running': return 'connected';
            case 'starting':
            case 'stopping': return 'connecting';
            case 'error': return 'error';
            default: return 'disconnected';
        }
    };

    const serverLabel = () => {
        switch (serverState()) {
            case 'running': return 'running';
            case 'starting': return 'starting';
            case 'stopping': return 'stopping';
            case 'error': return 'error';
            default: return 'stopped';
        }
    };

    return (
        <div class="status-bar">
            <Show when={serverState() !== 'not-installed'}>
                <div class="status-bar-item">
                    <span class={`status-dot ${serverStatusClass()}`} />
                    Server: {serverLabel()}
                </div>
            </Show>
            <div class="status-bar-item">
                <span class={`status-dot ${status.mc}`} />
                Bot 1 (MC): {status.mc}
            </div>
            <Show when={status.mc2 !== 'disconnected'}>
                <div class="status-bar-item">
                    <span class={`status-dot ${status.mc2}`} />
                    Bot 2 (MC): {status.mc2}
                </div>
            </Show>
            <div class="status-bar-item">
                <span class={`status-dot ${status.voxta}`} />
                Voxta: {status.voxta}
            </div>
            <Show when={status.assistantName}>
                <div class="status-bar-item">🤖 {status.assistantName} {status.assistantName2 ? `& ${status.assistantName2}` : ''}</div>
            </Show>
            <Show when={status.position}>
                <div class="status-bar-item">
                    📍 {status.position?.x}, {status.position?.y}, {status.position?.z}
                </div>
            </Show>
            {/* Single-bot: plain health/food */}
            <Show when={!isDualBot() && status.health !== null}>
                <div class="status-bar-item">❤️ {status.health}/20</div>
            </Show>
            <Show when={!isDualBot() && status.food !== null}>
                <div class="status-bar-item">🍗 {status.food}/20</div>
            </Show>
            {/* Dual-bot: health/food labelled per bot */}
            <Show when={isDualBot() && status.health !== null}>
                <div class="status-bar-item">{status.assistantName} ❤️ {status.health}/20 🍗 {status.food ?? '?'}/20</div>
            </Show>
            <Show when={isDualBot() && status.health2 !== null}>
                <div class="status-bar-item">{status.assistantName2} ❤️ {status.health2}/20 🍗 {status.food2 ?? '?'}/20</div>
            </Show>
            <Show when={status.currentAction}>
                <div class="status-bar-item">⚡ {status.currentAction}</div>
            </Show>
        </div>
    );
}
