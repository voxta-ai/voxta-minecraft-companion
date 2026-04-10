import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as https from 'https';
import * as http from 'http';
import type { TunnelState, TunnelStatus } from '../shared/ipc-types';
import type { ServerManager } from './server-manager';

const PLAYIT_DOWNLOAD_URL =
    'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.exe';

export class TunnelManager extends EventEmitter {
    private tunnelDir: string;
    private state: TunnelState = 'not-installed';
    private tunnelUrl: string | null = null;
    private claimUrl: string | null = null;
    private error: string | undefined;
    private childProcess: ChildProcess | null = null;
    private stopTimeout: ReturnType<typeof setTimeout> | null = null;
    private serverManager: ServerManager;

    constructor(serverManager: ServerManager) {
        super();
        this.tunnelDir = path.join(app.getPath('userData'), 'playit');
        this.serverManager = serverManager;

        // Auto-stop tunnel when server stops
        this.serverManager.on('server-status-changed', (status: { state: string }) => {
            if ((status.state === 'idle' || status.state === 'stopping') && this.isRunning()) {
                this.stop();
            }
        });
    }

    // ---- Public API ----

    async isInstalled(): Promise<boolean> {
        try {
            await fs.access(path.join(this.tunnelDir, 'playit.exe'));
            return true;
        } catch {
            return false;
        }
    }

    async install(): Promise<void> {
        this.setState('installing');
        try {
            await fs.mkdir(this.tunnelDir, { recursive: true });
            const dest = path.join(this.tunnelDir, 'playit.exe');
            await this.downloadFile(PLAYIT_DOWNLOAD_URL, dest);
            this.setState('idle');
        } catch (err) {
            this.error = err instanceof Error ? err.message : 'Download failed';
            this.setState('error');
            throw err;
        }
    }

    async start(): Promise<void> {
        if (this.state === 'running' || this.state === 'starting' || this.state === 'claim-needed') return;

        const installed = await this.isInstalled();
        if (!installed) {
            await this.install();
        }

        this.setState('starting');
        this.tunnelUrl = await this.loadSavedTunnelUrl();
        this.claimUrl = null;

        const exePath = path.join(this.tunnelDir, 'playit.exe');
        this.childProcess = spawn(exePath, [
            '--secret_path', path.join(this.tunnelDir, 'playit.toml'),
            '--stdout',
        ], {
            cwd: this.tunnelDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.childProcess.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                this.parseLine(line);
            }
        });

        this.childProcess.stderr?.on('data', (data: Buffer) => {
            const lines = data.toString().split('\n').filter((l) => l.trim());
            for (const line of lines) {
                this.parseLine(line);
            }
        });

        this.childProcess.on('close', (code) => {
            this.childProcess = null;
            if (this.stopTimeout) {
                clearTimeout(this.stopTimeout);
                this.stopTimeout = null;
            }

            if (this.state === 'stopping') {
                this.tunnelUrl = null;
                this.claimUrl = null;
                this.setState('idle');
            } else if (code !== 0 && code !== null) {
                this.error = `playit exited with code ${code}`;
                this.setState('error');
            } else {
                this.tunnelUrl = null;
                this.claimUrl = null;
                this.setState('idle');
            }
        });

