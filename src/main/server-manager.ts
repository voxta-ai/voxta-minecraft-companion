import { EventEmitter } from 'events';
import { spawn, exec, ChildProcess } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { fetchJson, downloadFile } from './server-http';
import { PluginManager } from './plugin-manager';
import { WorldManager } from './world-manager';
import { PlayerManager } from './player-manager';
import type {
    ServerState,
    ServerStatus,
    ServerConsoleLine,
    SetupProgress,
    PluginInfo,
    CatalogPlugin,
    WorldInfo,
    WorldBackup,
    WhitelistEntry,
    OpsEntry,
    ServerProperties,
    HangarSearchResult,
    HangarProjectDetail,
    HangarVersion,
    PluginUpdateInfo,
} from '../shared/ipc-types';

const PAPER_API = 'https://api.papermc.io';

// Bundled voice bridge JAR — built from plugins/voxta-voice-bridge/
const VOICE_BRIDGE_JAR = 'voxta-voice-bridge-1.0.0.jar';

// Default server.properties for a fresh Voxta-optimized setup
const DEFAULT_SERVER_PROPERTIES = `online-mode=false
server-port=25565
gamemode=survival
difficulty=easy
spawn-monsters=true
spawn-animals=true
level-type=minecraft\\:normal
max-players=5
motd=Voxta Test Server
enable-command-block=true
`;

const DEFAULT_OPS = JSON.stringify(
    [
        {
            uuid: '20dc804b-ed2f-3055-8092-72dd788b9b23',
            name: 'Emptyngton',
            level: 4,
            bypassesPlayerLimit: false,
        },
    ],
    null,
    2,
);

export class ServerManager extends EventEmitter {
    private readonly serverDir: string;
    private state: ServerState = 'not-installed';
    private port = 25565;
    private error: string | undefined;
    private childProcess: ChildProcess | null = null;
    private stopTimeout: ReturnType<typeof setTimeout> | null = null;

    // Delegated managers
    readonly plugins: PluginManager;
    readonly worlds: WorldManager;
    readonly players: PlayerManager;

    constructor() {
        super();
        this.serverDir = path.join(app.getPath('userData'), 'paper-server');
        this.plugins = new PluginManager(this.serverDir);
        this.worlds = new WorldManager(this.serverDir);
        this.players = new PlayerManager(this.serverDir);
    }

    // ---- Public API: Server Lifecycle ----

    async isInstalled(): Promise<boolean> {
        try {
            await fs.access(path.join(this.serverDir, 'paper.jar'));
            return true;
        } catch {
            return false;
        }
    }

    async getInstalledVersion(): Promise<string | null> {
        try {
            const version = await fs.readFile(path.join(this.serverDir, 'version.txt'), 'utf-8');
            return version.trim();
        } catch {
            return null;
        }
    }

    async getAvailableVersions(): Promise<string[]> {
        const data = await fetchJson(`${PAPER_API}/v2/projects/paper`);
        const versions = data.versions as string[];
        const stable = versions.filter((v) => !v.includes('-'));
        return stable.reverse().slice(0, 15);
    }

    async setup(version: string): Promise<void> {
        const totalSteps = 4;

        // Step 1: Create server directory
        this.emitProgress({ step: 1, totalSteps, label: 'Creating server directory...' });
        await fs.mkdir(this.serverDir, { recursive: true });
        await fs.mkdir(path.join(this.serverDir, 'plugins'), { recursive: true });

        // Step 2: Download Paper JAR
        this.emitProgress({ step: 2, totalSteps, label: `Downloading Paper ${version}...` });
        await this.downloadPaper(version);

        // Step 3: Write config files
        this.emitProgress({ step: 3, totalSteps, label: 'Writing server configuration...' });
        await this.writeDefaultConfigs();

        // Step 4: Download default plugins (SkinsRestorer, Simple Voice Chat, Voice Bridge)
        this.emitProgress({ step: 4, totalSteps, label: 'Installing plugins...' });
        const skinsRestorer = this.plugins.getCatalog().find((p) => p.id === 'skinsrestorer');
        if (skinsRestorer) {
            const dest = path.join(this.serverDir, 'plugins', skinsRestorer.fileName);
            try {
                await fs.access(dest);
            } catch {
                await this.plugins.installCatalogPlugin('skinsrestorer', (p) => this.emitProgress(p));
            }
        }
        await this.plugins.installSimpleVoiceChat(
            (text, level) => this.emitConsoleLine(text, level),
        );
        await this.installVoiceBridge();

        // Save installed version
        await fs.writeFile(path.join(this.serverDir, 'version.txt'), version);

        this.setState('idle');
        this.emitProgress({ step: totalSteps, totalSteps, label: 'Setup complete!' });
    }

    async start(): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') return;

