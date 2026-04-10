import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { ServerState, ServerConsoleLine, SetupProgress } from '../../shared/ipc-types';

const MAX_CONSOLE_LINES = 1000;

// ---- Server status ----
const [serverState, setServerState] = createSignal<ServerState>('not-installed');
const [serverPort, setServerPort] = createSignal(25565);
const [serverError, setServerError] = createSignal<string | undefined>();
const [isInstalled, setIsInstalled] = createSignal(false);
const [setupProgress, setSetupProgress] = createSignal<SetupProgress | null>(null);
const [isSettingUp, setIsSettingUp] = createSignal(false);

// ---- Server console ----
const [serverConsole, setServerConsole] = createStore<{ lines: ServerConsoleLine[] }>({ lines: [] });

export function addServerConsoleLine(line: ServerConsoleLine): void {
    setServerConsole('lines', (prev) => {
        const next = [...prev, line];
        return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
    });
}

export function clearServerConsole(): void {
    setServerConsole('lines', []);
}

export {
    serverState,
    setServerState,
    serverPort,
    setServerPort,
    serverError,
    setServerError,
    isInstalled,
    setIsInstalled,
    setupProgress,
    setSetupProgress,
    isSettingUp,
    setIsSettingUp,
    serverConsole,
};
