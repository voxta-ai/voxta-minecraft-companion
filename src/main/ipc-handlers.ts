import { ipcMain, BrowserWindow } from 'electron';
import { BotEngine } from './bot-engine';
import { ServerManager } from './server-manager';
import { cycleVisionWindow } from './vision-capture';
import { IPC_CHANNELS } from '../shared/ipc-types';
import type {
    VoxtaConnectConfig,
    BotConfig,
    BotStatus,
    ChatMessage,
    ToastMessage,
    McSettings,
    AudioChunk,
    AudioPlaybackEvent,
    RecordingStartEvent,
    InspectorData,
    SpatialPosition,
    ServerStatus,
    ServerConsoleLine,
    SetupProgress,
    ServerProperties,
    ServerConfig,
} from '../shared/ipc-types';

export function registerIpcHandlers(win: BrowserWindow): ServerManager {
    const engine = new BotEngine();
    const serverManager = new ServerManager();

    // Forward events to renderer
    engine.on('status-changed', (status: BotStatus) => {
        win.webContents.send(IPC_CHANNELS.STATUS_CHANGED, status);
    });

    engine.on('chat-message', (msg: ChatMessage) => {
        win.webContents.send(IPC_CHANNELS.CHAT_MESSAGE, msg);
    });

    engine.on('clear-chat', () => {
        win.webContents.send(IPC_CHANNELS.CLEAR_CHAT);
    });

    engine.on('inspector-update', (data: InspectorData) => {
        win.webContents.send(IPC_CHANNELS.INSPECTOR_UPDATE, data);
    });

    engine.on('action-triggered', (actionName: string) => {
        win.webContents.send(IPC_CHANNELS.ACTION_TRIGGERED, actionName);
    });

    engine.on('toast', (toast: ToastMessage) => {
        win.webContents.send(IPC_CHANNELS.TOAST, toast);
    });

    engine.on('play-audio', (chunk: AudioChunk) => {
        win.webContents.send(IPC_CHANNELS.PLAY_AUDIO, chunk);
    });

    engine.on('stop-audio', () => {
        win.webContents.send(IPC_CHANNELS.STOP_AUDIO);
    });

    engine.on('recording-start', (event: RecordingStartEvent) => {
        win.webContents.send(IPC_CHANNELS.RECORDING_START, event);
    });

    engine.on('recording-stop', () => {
        win.webContents.send(IPC_CHANNELS.RECORDING_STOP);
    });

    engine.on('speech-partial', (text: string) => {
        win.webContents.send(IPC_CHANNELS.SPEECH_PARTIAL, text);
    });

    engine.on('spatial-position', (data: SpatialPosition) => {
        win.webContents.send(IPC_CHANNELS.SPATIAL_POSITION, data);
    });

    // Audio ack from renderer
    ipcMain.on(IPC_CHANNELS.AUDIO_STARTED, (_event, payload: AudioPlaybackEvent) => {
        engine.handleAudioStarted(payload);
    });

    ipcMain.on(IPC_CHANNELS.AUDIO_COMPLETE, (_event, messageId: string) => {
        engine.handleAudioComplete(messageId);
    });

    ipcMain.on(IPC_CHANNELS.LOG, (_event, message: string) => {
        console.log(message);
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

    ipcMain.handle(IPC_CHANNELS.STOP_SESSION, async () => {
        await engine.stopSession();
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

    ipcMain.handle(IPC_CHANNELS.LOAD_SCENARIOS, async () => {
        return engine.loadScenarios();
    });

    ipcMain.handle(IPC_CHANNELS.FAVORITE_CHAT, async (_event, chatId: string, favorite: boolean) => {
        return engine.favoriteChat(chatId, favorite);
    });

    ipcMain.handle(IPC_CHANNELS.DELETE_CHAT, async (_event, chatId: string) => {
        return engine.deleteChat(chatId);
    });

    ipcMain.handle(IPC_CHANNELS.REFRESH_CHARACTERS, async () => {
        return engine.refreshCharacters();
    });

    // ---- Server Manager ----

    serverManager.on('server-status-changed', (status: ServerStatus) => {
        win.webContents.send(IPC_CHANNELS.SERVER_STATUS_CHANGED, status);
    });

    serverManager.on('server-console-line', (line: ServerConsoleLine) => {
        win.webContents.send(IPC_CHANNELS.SERVER_CONSOLE_LINE, line);
    });

    serverManager.on('server-setup-progress', (progress: SetupProgress) => {
        win.webContents.send(IPC_CHANNELS.SERVER_SETUP_PROGRESS, progress);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_IS_INSTALLED, async () => {
        return serverManager.isInstalled();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_INSTALLED_VERSION, async () => {
        return serverManager.getInstalledVersion();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_VERSIONS, async () => {
        return serverManager.getAvailableVersions();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SETUP, async (_event, version: string) => {
        await serverManager.setup(version);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_START, async () => {
        await serverManager.start();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_STOP, async () => {
        await serverManager.stop();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SEND_COMMAND, async (_event, cmd: string) => {
        serverManager.sendCommand(cmd);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_STATUS, async () => {
        return serverManager.getStatus();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_PROPERTIES, async () => {
        return serverManager.getProperties();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SAVE_PROPERTIES, async (_event, props: ServerProperties) => {
        await serverManager.saveProperties(props);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_PLUGINS, async () => {
        return serverManager.getPlugins();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_CATALOG, () => {
        return serverManager.getCatalog();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_INSTALL_PLUGIN, async (_event, pluginId: string) => {
        await serverManager.installPlugin(pluginId);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_REMOVE_PLUGIN, async (_event, fileName: string) => {
        await serverManager.removePlugin(fileName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_WORLDS, async () => {
        return serverManager.getWorlds();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SET_ACTIVE_WORLD, async (_event, worldName: string) => {
        await serverManager.setActiveWorld(worldName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_RENAME_WORLD, async (_event, oldName: string, newName: string) => {
        await serverManager.renameWorld(oldName, newName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_DELETE_WORLD, async (_event, worldName: string) => {
        await serverManager.deleteWorld(worldName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_CREATE_WORLD, async (_event, worldName: string) => {
        await serverManager.createWorld(worldName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_CONFIG, async () => {
        return serverManager.getServerConfig();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SAVE_CONFIG, async (_event, config: ServerConfig) => {
        await serverManager.saveServerConfig(config);
    });

    // Hangar Plugin Store
    ipcMain.handle(IPC_CHANNELS.SERVER_HANGAR_SEARCH, async (_event, query: string, offset: number) => {
        return serverManager.hangarSearch(query, offset);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_HANGAR_PROJECT, async (_event, owner: string, slug: string) => {
        return serverManager.hangarGetProject(owner, slug);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_HANGAR_VERSIONS, async (_event, owner: string, slug: string) => {
        return serverManager.hangarGetVersions(owner, slug);
    });

    ipcMain.handle(
        IPC_CHANNELS.SERVER_HANGAR_INSTALL,
        async (_event, owner: string, slug: string, versionName: string) => {
            await serverManager.hangarInstallPlugin(owner, slug, versionName);
        },
    );

    return serverManager;
}
