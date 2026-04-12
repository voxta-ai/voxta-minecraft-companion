import { createSignal } from 'solid-js';
import type { ToastMessage, ToastType } from '../../shared/ipc-types';

const DEFAULT_DURATION_MS = 6000;

const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

let nextId = 0;

export function addToast(type: ToastType, message: string, durationMs?: number): void {
    const id = `local-${nextId++}`;
    const toast: ToastMessage = { id, type, message, durationMs };
    setToasts((prev) => [...prev, toast]);

    const duration = durationMs ?? DEFAULT_DURATION_MS;
    setTimeout(() => dismissToast(id), duration);
}

export function dismissToast(id: string): void {
    setToasts((prev) => prev.filter((t) => t.id !== id));
}

let initialized = false;

export function initToastStore(): void {
    if (initialized) return;
    initialized = true;
    window.api.onToast((toast) => {
        setToasts((prev) => [...prev, toast]);
        const duration = toast.durationMs ?? DEFAULT_DURATION_MS;
        setTimeout(() => dismissToast(toast.id), duration);
    });
}

export { toasts };
