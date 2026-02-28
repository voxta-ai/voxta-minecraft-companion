import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type { VoxtaConnectConfig, VoxtaInfo, BotConfig, BotStatus, ChatMessage, ActionToggle, ToastMessage, McSettings } from '../shared/ipc-types';

export type StatusCallback = (status: BotStatus) => void;
export type ChatCallback = (message: ChatMessage) => void;
export type ActionCallback = (actionName: string) => void;
export type ToastCallback = (toast: ToastMessage) => void;

const api = {
    connectVoxta: (config: VoxtaConnectConfig): Promise<VoxtaInfo> =>
        ipcRenderer.invoke(IPC_CHANNELS.CONNECT_VOXTA, config),

    launchBot: (config: BotConfig): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_BOT, config),

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

    updateSettings: (settings: McSettings): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, settings),

    cycleVisionWindow: (): Promise<string | null> =>
        ipcRenderer.invoke(IPC_CHANNELS.CYCLE_VISION_WINDOW),

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

    onToast: (callback: ToastCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, toast: ToastMessage): void => callback(toast);
        ipcRenderer.on(IPC_CHANNELS.TOAST, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.TOAST, handler);
    },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
