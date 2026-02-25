import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type { BotConfig, BotStatus, ChatMessage, ActionToggle } from '../shared/ipc-types';

export type StatusCallback = (status: BotStatus) => void;
export type ChatCallback = (message: ChatMessage) => void;
export type ActionCallback = (actionName: string) => void;

const api = {
    connect: (config: BotConfig): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.CONNECT, config),

    disconnect: (): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.DISCONNECT),

    sendMessage: (text: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE, text),

    getStatus: (): Promise<BotStatus> =>
        ipcRenderer.invoke(IPC_CHANNELS.GET_STATUS),

    getActions: (): Promise<ActionToggle[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.GET_ACTIONS),

    toggleAction: (name: string, enabled: boolean): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_ACTION, name, enabled),

    onStatusChanged: (callback: StatusCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: BotStatus): void => callback(status);
        ipcRenderer.on(IPC_CHANNELS.STATUS_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.STATUS_CHANGED, handler);
    },

    onChatMessage: (callback: ChatCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, msg: ChatMessage): void => callback(msg);
        ipcRenderer.on(IPC_CHANNELS.CHAT_MESSAGE, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_MESSAGE, handler);
    },

    onActionTriggered: (callback: ActionCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, name: string): void => callback(name);
        ipcRenderer.on(IPC_CHANNELS.ACTION_TRIGGERED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTION_TRIGGERED, handler);
    },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
