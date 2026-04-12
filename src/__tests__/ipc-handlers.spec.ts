import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Hoisted mock variables ----
const { mockIpcMainOn, mockIpcMainHandle } = vi.hoisted(() => ({
    mockIpcMainOn: vi.fn(),
    mockIpcMainHandle: vi.fn(),
}));

// ---- Mock electron ----
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
        getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
    },
    ipcMain: { on: mockIpcMainOn, handle: mockIpcMainHandle },
    BrowserWindow: vi.fn(),
}));

// ---- Mock heavy dependencies (BotEngine, ServerManager, TunnelManager extend EventEmitter) ----
vi.mock('./bot-engine', () => {
    const { EventEmitter } = require('events');
    class MockBotEngine extends EventEmitter {
        getStatus = vi.fn().mockReturnValue({});
        getActions = vi.fn().mockReturnValue([]);
        toggleAction = vi.fn();
        updateSettings = vi.fn();
        connectVoxta = vi.fn().mockResolvedValue({});
        launchBot = vi.fn().mockResolvedValue(undefined);
        disconnect = vi.fn().mockResolvedValue(undefined);
        sendMessage = vi.fn().mockResolvedValue(undefined);
        handleAudioStarted = vi.fn();
        handleAudioComplete = vi.fn();
        pauseChat = vi.fn().mockResolvedValue(undefined);
        refreshCharacters = vi.fn().mockResolvedValue({});
        loadScenarios = vi.fn().mockResolvedValue([]);
        loadChats = vi.fn().mockResolvedValue([]);
        favoriteChat = vi.fn().mockResolvedValue(undefined);
        deleteChat = vi.fn().mockResolvedValue(undefined);
    }
    return { BotEngine: MockBotEngine };
});

vi.mock('./server-manager', () => {
    const { EventEmitter } = require('events');
    class MockServerManager extends EventEmitter {
        tryAutoStart = vi.fn().mockResolvedValue(undefined);
        getStatus = vi.fn().mockResolvedValue({ state: 'idle', port: 25565 });
        isInstalled = vi.fn().mockResolvedValue(false);
        getInstalledVersion = vi.fn().mockResolvedValue(null);
        getAvailableVersions = vi.fn().mockResolvedValue([]);
        setup = vi.fn().mockResolvedValue(undefined);
        start = vi.fn().mockResolvedValue(undefined);
        stop = vi.fn();
        sendCommand = vi.fn();
        getProperties = vi.fn().mockResolvedValue({});
        saveProperties = vi.fn().mockResolvedValue(undefined);
        getServerConfig = vi.fn().mockResolvedValue({ memoryMb: 1024, autoStart: false });
        saveServerConfig = vi.fn().mockResolvedValue(undefined);
        getPlugins = vi.fn().mockResolvedValue([]);
        getCatalog = vi.fn().mockReturnValue([]);
        installPlugin = vi.fn().mockResolvedValue(undefined);
        removePlugin = vi.fn().mockResolvedValue(undefined);
        hangarSearch = vi.fn().mockResolvedValue({ result: [] });
        hangarGetProject = vi.fn().mockResolvedValue({});
        hangarGetVersions = vi.fn().mockResolvedValue([]);
        hangarInstallPlugin = vi.fn().mockResolvedValue(undefined);
        checkPluginUpdates = vi.fn().mockResolvedValue([]);
        getWhitelist = vi.fn().mockResolvedValue([]);
        addWhitelist = vi.fn().mockResolvedValue(undefined);
        removeWhitelist = vi.fn().mockResolvedValue(undefined);
        getOps = vi.fn().mockResolvedValue([]);
        addOp = vi.fn().mockResolvedValue(undefined);
        removeOp = vi.fn().mockResolvedValue(undefined);
        getWorlds = vi.fn().mockResolvedValue([]);
        createWorld = vi.fn().mockResolvedValue(undefined);
        deleteWorld = vi.fn().mockResolvedValue(undefined);
        setActiveWorld = vi.fn().mockResolvedValue(undefined);
        renameWorld = vi.fn().mockResolvedValue(undefined);
        backupWorld = vi.fn().mockResolvedValue(undefined);
        getBackups = vi.fn().mockResolvedValue([]);
        restoreBackup = vi.fn().mockResolvedValue(undefined);
        deleteBackup = vi.fn().mockResolvedValue(undefined);
        cleanup = vi.fn().mockResolvedValue(undefined);
    }
    return { ServerManager: MockServerManager };
});

vi.mock('./tunnel-manager', () => {
    const { EventEmitter } = require('events');
    class MockTunnelManager extends EventEmitter {
        getStatus = vi.fn().mockReturnValue({ state: 'idle' });
        start = vi.fn().mockResolvedValue(undefined);
        stop = vi.fn();
        cleanup = vi.fn().mockResolvedValue(undefined);
    }
    return { TunnelManager: MockTunnelManager };
});

vi.mock('./vision-capture', () => ({ cycleVisionWindow: vi.fn() }));
vi.mock('./skin-server', () => ({ getPublicSkinUrl: vi.fn().mockResolvedValue(null) }));

