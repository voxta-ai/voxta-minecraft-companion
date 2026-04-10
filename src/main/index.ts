import { app, BrowserWindow, shell, nativeImage } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { registerIpcHandlers } from './ipc-handlers';
import icon from '../../resources/icon.png?asset';

import { IPC_CHANNELS } from '../shared/ipc-types';
import type { ConsoleLogLevel } from '../shared/ipc-types';

// ---- Global log timestamps + IPC forwarding ----
// Prefix every console.log / console.warn / console.error with [HH:MM:SS.mmm]
// and forward each line to the renderer's terminal panel.
let mainWindow: BrowserWindow | null = null;

const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);

function timestamp(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `[${hh}:${mm}:${ss}.${ms}]`;
}

function forwardToRenderer(level: ConsoleLogLevel, args: unknown[]): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    mainWindow.webContents.send(IPC_CHANNELS.CONSOLE_LOG, {
        timestamp: Date.now(),
        level,
        text,
    });
}

console.log = (...args: unknown[]) => {
    originalLog(timestamp(), ...args);
    forwardToRenderer('log', args);
};
console.warn = (...args: unknown[]) => {
    originalWarn(timestamp(), ...args);
    forwardToRenderer('warn', args);
};
console.error = (...args: unknown[]) => {
    originalError(timestamp(), ...args);
    forwardToRenderer('error', args);
};

// ---- Window bounds persistence ----
interface WindowBounds {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
}

function getBoundsPath(): string {
    return join(app.getPath('userData'), 'window-bounds.json');
}

function loadBounds(): WindowBounds | null {
    try {
        const data = readFileSync(getBoundsPath(), 'utf-8');
        return JSON.parse(data) as WindowBounds;
    } catch {
        return null;
    }
}

function saveBounds(win: BrowserWindow): void {
    const maximized = win.isMaximized();
    // Save the restored (non-maximized) bounds so unmaximizing works correctly
    const bounds = maximized ? win.getNormalBounds() : win.getBounds();
    const data: WindowBounds = { ...bounds, maximized };
    try {
        writeFileSync(getBoundsPath(), JSON.stringify(data));
    } catch {
        // Best effort — don't crash if we can't save
    }
}

function createWindow(): BrowserWindow {
    const saved = loadBounds();
    const win = new BrowserWindow({
        width: saved?.width ?? 1500,
        height: saved?.height ?? 1200,
        x: saved?.x,
        y: saved?.y,
        minWidth: 700,
        minHeight: 500,
        title: 'Voxta Minecraft Companion',
        backgroundColor: '#1a1a2e',
        icon: nativeImage.createFromPath(icon),
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
        },
    });

    if (saved?.maximized) win.maximize();

    win.on('ready-to-show', () => {
        win.show();
    });

    // Save bounds whenever the window is moved, resized, or closed
    win.on('close', () => saveBounds(win));

    win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    // Prevent external links from navigating the app window — open in system browser
    win.webContents.on('will-navigate', (event, url) => {
        const appUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] ?? '' : 'file://';
        if (!url.startsWith(appUrl)) {
            event.preventDefault();
            void shell.openExternal(url);
        }
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    } else {
        void win.loadFile(join(__dirname, '../renderer/index.html'));
    }

    return win;
}

void app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.voxta.minecraft-companion');

    app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window);
    });

    const win = createWindow();
    mainWindow = win;
    const serverManager = registerIpcHandlers(win);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const newWin = createWindow();
            mainWindow = newWin;
            registerIpcHandlers(newWin);
        }
    });

    // Gracefully stop the MC server when the app is closing
    app.on('before-quit', () => {
        void serverManager.cleanup();
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
