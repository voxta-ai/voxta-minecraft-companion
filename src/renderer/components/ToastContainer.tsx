import { For, createSignal, onCleanup, onMount } from 'solid-js';
import type { ToastMessage } from '../../shared/ipc-types';

const DEFAULT_DURATION_MS = 6000;

export default function ToastContainer() {
    const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

    onMount(() => {
        const cleanup = window.api.onToast((toast) => {
            setToasts((prev) => [...prev, toast]);

            // Auto-dismiss after duration
            const duration = toast.durationMs ?? DEFAULT_DURATION_MS;
            setTimeout(() => {
                dismissToast(toast.id);
            }, duration);
        });
        onCleanup(cleanup);
    });

    const dismissToast = (id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    };

    const getIcon = (type: ToastMessage['type']): string => {
        switch (type) {
            case 'success':
                return '✅';
            case 'error':
                return '❌';
            case 'warning':
                return '⚠️';
            case 'info':
                return 'ℹ️';
        }
    };

    return (
        <div class="toast-container">
            <For each={toasts()}>
                {(toast) => (
                    <div class={`toast toast-${toast.type}`}>
                        <span class="toast-icon">{getIcon(toast.type)}</span>
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
