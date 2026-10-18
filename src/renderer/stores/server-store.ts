import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import type { ServerState, ServerConsoleLine, SetupProgress, TunnelState } from '../../shared/ipc-types';
import { addToast } from './toast-store';

const MAX_CONSOLE_LINES = 1000;

// ---- Server status ----
const [serverState, setServerState] = createSignal<ServerState>('not-installed');
const [serverPort, setServerPort] = createSignal(25565);
const [serverError, setServerError] = createSignal<string | undefined>();
const [isInstalled, setIsInstalled] = createSignal(false);
const [setupProgress, setSetupProgress] = createSignal<SetupProgress | null>(null);
const [isSettingUp, setIsSettingUp] = createSignal(false);
// Live server-startup progress (distinct from install/setup progress above).
const [startupProgress, setStartupProgress] = createSignal<SetupProgress | null>(null);

// ---- Tunnel status ----
const [tunnelState, setTunnelState] = createSignal<TunnelState>('not-installed');
const [tunnelUrl, setTunnelUrl] = createSignal<string | null>(null);
const [tunnelClaimUrl, setTunnelClaimUrl] = createSignal<string | null>(null);
const [tunnelError, setTunnelError] = createSignal<string | undefined>();

// ---- Server console ----
const [serverConsole, setServerConsole] = createStore<{ lines: ServerConsoleLine[] }>({ lines: [] });

// Initialize global server status listener — call once at app startup
export function initServerStore(): void {
    // Fetch initial status
    void window.api.serverGetStatus().then((status) => {
        setServerState(status.state);
        setServerPort(status.port);
        setServerError(status.error);
    });
    void window.api.serverIsInstalled().then(setIsInstalled);

    // Subscribe to status changes globally
    window.api.onServerStatusChanged((status) => {
        setServerState(status.state);
        setServerPort(status.port);
        setServerError(status.error);
    });

    // Subscribe to console lines globally (persists when Server panel is closed)
    window.api.onServerConsoleLine((line) => {
        addServerConsoleLine(line);
    });

    // Track live server-startup progress globally so the startup popup can show
    // even when the Server panel is closed. Install/setup progress is handled
    // separately inside ServerPanel.
    window.api.onServerSetupProgress((progress) => {
        if (progress.phase === 'startup') setStartupProgress(progress);
    });

    // Fetch initial tunnel status
    void window.api.tunnelGetStatus().then((status) => {
        setTunnelState(status.state);
        setTunnelUrl(status.tunnelUrl);
        setTunnelClaimUrl(status.claimUrl);
        setTunnelError(status.error);
    });

    // Subscribe to tunnel status changes
    window.api.onTunnelStatusChanged((status) => {
        setTunnelState(status.state);
        setTunnelUrl(status.tunnelUrl);
        setTunnelClaimUrl(status.claimUrl);
        setTunnelError(status.error);
    });
}

export function addServerConsoleLine(line: ServerConsoleLine): void {
    setServerConsole('lines', (prev) => {
        const next = [...prev, line];
        return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
    });
}

export function clearServerConsole(): void {
    setServerConsole('lines', []);
}

/** Start the built-in server. Resolves false (after a toast) if the start request fails. */
export async function startServer(): Promise<boolean> {
    try {
        await window.api.serverStart();
        return true;
    } catch (err) {
        addToast('error', `Failed to start server: ${err instanceof Error ? err.message : 'Unknown error'}`);
        return false;
    }
}

/**
 * Start the built-in server if it is stopped, then resolve once it is ready for the bot.
 * serverStart only covers spawning the process; the server counts as ready when the world
 * has loaded. Resolves false if the server stops or fails on the way.
 */
export function ensureServerRunning(): Promise<boolean> {
    const state = serverState();
    if (state === 'running') return Promise.resolve(true);
    if (state === 'not-installed') {
        addToast('error', "The built-in server isn't set up yet. Use Change setup → Server to install it.");
        return Promise.resolve(false);
    }
    return new Promise((resolve) => {
        const finish = (ready: boolean): void => {
            unsubscribe();
            resolve(ready);
        };
        const unsubscribe = window.api.onServerStatusChanged((status) => {
            if (status.state === 'running') finish(true);
            else if (status.state === 'error' || status.state === 'idle' || status.state === 'not-installed') {
                finish(false);
            }
        });
        if (state === 'idle' || state === 'error') {
            void startServer().then((started) => {
                if (!started) finish(false);
            });
        }
    });
}

export async function stopServer(): Promise<void> {
    try {
        await window.api.serverStop();
    } catch (err) {
        addToast('error', `Failed to stop server: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
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
    startupProgress,
    setStartupProgress,
    serverConsole,
    tunnelState,
    tunnelUrl,
    tunnelClaimUrl,
    tunnelError,
};