        this.childProcess.on('error', (err) => {
            this.childProcess = null;
            this.error = err.message;
            this.setState('error');
        });
    }

    stop(): void {
        if (!this.childProcess || this.state === 'stopping' || this.state === 'idle') return;

        this.setState('stopping');
        this.childProcess.kill('SIGTERM');

        this.stopTimeout = setTimeout(() => {
            if (this.childProcess) {
                this.childProcess.kill('SIGKILL');
            }
        }, 5000);
    }

    isRunning(): boolean {
        return this.childProcess !== null;
    }

    getStatus(): TunnelStatus {
        return {
            state: this.state,
            tunnelUrl: this.tunnelUrl,
            claimUrl: this.claimUrl,
            error: this.error,
        };
    }

    async cleanup(): Promise<void> {
        if (this.childProcess) {
            this.childProcess.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.childProcess) this.childProcess.kill('SIGKILL');
                    resolve();
                }, 3000);

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

    // ---- Private helpers ----

    /** Save the tunnel address (called from IPC when user pastes it) */
    setTunnelUrl(url: string): void {
        this.tunnelUrl = url;
        void this.saveTunnelUrl(url);
        this.emit('tunnel-status-changed', this.getStatus());
    }

    private parseLine(line: string): void {
        // Claim URL detection — only open browser once per claim URL
        const claimMatch = line.match(/(https:\/\/playit\.gg\/claim\/\S+)/);
        if (claimMatch) {
            const url = claimMatch[1];
            const isNew = this.claimUrl !== url;
            this.claimUrl = url;
            this.setState('claim-needed');
            if (isNew) {
                void shell.openExternal(url);
            }
            return;
        }

        // Invalid secret — delete token and restart fresh
        if (line.includes('Invalid secret')) {
            if (this.childProcess) {
                this.childProcess.kill('SIGTERM');
                this.childProcess = null;
            }
            this.state = 'idle';
            const tomlPath = path.join(this.tunnelDir, 'playit.toml');
            void fs.unlink(tomlPath).catch(() => {}).then(() => {
                setTimeout(() => void this.start(), 500);
            });
            return;
        }

        // Claim approved — agent is now authenticated, transition to running
        if (line.includes('Program approved')) {
            this.claimUrl = null;
            this.setState('running');
            return;
        }

        // Agent connected: "secret key valid, agent has N tunnels"
        const agentReady = line.match(/agent has (\d+) tunnels?/);
        if (agentReady) {
            this.claimUrl = null;
            this.setState('running');
            return;
        }

        // Periodic status: "tunnel running, N tunnels registered"
        if (line.includes('tunnel running') && this.state !== 'running') {
            this.claimUrl = null;
            this.setState('running');
            return;
        }

        // Tunnel address detection (playit.gg domains) — in case future versions print it
        const tunnelMatch = line.match(/(\S+\.(?:joinmc\.link|at\.playit\.gg)\S*)/);
        if (tunnelMatch) {
            this.tunnelUrl = tunnelMatch[1];
            this.claimUrl = null;
            void this.saveTunnelUrl(this.tunnelUrl);
            this.setState('running');
            return;
        }

        // Fallback: generic address pattern
        const addrMatch = line.match(/address[:\s]+(\S+:\d+)/i);
        if (addrMatch && !this.tunnelUrl) {
            this.tunnelUrl = addrMatch[1];
            this.claimUrl = null;
            void this.saveTunnelUrl(this.tunnelUrl);
            this.setState('running');
        }
    }

    private async loadSavedTunnelUrl(): Promise<string | null> {
        try {
            const data = await fs.readFile(path.join(this.tunnelDir, 'tunnel-url.txt'), 'utf-8');
            return data.trim() || null;
        } catch {
            return null;
        }
    }

    private async saveTunnelUrl(url: string): Promise<void> {
        try {
            await fs.writeFile(path.join(this.tunnelDir, 'tunnel-url.txt'), url, 'utf-8');
        } catch {
            // Best effort
        }
    }

    private setState(state: TunnelState): void {
        this.state = state;
        if (state !== 'error') this.error = undefined;
        this.emit('tunnel-status-changed', this.getStatus());
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            client
                .get(url, { headers: { 'User-Agent': 'voxta-minecraft-companion' } }, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        this.downloadFile(res.headers.location, dest).then(resolve, reject);
                        return;
                    }

                    if (res.statusCode && res.statusCode !== 200) {
                        reject(new Error(`Download failed with status ${res.statusCode}`));
                        return;
                    }

                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => {
                        chunks.push(chunk);
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
