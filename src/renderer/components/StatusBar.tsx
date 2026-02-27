import { Show } from 'solid-js';
import { status } from '../stores/app-store';

export default function StatusBar() {
    return (
        <div class="status-bar">
            <div class="status-bar-item">
                <span class={`status-dot ${status.mc}`} />
                Minecraft: {status.mc}
            </div>
            <div class="status-bar-item">
                <span class={`status-dot ${status.voxta}`} />
                Voxta: {status.voxta}
            </div>
            <Show when={status.assistantName}>
                <div class="status-bar-item">
                    🤖 {status.assistantName}
                </div>
            </Show>
            <Show when={status.position}>
                <div class="status-bar-item">
                    📍 {status.position?.x}, {status.position?.y}, {status.position?.z}
                </div>
            </Show>
            <Show when={status.health !== null}>
                <div class="status-bar-item">
                    ❤️ {status.health}/20
                </div>
            </Show>
            <Show when={status.food !== null}>
                <div class="status-bar-item">
                    🍗 {status.food}/20
                </div>
            </Show>
            <Show when={status.currentAction}>
                <div class="status-bar-item">
                    ⚡ {status.currentAction}
                </div>
            </Show>
        </div>
    );
}
