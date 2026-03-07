import { app, BrowserWindow, shell, nativeImage } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { registerIpcHandlers } from './ipc-handlers';
import icon from '../../resources/icon.png?asset';

// ---- Global log timestamps ----
// Prefix every console.log / console.warn with [HH:MM:SS.mmm] for timing diagnostics
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
function timestamp(): string {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `[${hh}:${mm}:${ss}.${ms}]`;
}
console.log = (...args: unknown[]) => originalLog(timestamp(), ...args);
console.warn = (...args: unknown[]) => originalWarn(timestamp(), ...args);

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1500,
        height: 1200,
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

    win.on('ready-to-show', () => {
        win.show();
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: 'deny' };
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
    registerIpcHandlers(win);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            const newWin = createWindow();
            registerIpcHandlers(newWin);
        }
    });
});

app.on('window-all-closed', () => {
    app.quit();
});
