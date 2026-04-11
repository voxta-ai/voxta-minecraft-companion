import { ipcMain, BrowserWindow } from 'electron';
import { BotEngine } from './bot-engine';
import { ServerManager } from './server-manager';
import { TunnelManager } from './tunnel-manager';
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
    TunnelStatus,
} from '../shared/ipc-types';

export function registerIpcHandlers(win: BrowserWindow): { serverManager: ServerManager; tunnelManager: TunnelManager } {
    const engine = new BotEngine();
    const serverManager = new ServerManager();
    const tunnelManager = new TunnelManager(serverManager);

    // Safe send — skip if window is already destroyed (e.g. during quit)
    function send(channel: string, ...args: unknown[]): void {
        if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    }

    // Forward events to renderer
    engine.on('status-changed', (status: BotStatus) => {
        send(IPC_CHANNELS.STATUS_CHANGED, status);
    });

    engine.on('chat-message', (msg: ChatMessage) => {
        send(IPC_CHANNELS.CHAT_MESSAGE, msg);
    });

    engine.on('clear-chat', () => {
        send(IPC_CHANNELS.CLEAR_CHAT);
    });

    engine.on('inspector-update', (data: InspectorData) => {
        send(IPC_CHANNELS.INSPECTOR_UPDATE, data);
    });

    engine.on('action-triggered', (actionName: string) => {
        send(IPC_CHANNELS.ACTION_TRIGGERED, actionName);
    });

    engine.on('toast', (toast: ToastMessage) => {
        send(IPC_CHANNELS.TOAST, toast);
    });

    engine.on('play-audio', (chunk: AudioChunk) => {
        send(IPC_CHANNELS.PLAY_AUDIO, chunk);
    });

    engine.on('stop-audio', () => {
        send(IPC_CHANNELS.STOP_AUDIO);
    });

    engine.on('recording-start', (event: RecordingStartEvent) => {
        send(IPC_CHANNELS.RECORDING_START, event);
    });

    engine.on('recording-stop', () => {
        send(IPC_CHANNELS.RECORDING_STOP);
    });

    engine.on('speech-partial', (text: string) => {
        send(IPC_CHANNELS.SPEECH_PARTIAL, text);
    });

    engine.on('spatial-position', (data: SpatialPosition) => {
        send(IPC_CHANNELS.SPATIAL_POSITION, data);
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
        // Auto-start server in background when connecting to Voxta
        void serverManager.tryAutoStart();
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

    ipcMain.handle(IPC_CHANNELS.PAUSE_CHAT, async (_event, pause: boolean) => {
        return engine.pauseChat(pause);
    });

    // ---- Server Manager ----

    serverManager.on('server-status-changed', (status: ServerStatus) => {
        send(IPC_CHANNELS.SERVER_STATUS_CHANGED, status);
    });

    serverManager.on('server-console-line', (line: ServerConsoleLine) => {
        send(IPC_CHANNELS.SERVER_CONSOLE_LINE, line);
    });

    serverManager.on('server-setup-progress', (progress: SetupProgress) => {
        send(IPC_CHANNELS.SERVER_SETUP_PROGRESS, progress);
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

    ipcMain.handle(IPC_CHANNELS.SERVER_STOP, () => {
        serverManager.stop();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SEND_COMMAND, (_event, cmd: string) => {
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

    ipcMain.handle(IPC_CHANNELS.SERVER_CREATE_WORLD, async (_event, worldName: string, seed?: string) => {
        await serverManager.createWorld(worldName, seed);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_CONFIG, async () => {
        return serverManager.getServerConfig();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_SAVE_CONFIG, async (_event, config: ServerConfig) => {
        await serverManager.saveServerConfig(config);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_BACKUP_WORLD, async (_event, worldName: string) => {
        await serverManager.backupWorld(worldName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_BACKUPS, async (_event, worldName: string) => {
        return serverManager.getBackups(worldName);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_RESTORE_BACKUP, async (_event, backupId: string) => {
        await serverManager.restoreBackup(backupId);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_DELETE_BACKUP, async (_event, backupId: string) => {
        await serverManager.deleteBackup(backupId);
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

    ipcMain.handle(IPC_CHANNELS.SERVER_CHECK_PLUGIN_UPDATES, async () => {
        return serverManager.checkPluginUpdates();
    });

    // Player Management (Whitelist & Ops)
    ipcMain.handle(IPC_CHANNELS.SERVER_GET_WHITELIST, async () => {
        return serverManager.getWhitelist();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_ADD_WHITELIST, async (_event, name: string) => {
        await serverManager.addWhitelist(name);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_REMOVE_WHITELIST, async (_event, name: string) => {
        await serverManager.removeWhitelist(name);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_GET_OPS, async () => {
        return serverManager.getOps();
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_ADD_OP, async (_event, name: string) => {
        await serverManager.addOp(name);
    });

    ipcMain.handle(IPC_CHANNELS.SERVER_REMOVE_OP, async (_event, name: string) => {
        await serverManager.removeOp(name);
    });

    // ---- Tunnel Manager ----

    tunnelManager.on('tunnel-status-changed', (status: TunnelStatus) => {
        send(IPC_CHANNELS.TUNNEL_STATUS_CHANGED, status);
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_GET_STATUS, () => {
        return tunnelManager.getStatus();
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_IS_INSTALLED, async () => {
        return tunnelManager.isInstalled();
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_INSTALL, async () => {
        await tunnelManager.install();
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_START, async () => {
        await tunnelManager.start();
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_STOP, () => {
        tunnelManager.stop();
    });

    ipcMain.handle(IPC_CHANNELS.TUNNEL_SET_URL, (_event, url: string) => {
        tunnelManager.setTunnelUrl(url);
    });

    return { serverManager, tunnelManager };
}
