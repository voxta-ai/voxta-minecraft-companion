import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type {
    VoxtaConnectConfig,
    VoxtaInfo,
    BotConfig,
    BotStatus,
    ChatMessage,
    ActionToggle,
    ChatListItem,
    ToastMessage,
    McSettings,
    AudioChunk,
    AudioPlaybackEvent,
    RecordingStartEvent,
    InspectorData,
} from '../shared/ipc-types';

export type StatusCallback = (status: BotStatus) => void;
export type ChatCallback = (message: ChatMessage) => void;
export type ActionCallback = (actionName: string) => void;
export type ToastCallback = (toast: ToastMessage) => void;
export type AudioChunkCallback = (chunk: AudioChunk) => void;
export type AudioStopCallback = () => void;
export type RecordingStartCallback = (event: RecordingStartEvent) => void;
export type RecordingStopCallback = () => void;

const api = {
    connectVoxta: (config: VoxtaConnectConfig): Promise<VoxtaInfo> =>
        ipcRenderer.invoke(IPC_CHANNELS.CONNECT_VOXTA, config),

    launchBot: (config: BotConfig): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.LAUNCH_BOT, config),

    disconnect: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.DISCONNECT),

    stopSession: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.STOP_SESSION),

    sendMessage: (text: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE, text),

    getStatus: (): Promise<BotStatus> => ipcRenderer.invoke(IPC_CHANNELS.GET_STATUS),

    getActions: (): Promise<ActionToggle[]> => ipcRenderer.invoke(IPC_CHANNELS.GET_ACTIONS),

    toggleAction: (name: string, enabled: boolean): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_ACTION, name, enabled),

    updateSettings: (settings: McSettings): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SETTINGS, settings),

    cycleVisionWindow: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.CYCLE_VISION_WINDOW),

    loadChats: (characterId: string): Promise<ChatListItem[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.LOAD_CHATS, characterId),

    favoriteChat: (chatId: string, favorite: boolean): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_CHAT, chatId, favorite),

    deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHAT, chatId),

    // Audio: renderer → main (ack that playback started/completed)
    audioStarted: (event: AudioPlaybackEvent): void => ipcRenderer.send(IPC_CHANNELS.AUDIO_STARTED, event),

    audioComplete: (messageId: string): void => ipcRenderer.send(IPC_CHANNELS.AUDIO_COMPLETE, messageId),

    /** Forward a renderer log message to the main process terminal */
    log: (message: string): void => ipcRenderer.send(IPC_CHANNELS.LOG, message),

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

    onClearChat: (callback: () => void): (() => void) => {
        const handler = (): void => callback();
        ipcRenderer.on(IPC_CHANNELS.CLEAR_CHAT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CLEAR_CHAT, handler);
    },

    onInspectorUpdate: (callback: (data: InspectorData) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: InspectorData): void => callback(data);
        ipcRenderer.on(IPC_CHANNELS.INSPECTOR_UPDATE, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INSPECTOR_UPDATE, handler);
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

    // Audio: main → renderer (play/stop audio chunks)
    onPlayAudio: (callback: AudioChunkCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, chunk: AudioChunk): void => callback(chunk);
        ipcRenderer.on(IPC_CHANNELS.PLAY_AUDIO, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PLAY_AUDIO, handler);
    },

    onStopAudio: (callback: AudioStopCallback): (() => void) => {
        const handler = (): void => callback();
        ipcRenderer.on(IPC_CHANNELS.STOP_AUDIO, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.STOP_AUDIO, handler);
    },

    // Audio input: main → renderer (recording start/stop)
    onRecordingStart: (callback: RecordingStartCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, event: RecordingStartEvent): void => callback(event);
        ipcRenderer.on(IPC_CHANNELS.RECORDING_START, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RECORDING_START, handler);
    },

    onRecordingStop: (callback: RecordingStopCallback): (() => void) => {
        const handler = (): void => callback();
        ipcRenderer.on(IPC_CHANNELS.RECORDING_STOP, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RECORDING_STOP, handler);
    },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
