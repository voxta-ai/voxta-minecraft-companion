import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import * as http from 'http';
import type {
    ServerState,
    ServerStatus,
    ServerConsoleLine,
    SetupProgress,
    PluginInfo,
    CatalogPlugin,
    WorldInfo,
    ServerProperties,
    HangarSearchResult,
    HangarProjectDetail,
    HangarVersion,
} from '../shared/ipc-types';

// ---- Curated Plugin Catalog ----
// Official download URLs for vetted plugins that work well with Voxta bots.
// Expand this list over time.

const PLUGIN_CATALOG: CatalogPlugin[] = [
    {
        id: 'skinsrestorer',
        name: 'SkinsRestorer',
        description: 'Restore skins for offline-mode servers. Required for Voxta character skins.',
        downloadUrl: 'https://github.com/SkinsRestorer/SkinsRestorer/releases/latest/download/SkinsRestorer.jar',
        fileName: 'SkinsRestorer.jar',
    },
];

const PAPER_API = 'https://api.papermc.io';
const HANGAR_API = 'https://hangar.papermc.io/api/v1';

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
    private serverDir: string;
    private state: ServerState = 'not-installed';
    private port = 25565;
    private error: string | undefined;
    private childProcess: ChildProcess | null = null;
    private stopTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        super();
        this.serverDir = path.join(app.getPath('userData'), 'paper-server');
    }

    // ---- Public API ----

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
        const data = await this.fetchJson(`${PAPER_API}/v2/projects/paper`);
        const versions = data.versions as string[];
        // Filter out pre-releases and RCs, keep only stable versions, newest first
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

        // Step 4: Download default plugins (SkinsRestorer)
        this.emitProgress({ step: 4, totalSteps, label: 'Installing SkinsRestorer...' });
        const skinsRestorer = PLUGIN_CATALOG.find((p) => p.id === 'skinsrestorer');
        if (skinsRestorer) {
            const dest = path.join(this.serverDir, 'plugins', skinsRestorer.fileName);
            try {
                await fs.access(dest);
            } catch {
                await this.downloadFile(skinsRestorer.downloadUrl, dest);
            }
        }

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

        this.setState('starting');

        const jarPath = path.join(this.serverDir, 'paper.jar');
        this.childProcess = spawn('java', ['-Xmx1G', '-jar', jarPath, '--nogui'], {
            cwd: this.serverDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.childProcess.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                this.emitConsoleLine(line, this.parseLogLevel(line));

                // Detect server ready
                if (line.includes('Done (') || line.includes('Done!')) {
                    this.setState('running');
                }

                // Parse port from server output
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

    async stop(): Promise<void> {
        if (!this.childProcess || this.state === 'stopping' || this.state === 'idle') return;

        this.setState('stopping');
        this.emitConsoleLine('Sending stop command...', 'info');

        // Graceful shutdown via server stdin
        this.childProcess.stdin?.write('stop\n');

        // Force kill after 15 seconds
        this.stopTimeout = setTimeout(() => {
            if (this.childProcess) {
                this.emitConsoleLine('Server did not stop gracefully, force killing...', 'warn');
                this.childProcess.kill('SIGKILL');
            }
        }, 15000);
    }

    sendCommand(cmd: string): void {
        if (!this.childProcess || this.state !== 'running') return;
        this.childProcess.stdin?.write(`${cmd}\n`);
        this.emitConsoleLine(`> ${cmd}`, 'info');
    }

    async getStatus(): Promise<ServerStatus> {
        // Sync the state with reality on first check
        if (this.state === 'not-installed' && await this.isInstalled()) {
            this.state = 'idle';
        }
        return {
            state: this.state,
            port: this.port,
            error: this.error,
        };
    }

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
            // File doesn't exist, build from scratch
            content = '';
        }

        const updatedContent = this.updatePropertiesContent(content, props);
        await fs.writeFile(propsPath, updatedContent);
    }

    async getPlugins(): Promise<PluginInfo[]> {
        const pluginsDir = path.join(this.serverDir, 'plugins');
        try {
            const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
            const plugins: PluginInfo[] = [];

            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jar')) {
                    const stat = await fs.stat(path.join(pluginsDir, entry.name));
                    plugins.push({
                        name: entry.name.replace(/\.jar$/i, '').replace(/[-_]/g, ' '),
                        fileName: entry.name,
                        fileSize: stat.size,
                        installed: true,
                    });
                }
            }

            return plugins;
        } catch {
            return [];
        }
    }

    getCatalog(): CatalogPlugin[] {
        return PLUGIN_CATALOG;
    }

    async installPlugin(pluginId: string): Promise<void> {
        const plugin = PLUGIN_CATALOG.find((p) => p.id === pluginId);
        if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);

        const pluginsDir = path.join(this.serverDir, 'plugins');
        await fs.mkdir(pluginsDir, { recursive: true });
        const dest = path.join(pluginsDir, plugin.fileName);
        await this.downloadFile(plugin.downloadUrl, dest);
    }

    async removePlugin(fileName: string): Promise<void> {
        const filePath = path.join(this.serverDir, 'plugins', fileName);
        await fs.unlink(filePath);
    }

    async getWorlds(): Promise<WorldInfo[]> {
        const worlds: WorldInfo[] = [];
        const activeWorld = await this.getActiveWorldName();
        try {
            const entries = await fs.readdir(this.serverDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    // Paper 1.21+ uses session.lock + region/ instead of level.dat in world dirs
                    const dirPath = path.join(this.serverDir, entry.name);
                    const hasRegion = await fs.access(path.join(dirPath, 'region')).then(() => true, () => false);
                    const hasDim = await fs.access(path.join(dirPath, 'DIM-1')).then(() => true, () => false);
                    const hasSessionLock = await fs.access(path.join(dirPath, 'session.lock')).then(() => true, () => false);
                    if (hasRegion || hasDim || hasSessionLock) {
                        // Skip dimension folders — they belong to a parent world
                        if (entry.name.endsWith('_nether') || entry.name.endsWith('_the_end')) continue;

                        // Calculate total size including dimension folders
                        let sizeBytes = await this.getDirectorySize(dirPath);
                        for (const suffix of ['_nether', '_the_end']) {
                            const dimPath = path.join(this.serverDir, entry.name + suffix);
                            try {
                                await fs.access(dimPath);
                                sizeBytes += await this.getDirectorySize(dimPath);
                            } catch {
                                // Dimension folder doesn't exist
                            }
                        }

                        worlds.push({
                            name: entry.name,
                            directory: entry.name,
                            isActive: entry.name === activeWorld,
                            sizeBytes,
                        });
                    }
                }
            }
        } catch {
            // Server dir doesn't exist yet
        }
        // If active world isn't on disk yet (newly created, pending generation), show it
        // But only if it's not the default "world" — avoids ghost entry after deleting all worlds
        const activeExists = worlds.some((w) => w.name === activeWorld);
        if (!activeExists && activeWorld && activeWorld !== 'world') {
            worlds.push({
                name: activeWorld,
                directory: activeWorld,
                isActive: true,
                sizeBytes: 0,
            });
        }

        // Sort alphabetically, no reordering on selection
        worlds.sort((a, b) => a.name.localeCompare(b.name));
        return worlds;
    }

    async setActiveWorld(worldName: string): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error('Cannot change active world while server is running. Stop the server first.');
        }
        await this.saveProperties({ 'level-name': worldName });
    }

    async renameWorld(oldName: string, newName: string): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error('Cannot rename world while server is running. Stop the server first.');
        }
        const oldPath = path.join(this.serverDir, oldName);
        const newPath = path.join(this.serverDir, newName);

        // Check target doesn't already exist
        try {
            await fs.access(newPath);
            throw new Error(`A world named "${newName}" already exists.`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        await fs.rename(oldPath, newPath);

        // Also rename associated dimension folders (world_nether, world_the_end)
        // Paper creates these as separate top-level folders: <world>_nether, <world>_the_end
        for (const suffix of ['_nether', '_the_end']) {
            const oldDimPath = path.join(this.serverDir, oldName + suffix);
            const newDimPath = path.join(this.serverDir, newName + suffix);
            try {
                await fs.access(oldDimPath);
                await fs.rename(oldDimPath, newDimPath);
            } catch {
                // Dimension folder doesn't exist, skip
            }
        }

        // Update server.properties if this was the active world
        const activeWorld = await this.getActiveWorldName();
        if (activeWorld === oldName) {
            await this.saveProperties({ 'level-name': newName });
        }
    }

    async deleteWorld(worldName: string): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error('Cannot delete world while server is running. Stop the server first.');
        }
        const worldPath = path.join(this.serverDir, worldName);
        await fs.rm(worldPath, { recursive: true, force: true });

        // Also delete associated dimension folders
        for (const suffix of ['_nether', '_the_end']) {
            const dimPath = path.join(this.serverDir, worldName + suffix);
            try {
                await fs.access(dimPath);
                await fs.rm(dimPath, { recursive: true, force: true });
            } catch {
                // Dimension folder doesn't exist, skip
            }
        }

        // If this was the active world, reset level-name to default
        const activeWorld = await this.getActiveWorldName();
        if (activeWorld === worldName) {
            await this.saveProperties({ 'level-name': 'world' });
        }
    }

    async createWorld(worldName: string): Promise<void> {
        if (this.state === 'running' || this.state === 'starting') {
            throw new Error('Cannot create world while server is running. Stop the server first.');
        }
        const worldPath = path.join(this.serverDir, worldName);

        // Check it doesn't already exist
        try {
            await fs.access(worldPath);
            throw new Error(`A world named "${worldName}" already exists.`);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }

        // Set as active world — Paper will generate it on next server start
        await this.saveProperties({ 'level-name': worldName });
    }

    // ---- Hangar Plugin Store ----

    async hangarSearch(query: string, offset = 0, limit = 20): Promise<HangarSearchResult> {
        const params = new URLSearchParams({
            limit: String(limit),
            offset: String(offset),
            platform: 'PAPER',
            sort: '-downloads',
        });
        if (query.trim()) params.set('q', query.trim());
        const data = await this.fetchJson(`${HANGAR_API}/projects?${params}`);
        return data as unknown as HangarSearchResult;
    }

    async hangarGetProject(owner: string, slug: string): Promise<HangarProjectDetail> {
        const data = await this.fetchJson(`${HANGAR_API}/projects/${owner}/${slug}`);
        return data as unknown as HangarProjectDetail;
    }

    async hangarGetVersions(owner: string, slug: string): Promise<HangarVersion[]> {
        const data = await this.fetchJson(
            `${HANGAR_API}/projects/${owner}/${slug}/versions?limit=5&platform=PAPER`,
        );
        const result = data as unknown as { result: HangarVersion[] };
        return result.result;
    }

    async hangarInstallPlugin(
        owner: string,
        slug: string,
        versionName: string,
    ): Promise<void> {
        // Fetch the specific version to get download URL
        const data = await this.fetchJson(
            `${HANGAR_API}/projects/${owner}/${slug}/versions/${versionName}`,
        );
        const version = data as unknown as HangarVersion;
        const paperDownload = version.downloads['PAPER'];
        if (!paperDownload) throw new Error('No Paper download available for this version');

        const downloadUrl = paperDownload.downloadUrl ?? paperDownload.externalUrl;
        if (!downloadUrl) throw new Error('No download URL found');

        const fileName = paperDownload.fileInfo?.name ?? `${slug}-${versionName}.jar`;
        const pluginsDir = path.join(this.serverDir, 'plugins');
        await fs.mkdir(pluginsDir, { recursive: true });
        const dest = path.join(pluginsDir, fileName);
        await this.downloadFile(downloadUrl, dest);
    }

    // Called when the app is quitting — ensure we clean up the child process
    async cleanup(): Promise<void> {
        if (this.childProcess) {
            this.childProcess.stdin?.write('stop\n');
            // Give it a few seconds to stop gracefully
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.childProcess) this.childProcess.kill('SIGKILL');
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

    // ---- Internal Helpers ----

    private setState(state: ServerState): void {
        this.state = state;
        if (state !== 'error') this.error = undefined;
        // Emit plain object directly — getStatus() is async and can't be used here
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
            // No original file, write all properties
            return Object.entries(updates)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n') + '\n';
        }

        // Preserve comments and ordering, update values
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

        // Append any new properties not in the original file
        for (const [key, value] of Object.entries(updates)) {
            if (!updatedKeys.has(key)) {
                lines.push(`${key}=${value}`);
            }
        }

        return lines.join('\n');
    }

    private async getActiveWorldName(): Promise<string> {
        const props = await this.getProperties();
        return props['level-name'] ?? 'world';
    }

    private async getDirectorySize(dirPath: string): Promise<number> {
        let totalSize = 0;
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const entryPath = path.join(dirPath, entry.name);
                if (entry.isFile()) {
                    const stat = await fs.stat(entryPath);
                    totalSize += stat.size;
                } else if (entry.isDirectory()) {
                    totalSize += await this.getDirectorySize(entryPath);
                }
            }
        } catch {
            // Skip unreadable entries
        }
        return totalSize;
    }

    private async downloadPaper(version: string): Promise<void> {
        // Fetch latest build number for this version
        const buildsUrl = `${PAPER_API}/v2/projects/paper/versions/${version}/builds`;
        const buildsData = await this.fetchJson(buildsUrl);
        const builds = buildsData.builds as Array<{ build: number; downloads: { application: { name: string } } }>;
        const latestBuild = builds[builds.length - 1];
        const buildNumber = latestBuild.build;
        const downloadName = latestBuild.downloads.application.name;

        this.emitConsoleLine(`Found Paper build #${buildNumber} (${downloadName})`, 'info');

        // Download the JAR
        const downloadUrl = `${PAPER_API}/v2/projects/paper/versions/${version}/builds/${buildNumber}/downloads/${downloadName}`;
        const dest = path.join(this.serverDir, 'paper.jar');
        await this.downloadFile(downloadUrl, dest);
    }

    private async writeDefaultConfigs(): Promise<void> {
        const propsPath = path.join(this.serverDir, 'server.properties');
        const opsPath = path.join(this.serverDir, 'ops.json');
        const eulaPath = path.join(this.serverDir, 'eula.txt');

        // Only write defaults if files don't already exist
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

    private fetchJson(url: string): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client
                .get(url, { headers: { 'User-Agent': 'voxta-minecraft-companion' } }, (res) => {
                    // Handle redirects
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.fetchJson(res.headers.location).then(resolve, reject);
                        return;
                    }

                    let data = '';
                    res.on('data', (chunk: Buffer) => {
                        data += chunk.toString();
                    });
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data) as Record<string, unknown>);
                        } catch (e) {
                            reject(new Error(`Failed to parse JSON from ${url}`));
                        }
                    });
                })
                .on('error', reject);
        });
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client
                .get(url, { headers: { 'User-Agent': 'voxta-minecraft-companion' } }, (res) => {
                    // Handle redirects (GitHub releases use 302)
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.downloadFile(res.headers.location, dest).then(resolve, reject);
                        return;
                    }

                    if (res.statusCode && res.statusCode !== 200) {
                        reject(new Error(`Download failed with status ${res.statusCode}`));
                        return;
                    }

                    const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10);
                    let downloadedBytes = 0;

                    // Use sync writeFileSync approach via collecting chunks
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
                        downloadedBytes += chunk.length;
                        if (totalBytes > 0) {
                            this.emitProgress({
                                step: 0,
                                totalSteps: 0,
                                label: `Downloading... ${Math.round((downloadedBytes / totalBytes) * 100)}%`,
                                bytesDownloaded: downloadedBytes,
                                bytesTotal: totalBytes,
                            });
                        }
                    });
                    res.on('end', () => {
                        const buffer = Buffer.concat(chunks);
                        fs.writeFile(dest, buffer).then(resolve, reject);
                    });
                })
                .on('error', reject);
        });
    }
}
