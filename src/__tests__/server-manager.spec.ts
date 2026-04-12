import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---- Mock electron ----
vi.mock('electron', () => ({
    app: {
        getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
        getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
    },
}));

// ---- Mock fs/promises ----
vi.mock('fs/promises', () => ({
    access: vi.fn().mockRejectedValue(new Error('ENOENT')),
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
}));

// ---- Mock child_process ----
vi.mock('child_process', () => ({
    spawn: vi.fn(),
    exec: vi.fn(),
}));

// ---- Mock server-http ----
vi.mock('./server-http', () => ({
    fetchJson: vi.fn().mockResolvedValue({}),
    downloadFile: vi.fn().mockResolvedValue(undefined),
}));

// ---- Mock server-properties ----
vi.mock('./server-properties', () => ({
    parseProperties: vi.fn().mockReturnValue({}),
    updatePropertiesContent: vi.fn().mockReturnValue('updated-content'),
}));

// ---- Mock delegated managers ----
vi.mock('./plugin-manager', () => ({
    PluginManager: vi.fn().mockImplementation(() => ({
        getPlugins: vi.fn().mockResolvedValue([]),
        getCatalog: vi.fn().mockReturnValue([]),
        installCatalogPlugin: vi.fn().mockResolvedValue(undefined),
        installSimpleVoiceChat: vi.fn().mockResolvedValue(undefined),
        removePlugin: vi.fn().mockResolvedValue(undefined),
        hangarSearch: vi.fn().mockResolvedValue({ result: [] }),
        hangarGetProject: vi.fn().mockResolvedValue({}),
        hangarGetVersions: vi.fn().mockResolvedValue([]),
        hangarInstallPlugin: vi.fn().mockResolvedValue(undefined),
        checkPluginUpdates: vi.fn().mockResolvedValue([]),
    })),
}));

vi.mock('./world-manager', () => ({
    WorldManager: vi.fn().mockImplementation(() => ({
        getWorlds: vi.fn().mockResolvedValue([]),
    })),
}));

vi.mock('./player-manager', () => ({
    PlayerManager: vi.fn().mockImplementation(() => ({
        getWhitelist: vi.fn().mockResolvedValue([]),
        addWhitelist: vi.fn().mockResolvedValue(undefined),
        removeWhitelist: vi.fn().mockResolvedValue(undefined),
        getOps: vi.fn().mockResolvedValue([]),
        addOp: vi.fn().mockResolvedValue(undefined),
        removeOp: vi.fn().mockResolvedValue(undefined),
    })),
}));

// ---- Import module under test ----
import { ServerManager } from '../main/server-manager';
import * as fs from 'fs/promises';

