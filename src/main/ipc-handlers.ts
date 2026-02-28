import { ipcMain, BrowserWindow } from 'electron';
import { BotEngine } from './bot-engine';
import { cycleVisionWindow } from './vision-capture';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type { VoxtaConnectConfig, BotConfig, BotStatus, ChatMessage, ToastMessage, McSettings } from '../shared/ipc-types';

export function registerIpcHandlers(win: BrowserWindow): void {
    const engine = new BotEngine();

    // Forward events to renderer
    engine.on('status-changed', (status: BotStatus) => {
        win.webContents.send(IPC_CHANNELS.STATUS_CHANGED, status);
    });

    engine.on('chat-message', (msg: ChatMessage) => {
        win.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, msg);
    });

    engine.on('action-triggered', (actionName: string) => {
        win.webContents.send(IPC_CHANNELS.ACTION_TRIGGERED, actionName);
    });

    engine.on('toast', (toast: ToastMessage) => {
        win.webContents.send(IPC_CHANNELS.TOAST, toast);
    });

    // Handle renderer requests
    ipcMain.handle(IPC_CHANNELS.CONNECT_VOXTA, async (_event, config: VoxtaConnectConfig) => {
        return engine.connectVoxta(config);
    });

    ipcMain.handle(IPC_CHANNELS.LAUNCH_BOT, async (_event, config: BotConfig) => {
        await engine.launchBot(config);
    });

    ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
        await engine.disconnect();
    });

    ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE, async (_event, text: string) => {
        await engine.sendMessage(text);
    });

    ipcMain.handle(IPC_CHANNELS.GET_STATUS, () => {
        return engine.getStatus();
    });

    ipcMain.handle(IPC_CHANNELS.GET_ACTIONS, () => {
        return engine.getActions();
    });

    ipcMain.handle(IPC_CHANNELS.TOGGLE_ACTION, (_event, name: string, enabled: boolean) => {
        engine.toggleAction(name, enabled);
    });

    ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, (_event, settings: McSettings) => {
        engine.updateSettings(settings);
    });

    ipcMain.handle(IPC_CHANNELS.CYCLE_VISION_WINDOW, async () => {
        return cycleVisionWindow();
    });

    ipcMain.handle(IPC_CHANNELS.LOAD_CHATS, async (_event, characterId: string) => {
        return engine.loadChats(characterId);
    });

    ipcMain.handle(IPC_CHANNELS.FAVORITE_CHAT, async (_event, chatId: string, favorite: boolean) => {
        return engine.favoriteChat(chatId, favorite);
    });

    ipcMain.handle(IPC_CHANNELS.DELETE_CHAT, async (_event, chatId: string) => {
        return engine.deleteChat(chatId);
    });
}