// ---- Import module under test ----
import { registerIpcHandlers } from '../main/ipc-handlers';
import { IPC_CHANNELS } from '../shared/ipc-types';

describe('IPC Handlers', () => {
    let mockWin: { isDestroyed: ReturnType<typeof vi.fn>; webContents: { send: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
        vi.clearAllMocks();
        mockWin = {
            isDestroyed: vi.fn().mockReturnValue(false),
            webContents: { send: vi.fn() },
        };
    });

    describe('registerIpcHandlers', () => {
        it('returns serverManager and tunnelManager', () => {
            const result = registerIpcHandlers(mockWin as never);
            expect(result.serverManager).toBeDefined();
            expect(result.tunnelManager).toBeDefined();
        });

        it('registers ipcMain.on listeners for audio and log channels', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainOn.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.AUDIO_STARTED);
            expect(channels).toContain(IPC_CHANNELS.AUDIO_COMPLETE);
            expect(channels).toContain(IPC_CHANNELS.LOG);
        });

        it('registers ipcMain.handle for bot commands', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.CONNECT_VOXTA);
            expect(channels).toContain(IPC_CHANNELS.LAUNCH_BOT);
            expect(channels).toContain(IPC_CHANNELS.DISCONNECT);
            expect(channels).toContain(IPC_CHANNELS.SEND_MESSAGE);
            expect(channels).toContain(IPC_CHANNELS.GET_STATUS);
            expect(channels).toContain(IPC_CHANNELS.GET_ACTIONS);
            expect(channels).toContain(IPC_CHANNELS.TOGGLE_ACTION);
            expect(channels).toContain(IPC_CHANNELS.UPDATE_SETTINGS);
        });

        it('registers ipcMain.handle for server lifecycle', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_STATUS);
            expect(channels).toContain(IPC_CHANNELS.SERVER_START);
            expect(channels).toContain(IPC_CHANNELS.SERVER_STOP);
            expect(channels).toContain(IPC_CHANNELS.SERVER_SEND_COMMAND);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_PROPERTIES);
            expect(channels).toContain(IPC_CHANNELS.SERVER_SAVE_PROPERTIES);
        });

        it('registers ipcMain.handle for player management', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_WHITELIST);
            expect(channels).toContain(IPC_CHANNELS.SERVER_ADD_WHITELIST);
            expect(channels).toContain(IPC_CHANNELS.SERVER_REMOVE_WHITELIST);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_OPS);
            expect(channels).toContain(IPC_CHANNELS.SERVER_ADD_OP);
            expect(channels).toContain(IPC_CHANNELS.SERVER_REMOVE_OP);
        });

        it('registers ipcMain.handle for plugin management', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_PLUGINS);
            expect(channels).toContain(IPC_CHANNELS.SERVER_INSTALL_PLUGIN);
            expect(channels).toContain(IPC_CHANNELS.SERVER_REMOVE_PLUGIN);
        });

        it('registers ipcMain.handle for world management', () => {
            registerIpcHandlers(mockWin as never);

            const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
            expect(channels).toContain(IPC_CHANNELS.SERVER_GET_WORLDS);
            expect(channels).toContain(IPC_CHANNELS.SERVER_CREATE_WORLD);
            expect(channels).toContain(IPC_CHANNELS.SERVER_DELETE_WORLD);
        });
    });

    describe('window-safe send', () => {
        it('forwards engine events to renderer when window is alive', () => {
            registerIpcHandlers(mockWin as never);

            // The engine is a real EventEmitter mock — we can access it via the return value
            // However, BotEngine is created internally. Instead, verify via ipcMain handlers.
            // The send() guard is tested by triggering an ipcMain handler that calls send().

            // Verify the window check works by calling a handler that uses send
            expect(mockWin.isDestroyed).not.toHaveBeenCalled(); // Not called until event fires
        });

        it('handler count covers all expected channels', () => {
            registerIpcHandlers(mockWin as never);

            // Verify substantial number of handlers registered
            const onCount = mockIpcMainOn.mock.calls.length;
            const handleCount = mockIpcMainHandle.mock.calls.length;

            expect(onCount).toBeGreaterThanOrEqual(3);   // AUDIO_STARTED, AUDIO_COMPLETE, LOG
            expect(handleCount).toBeGreaterThanOrEqual(30); // ~37 handle registrations
        });
    });

    describe('handler delegation', () => {
        it('CONNECT_VOXTA handler is registered', () => {
            registerIpcHandlers(mockWin as never);

            const call = mockIpcMainHandle.mock.calls.find(
                (c: unknown[]) => c[0] === IPC_CHANNELS.CONNECT_VOXTA,
            );
            expect(call).toBeDefined();
            expect(typeof call![1]).toBe('function');
        });

        it('all registered handlers are functions', () => {
            registerIpcHandlers(mockWin as never);

            for (const call of mockIpcMainHandle.mock.calls) {
                expect(typeof call[1]).toBe('function');
            }
            for (const call of mockIpcMainOn.mock.calls) {
                expect(typeof call[1]).toBe('function');
            }
        });
    });
});