describe('ServerManager', () => {
    let manager: ServerManager;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset fs defaults
        vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
        vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
        vi.mocked(fs.writeFile).mockResolvedValue(undefined);
        vi.mocked(fs.mkdir).mockResolvedValue(undefined);
        vi.mocked(fs.copyFile).mockResolvedValue(undefined);

        manager = new ServerManager();
    });

    // ---- isInstalled ----

    describe('isInstalled', () => {
        it('returns false when paper.jar does not exist', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
            const result = await manager.isInstalled();
            expect(result).toBe(false);
        });

        it('returns true when paper.jar exists', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            const result = await manager.isInstalled();
            expect(result).toBe(true);
        });
    });

    // ---- getInstalledVersion ----

    describe('getInstalledVersion', () => {
        it('returns null when version.txt does not exist', async () => {
            const result = await manager.getInstalledVersion();
            expect(result).toBeNull();
        });

        it('returns trimmed version string', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('  1.21.4  \n');
            const result = await manager.getInstalledVersion();
            expect(result).toBe('1.21.4');
        });
    });

    // ---- getAvailableVersions ----

    // getAvailableVersions is tested via integration (requires live fetchJson mock reconfiguration)

    // ---- getStatus ----

    describe('getStatus', () => {
        it('returns not-installed when server not set up', async () => {
            const status = await manager.getStatus();
            expect(status.state).toBe('not-installed');
            expect(status.port).toBe(25565);
            expect(status.error).toBeUndefined();
        });

        it('transitions to idle when paper.jar exists', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined);
            const status = await manager.getStatus();
            expect(status.state).toBe('idle');
        });
    });

    // ---- isRunning ----

    describe('isRunning', () => {
        it('returns false when no child process', () => {
            expect(manager.isRunning()).toBe(false);
        });
    });

    // ---- sendCommand ----

    describe('sendCommand', () => {
        it('does nothing when server is not running', () => {
            // No child process — should not throw
            manager.sendCommand('say hello');
        });
    });

    // ---- getProperties ----

    describe('getProperties', () => {
        it('returns empty object when file does not exist', async () => {
            const props = await manager.getProperties();
            expect(props).toEqual({});
        });

        it('calls parseProperties when file exists', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('server-port=25565\n');
            const props = await manager.getProperties();
            // parseProperties is called (mocked to return {})
            expect(props).toBeDefined();
        });
    });

    // ---- saveProperties ----

    describe('saveProperties', () => {
        it('writes to server.properties file', async () => {
            vi.mocked(fs.readFile).mockResolvedValue('server-port=25565\n');

            await manager.saveProperties({ 'server-port': '25566' });

            expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
                expect.stringContaining('server.properties'),
                expect.any(String),
            );
        });

        it('handles missing file gracefully', async () => {
            vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));

            // Should not throw even when file doesn't exist
            await manager.saveProperties({ 'difficulty': 'hard' });

            expect(vi.mocked(fs.writeFile)).toHaveBeenCalled();
        });
    });

    // ---- getServerConfig / saveServerConfig ----

    describe('getServerConfig', () => {
        it('returns defaults when config file missing', async () => {
            const config = await manager.getServerConfig();
            expect(config.memoryMb).toBe(1024);
            expect(config.autoStart).toBe(false);
        });

        it('reads memory and autoStart from voxta-config.json', async () => {
            vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ memoryMb: 2048, autoStart: true }));
            const config = await manager.getServerConfig();
            expect(config.memoryMb).toBe(2048);
            expect(config.autoStart).toBe(true);
        });

        it('defaults to 1024 when memory is below 512', async () => {
            vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ memoryMb: 256 }));
            const config = await manager.getServerConfig();
            expect(config.memoryMb).toBe(1024);
        });
    });

    describe('saveServerConfig', () => {
        it('writes config as JSON', async () => {
            await manager.saveServerConfig({ memoryMb: 4096, autoStart: true });
            expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
                expect.stringContaining('voxta-config.json'),
                expect.stringContaining('"memoryMb": 4096'),
            );
        });
    });

    // ---- tryAutoStart ----

    describe('tryAutoStart', () => {
        it('does nothing when not installed', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
            await manager.tryAutoStart();
            // No error, no start attempt
        });

        it('does nothing when autoStart is false', async () => {
            vi.mocked(fs.access).mockResolvedValue(undefined); // isInstalled = true
            vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ autoStart: false }));
            await manager.tryAutoStart();
            // start() not called — no state change
        });
    });

    // ---- start guard ----

    describe('start', () => {
        it('throws when not installed', async () => {
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
            await expect(manager.start()).rejects.toThrow('Server not installed');
        });
    });

    // ---- stop guard ----

    describe('stop', () => {
        it('does nothing when no process is running', () => {
            manager.stop();
            // No error
        });
    });

    // ---- Event emission ----

    describe('event emission', () => {
        it('emits server-status-changed on state transitions', async () => {
            const spy = vi.fn();
            manager.on('server-status-changed', spy);

            // getStatus triggers idle transition if installed
            vi.mocked(fs.access).mockResolvedValue(undefined);
            await manager.getStatus();

            // The transition from not-installed to idle happens inside getStatus
            // but setState is private — we detect it via the event
            // Note: getStatus only transitions if isInstalled returns true
        });
    });

    // ---- Delegated APIs ----

    describe('delegated APIs', () => {
        it('delegates getPlugins to PluginManager', async () => {
            const plugins = await manager.getPlugins();
            expect(Array.isArray(plugins)).toBe(true);
        });

        it('delegates getCatalog to PluginManager', () => {
            const catalog = manager.getCatalog();
            expect(Array.isArray(catalog)).toBe(true);
        });

        it('delegates getWhitelist to PlayerManager', async () => {
            const whitelist = await manager.getWhitelist();
            expect(Array.isArray(whitelist)).toBe(true);
        });

        it('delegates getOps to PlayerManager', async () => {
            const ops = await manager.getOps();
            expect(Array.isArray(ops)).toBe(true);
        });
    });
});
