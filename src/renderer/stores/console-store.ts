import { createStore } from 'solid-js/store';
import type { ConsoleLogEntry } from '../../shared/ipc-types';

const MAX_ENTRIES = 1000;

const [consoleLogs, setConsoleLogs] = createStore<{ entries: ConsoleLogEntry[] }>({ entries: [] });

export function addLogEntry(entry: ConsoleLogEntry): void {
    setConsoleLogs('entries', (prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
}

export function clearLogs(): void {
    setConsoleLogs('entries', []);
}

export { consoleLogs };
