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
    ScenarioInfo,
    ToastMessage,
    McSettings,
    AudioChunk,
    AudioPlaybackEvent,
    RecordingStartEvent,
    InspectorData,
    ConsoleLogEntry,
    SpatialPosition,
    ServerStatus,
    ServerConsoleLine,
    SetupProgress,
    ServerProperties,
    PluginInfo,
    CatalogPlugin,
    WorldInfo,
    HangarSearchResult,
    HangarProjectDetail,
    HangarVersion,
    ServerConfig,
    WorldBackup,
    WhitelistEntry,
    OpsEntry,
    PluginUpdateInfo,
} from '../shared/ipc-types';

export type StatusCallback = (status: BotStatus) => void;
export type ChatCallback = (message: ChatMessage) => void;
export type ActionCallback = (actionName: string) => void;
export type ToastCallback = (toast: ToastMessage) => void;
export type AudioChunkCallback = (chunk: AudioChunk) => void;
export type AudioStopCallback = () => void;
export type RecordingStartCallback = (event: RecordingStartEvent) => void;
export type RecordingStopCallback = () => void;
export type SpatialPositionCallback = (data: SpatialPosition) => void;

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

    loadScenarios: (): Promise<ScenarioInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.LOAD_SCENARIOS),

    favoriteChat: (chatId: string, favorite: boolean): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.FAVORITE_CHAT, chatId, favorite),

    deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHAT, chatId),

    refreshCharacters: (): Promise<VoxtaInfo> => ipcRenderer.invoke(IPC_CHANNELS.REFRESH_CHARACTERS),

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

    onSpeechPartial: (callback: (text: string) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, text: string): void => callback(text);
        ipcRenderer.on(IPC_CHANNELS.SPEECH_PARTIAL, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SPEECH_PARTIAL, handler);
    },

    onConsoleLog: (callback: (entry: ConsoleLogEntry) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, entry: ConsoleLogEntry): void => callback(entry);
        ipcRenderer.on(IPC_CHANNELS.CONSOLE_LOG, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CONSOLE_LOG, handler);
    },

    onSpatialPosition: (callback: SpatialPositionCallback): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: SpatialPosition): void => callback(data);
        ipcRenderer.on(IPC_CHANNELS.SPATIAL_POSITION, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SPATIAL_POSITION, handler);
    },

    // ---- Server Manager ----

    serverIsInstalled: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_IS_INSTALLED),

    serverGetInstalledVersion: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_INSTALLED_VERSION),

    serverGetVersions: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_VERSIONS),

    serverSetup: (version: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_SETUP, version),

    serverStart: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_START),

    serverStop: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_STOP),

    serverSendCommand: (cmd: string): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_SEND_COMMAND, cmd),

    serverGetStatus: (): Promise<ServerStatus> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_STATUS),

    serverGetProperties: (): Promise<ServerProperties> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_PROPERTIES),

    serverSaveProperties: (props: ServerProperties): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_SAVE_PROPERTIES, props),

    serverGetPlugins: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_PLUGINS),

    serverGetCatalog: (): Promise<CatalogPlugin[]> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_CATALOG),

    serverInstallPlugin: (pluginId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_INSTALL_PLUGIN, pluginId),

    serverRemovePlugin: (fileName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_REMOVE_PLUGIN, fileName),

    serverGetWorlds: (): Promise<WorldInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_WORLDS),

    serverSetActiveWorld: (worldName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_SET_ACTIVE_WORLD, worldName),

    serverRenameWorld: (oldName: string, newName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_RENAME_WORLD, oldName, newName),

    serverDeleteWorld: (worldName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_DELETE_WORLD, worldName),

    serverCreateWorld: (worldName: string, seed?: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_CREATE_WORLD, worldName, seed),

    serverGetConfig: (): Promise<ServerConfig> => ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_CONFIG),

    serverSaveConfig: (config: ServerConfig): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_SAVE_CONFIG, config),

    serverBackupWorld: (worldName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_BACKUP_WORLD, worldName),

    serverGetBackups: (worldName: string): Promise<WorldBackup[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_BACKUPS, worldName),

    serverRestoreBackup: (backupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_RESTORE_BACKUP, backupId),

    serverDeleteBackup: (backupId: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_DELETE_BACKUP, backupId),

    // Hangar Plugin Store
    hangarSearch: (query: string, offset?: number): Promise<HangarSearchResult> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_HANGAR_SEARCH, query, offset ?? 0),

    hangarGetProject: (owner: string, slug: string): Promise<HangarProjectDetail> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_HANGAR_PROJECT, owner, slug),

    hangarGetVersions: (owner: string, slug: string): Promise<HangarVersion[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_HANGAR_VERSIONS, owner, slug),

    hangarInstallPlugin: (owner: string, slug: string, versionName: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_HANGAR_INSTALL, owner, slug, versionName),

    checkPluginUpdates: (): Promise<PluginUpdateInfo[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_CHECK_PLUGIN_UPDATES),

    // Player Management
    serverGetWhitelist: (): Promise<WhitelistEntry[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_WHITELIST),

    serverAddWhitelist: (name: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_ADD_WHITELIST, name),

    serverRemoveWhitelist: (name: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_REMOVE_WHITELIST, name),

    serverGetOps: (): Promise<OpsEntry[]> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_GET_OPS),

    serverAddOp: (name: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_ADD_OP, name),

    serverRemoveOp: (name: string): Promise<void> =>
        ipcRenderer.invoke(IPC_CHANNELS.SERVER_REMOVE_OP, name),

    onServerStatusChanged: (callback: (status: ServerStatus) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: ServerStatus): void => callback(status);
        ipcRenderer.on(IPC_CHANNELS.SERVER_STATUS_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_STATUS_CHANGED, handler);
    },

    onServerConsoleLine: (callback: (line: ServerConsoleLine) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, line: ServerConsoleLine): void => callback(line);
        ipcRenderer.on(IPC_CHANNELS.SERVER_CONSOLE_LINE, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_CONSOLE_LINE, handler);
    },

    onServerSetupProgress: (callback: (progress: SetupProgress) => void): (() => void) => {
        const handler = (_event: Electron.IpcRendererEvent, progress: SetupProgress): void => callback(progress);
        ipcRenderer.on(IPC_CHANNELS.SERVER_SETUP_PROGRESS, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SERVER_SETUP_PROGRESS, handler);
    },
};

contextBridge.exposeInMainWorld('api', api);

export type ElectronAPI = typeof api;
