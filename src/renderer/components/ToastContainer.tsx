import { For } from 'solid-js';
import type { ToastType } from '../../shared/ipc-types';
import { toasts, dismissToast } from '../stores/toast-store';

const ICONS: Record<ToastType, string> = {
    success: '✅',
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
};

export default function ToastContainer() {
    return (
        <div class="toast-container">
            <For each={toasts()}>
                {(toast) => (
                    <div class={`toast toast-${toast.type}`}>
                        <span class="toast-icon">{ICONS[toast.type]}</span>
                        <span class="toast-message">{toast.message}</span>
                        <button class="toast-dismiss" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
                            ✕
                        </button>
                    </div>
                )}
            </For>
        </div>
    );
}
