import { ipcMain, BrowserWindow } from 'electron';
import { BotEngine } from './bot-engine';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type { BotConfig, BotStatus, ChatMessage, CharacterInfo, McSettings } from '../shared/ipc-types';

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

    engine.on('characters-available', (characters: CharacterInfo[], defaultId: string | null) => {
        win.webContents.send(IPC_CHANNELS.CHARACTERS_AVAILABLE, characters, defaultId);
    });

    // Handle renderer requests
    ipcMain.handle(IPC_CHANNELS.CONNECT, async (_event, config: BotConfig) => {
        await engine.connect(config);
    });

    ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
        await engine.disconnect();
    });

    ipcMain.handle(IPC_CHANNELS.START_CHAT, async (_event, characterId: string) => {
        await engine.startChat(characterId);
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
}