        const installed = await this.isInstalled();
        if (!installed) {
            this.setState('not-installed');
            throw new Error('Server not installed. Run setup first.');
        }

        // Write eula.txt every time to ensure it's accepted
        await fs.writeFile(path.join(this.serverDir, 'eula.txt'), 'eula=true\n');

        // Ensure voice bridge plugin is up to date
        await this.installVoiceBridge();

        this.setState('starting');

        const jarPath = path.join(this.serverDir, 'paper.jar');
        const memoryMb = await this.getMemoryMb();
        this.childProcess = spawn('java', [`-Xmx${memoryMb}M`, `-Xms${memoryMb}M`, '-jar', jarPath, '--nogui'], {
            cwd: this.serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.childProcess.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                this.emitConsoleLine(line, this.parseLogLevel(line));

                if (line.includes('Done (') || line.includes('Done!')) {
                    this.setState('running');
                }

                const portMatch = line.match(/Starting Minecraft server on \*:(\d+)/);
                if (portMatch) {
                    this.port = parseInt(portMatch[1], 10);
                }
            }
        });

        this.childProcess.stderr?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                this.emitConsoleLine(line, 'error');
            }
        });

        this.childProcess.on('close', (code) => {
            this.childProcess = null;
            if (this.stopTimeout) {
                clearTimeout(this.stopTimeout);
                this.stopTimeout = null;
            }

            if (this.state === 'stopping') {
                this.setState('idle');
            } else if (code !== 0 && code !== null) {
                this.error = `Server exited with code ${code}`;
                this.setState('error');
            } else {
                this.setState('idle');
            }
        });

        this.childProcess.on('error', (err) => {
            this.childProcess = null;
            this.error = err.message;
            this.setState('error');
            this.emitConsoleLine(`Failed to start server: ${err.message}`, 'error');
        });
    }

    stop(): void {
        if (!this.childProcess || this.state === 'stopping' || this.state === 'idle') return;

        this.setState('stopping');
        this.emitConsoleLine('Sending stop command...', 'info');

        this.childProcess.stdin?.write('stop\n');

        this.stopTimeout = setTimeout(() => {
            if (this.childProcess) {
                this.emitConsoleLine('Server did not stop gracefully, force killing...', 'warn');
                this.forceKillTree();
            }
        }, 15000);
    }

    sendCommand(cmd: string): void {
        if (!this.childProcess || this.state !== 'running') return;
        this.childProcess.stdin?.write(`${cmd}\n`);
        this.emitConsoleLine(`> ${cmd}`, 'info');
    }

    async getStatus(): Promise<ServerStatus> {
        if (this.state === 'not-installed' && await this.isInstalled()) {
            this.state = 'idle';
        }
        return {
            state: this.state,
            port: this.port,
            error: this.error,
        };
    }

    isRunning(): boolean {
        return this.childProcess !== null;
    }

    // ---- Public API: Properties & Config ----

    async getProperties(): Promise<ServerProperties> {
        const propsPath = path.join(this.serverDir, 'server.properties');
        try {
            const content = await fs.readFile(propsPath, 'utf-8');
            return this.parseProperties(content);
        } catch {
            return {};
        }
    }

    async saveProperties(props: ServerProperties): Promise<void> {
        const propsPath = path.join(this.serverDir, 'server.properties');
        let content: string;

        try {
            content = await fs.readFile(propsPath, 'utf-8');
        } catch {
            content = '';
        }

        // Detect whitelist toggle change and apply live if server running
        if (this.isRunning()) {
            const oldProps = this.parseProperties(content);
            if (props['white-list'] !== oldProps['white-list']) {
                this.sendCommand(props['white-list'] === 'true' ? 'whitelist on' : 'whitelist off');
            }
        }

        const updatedContent = this.updatePropertiesContent(content, props);
        await fs.writeFile(propsPath, updatedContent);
    }

    async getServerConfig(): Promise<{ memoryMb: number; autoStart: boolean }> {
        const memoryMb = await this.getMemoryMb();
        const autoStart = await this.getAutoStart();
        return { memoryMb, autoStart };
    }

    async saveServerConfig(config: { memoryMb: number; autoStart: boolean }): Promise<void> {
        const configPath = path.join(this.serverDir, 'voxta-config.json');
        await fs.writeFile(configPath, JSON.stringify(config, null, 2));
    }

    async tryAutoStart(): Promise<void> {
        try {
            const installed = await this.isInstalled();
            if (!installed) return;
            const autoStart = await this.getAutoStart();
            if (!autoStart) return;
            console.log('[Server] Auto-starting server...');
            await this.start();
        } catch (err) {
            console.error('[Server] Auto-start failed:', err);
        }
    }

    // ---- Public API: Delegated to PluginManager ----

    getPlugins(): Promise<PluginInfo[]> { return this.plugins.getPlugins(); }
    getCatalog(): CatalogPlugin[] { return this.plugins.getCatalog(); }
    installPlugin(pluginId: string): Promise<void> { return this.plugins.installCatalogPlugin(pluginId, (p) => this.emitProgress(p)); }
    removePlugin(fileName: string): Promise<void> { return this.plugins.removePlugin(fileName, this.isRunning()); }
    hangarSearch(query: string, offset?: number): Promise<HangarSearchResult> { return this.plugins.hangarSearch(query, offset); }
    hangarGetProject(owner: string, slug: string): Promise<HangarProjectDetail> { return this.plugins.hangarGetProject(owner, slug); }
    hangarGetVersions(owner: string, slug: string): Promise<HangarVersion[]> { return this.plugins.hangarGetVersions(owner, slug); }
    hangarInstallPlugin(owner: string, slug: string, versionName: string): Promise<void> { return this.plugins.hangarInstallPlugin(owner, slug, versionName, (p) => this.emitProgress(p)); }
    async checkPluginUpdates(): Promise<PluginUpdateInfo[]> { return this.plugins.checkPluginUpdates(await this.getInstalledVersion()); }

    // ---- Public API: Delegated to WorldManager ----

    getWorlds(): Promise<WorldInfo[]> { return this.worlds.getWorlds(() => this.getProperties()); }
    setActiveWorld(worldName: string): Promise<void> { return this.worlds.setActiveWorld(worldName, this.isRunning(), (p) => this.saveProperties(p)); }
    renameWorld(oldName: string, newName: string): Promise<void> { return this.worlds.renameWorld(oldName, newName, this.isRunning(), () => this.getProperties(), (p) => this.saveProperties(p)); }
    deleteWorld(worldName: string): Promise<void> { return this.worlds.deleteWorld(worldName, this.isRunning(), () => this.getProperties(), (p) => this.saveProperties(p)); }
    createWorld(worldName: string, seed?: string): Promise<void> { return this.worlds.createWorld(worldName, seed, this.isRunning(), (p) => this.saveProperties(p)); }
    backupWorld(worldName: string): Promise<void> { return this.worlds.backupWorld(worldName); }
    getBackups(worldName: string): Promise<WorldBackup[]> { return this.worlds.getBackups(worldName); }
    restoreBackup(backupId: string): Promise<void> { return this.worlds.restoreBackup(backupId, this.isRunning()); }
    deleteBackup(backupId: string): Promise<void> { return this.worlds.deleteBackup(backupId); }

    // ---- Public API: Delegated to PlayerManager ----

    getWhitelist(): Promise<WhitelistEntry[]> { return this.players.getWhitelist(); }
    addWhitelist(name: string): Promise<void> { return this.players.addWhitelist(name, this.isRunning() ? (cmd) => this.sendCommand(cmd) : undefined); }
    removeWhitelist(name: string): Promise<void> { return this.players.removeWhitelist(name, this.isRunning() ? (cmd) => this.sendCommand(cmd) : undefined); }
    getOps(): Promise<OpsEntry[]> { return this.players.getOps(); }
    addOp(name: string): Promise<void> { return this.players.addOp(name, this.isRunning() ? (cmd) => this.sendCommand(cmd) : undefined); }
    removeOp(name: string): Promise<void> { return this.players.removeOp(name, this.isRunning() ? (cmd) => this.sendCommand(cmd) : undefined); }

    // ---- Cleanup ----

    async cleanup(): Promise<void> {
        if (this.childProcess) {
            try { this.childProcess.stdin?.write('stop\n'); } catch { /* pipe may be broken */ }
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    this.forceKillTree();
                    resolve();
                }, 5000);

                if (this.childProcess) {
                    this.childProcess.on('close', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        }
    }

    /** Force kill the server process and its entire child process tree. */
    private forceKillTree(): void {
        if (!this.childProcess) return;
        const pid = this.childProcess.pid;
        if (pid && process.platform === 'win32') {
            exec(`taskkill /F /T /PID ${pid}`, (err) => {
                if (err) console.warn(`[Server] taskkill failed: ${err.message}`);
            });
        } else {
            this.childProcess.kill('SIGKILL');
        }
    }

    // ---- Internal Helpers ----

    private setState(state: ServerState): void {
        this.state = state;
        if (state !== 'error') this.error = undefined;
        this.emit('server-status-changed', {
            state: this.state,
            port: this.port,
            error: this.error,
        });
    }

    private emitConsoleLine(text: string, level: 'info' | 'warn' | 'error'): void {
        const line: ServerConsoleLine = { timestamp: Date.now(), text, level };
        this.emit('server-console-line', line);
    }

    private emitProgress(progress: SetupProgress): void {
        this.emit('server-setup-progress', progress);
    }

    private parseLogLevel(line: string): 'info' | 'warn' | 'error' {
        if (line.includes('WARN') || line.includes('WARNING')) return 'warn';
        if (line.includes('ERROR') || line.includes('SEVERE') || line.includes('FATAL')) return 'error';
        return 'info';
    }

    private parseProperties(content: string): ServerProperties {
        const props: ServerProperties = {};
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            props[trimmed.substring(0, eqIdx)] = trimmed.substring(eqIdx + 1);
        }
        return props;
    }

    private updatePropertiesContent(original: string, updates: ServerProperties): string {
        if (!original.trim()) {
            return Object.entries(updates)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n') + '\n';
        }

        const updatedKeys = new Set<string>();
        const lines = original.split('\n').map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) return line;
            const key = trimmed.substring(0, eqIdx);
            if (key in updates) {
                updatedKeys.add(key);
                return `${key}=${updates[key]}`;
            }
            return line;
        });

        for (const [key, value] of Object.entries(updates)) {
            if (!updatedKeys.has(key)) {
                lines.push(`${key}=${value}`);
            }
        }

        return lines.join('\n');
    }

    private async getMemoryMb(): Promise<number> {
        try {
            const configPath = path.join(this.serverDir, 'voxta-config.json');
            const content = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(content) as Record<string, unknown>;
            const memoryMb = config['memoryMb'];
            if (typeof memoryMb === 'number' && memoryMb >= 512) return memoryMb;
        } catch {
            // No config file or invalid — use default
        }
        return 1024;
    }

    private async getAutoStart(): Promise<boolean> {
        try {
            const configPath = path.join(this.serverDir, 'voxta-config.json');
            const content = await fs.readFile(configPath, 'utf-8');
            const config = JSON.parse(content) as Record<string, unknown>;
            return config['autoStart'] === true;
        } catch {
            return false;
        }
    }

    private async downloadPaper(version: string): Promise<void> {
        const buildsUrl = `${PAPER_API}/v2/projects/paper/versions/${version}/builds`;
        const buildsData = await fetchJson(buildsUrl);
        const builds = buildsData.builds as Array<{ build: number; downloads: { application: { name: string } } }>;
        const latestBuild = builds[builds.length - 1];
        const buildNumber = latestBuild.build;
        const downloadName = latestBuild.downloads.application.name;

        this.emitConsoleLine(`Found Paper build #${buildNumber} (${downloadName})`, 'info');

        const downloadUrl = `${PAPER_API}/v2/projects/paper/versions/${version}/builds/${buildNumber}/downloads/${downloadName}`;
        const dest = path.join(this.serverDir, 'paper.jar');
        await downloadFile(downloadUrl, dest, (p) => this.emitProgress(p));
    }

    private async installVoiceBridge(): Promise<void> {
        const pluginsDir = path.join(this.serverDir, 'plugins');
        await fs.mkdir(pluginsDir, { recursive: true });
        const dest = path.join(pluginsDir, VOICE_BRIDGE_JAR);

        const candidates = [
            path.join(process.resourcesPath, 'plugins', VOICE_BRIDGE_JAR),
            path.join(app.getAppPath(), '..', '..', 'plugins', 'voxta-voice-bridge', 'build', 'libs', VOICE_BRIDGE_JAR),
            path.join(process.cwd(), 'plugins', 'voxta-voice-bridge', 'build', 'libs', VOICE_BRIDGE_JAR),
        ];

        console.log(`[VoiceBridge] Looking for JAR: ${VOICE_BRIDGE_JAR}`);
        for (const src of candidates) {
            try {
                await fs.access(src);
                await fs.copyFile(src, dest);
                console.log(`[VoiceBridge] Installed from: ${src}`);
                this.emitConsoleLine(`Installed voice bridge plugin: ${VOICE_BRIDGE_JAR}`, 'info');
                return;
            } catch {
                console.log(`[VoiceBridge] Not found at: ${src}`);
            }
        }

        console.warn(`[VoiceBridge] JAR not found in any candidate path — SVC integration unavailable`);
        console.warn(`[VoiceBridge] Build it with: cd plugins/voxta-voice-bridge && ./gradlew.bat build`);
        this.emitConsoleLine('Voice bridge JAR not found — SVC integration will be unavailable', 'warn');
    }

    private async writeDefaultConfigs(): Promise<void> {
        const propsPath = path.join(this.serverDir, 'server.properties');
        const opsPath = path.join(this.serverDir, 'ops.json');
        const eulaPath = path.join(this.serverDir, 'eula.txt');

        try {
            await fs.access(propsPath);
        } catch {
            await fs.writeFile(propsPath, DEFAULT_SERVER_PROPERTIES);
        }

        try {
            await fs.access(opsPath);
        } catch {
            await fs.writeFile(opsPath, DEFAULT_OPS);
        }

        await fs.writeFile(eulaPath, 'eula=true\n');
    }
}
