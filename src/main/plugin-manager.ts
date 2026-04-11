import * as path from 'path';
import * as fs from 'fs/promises';
import { fetchJson, downloadFile } from './server-http';
import type {
    PluginInfo,
    CatalogPlugin,
    HangarSearchResult,
    HangarProjectDetail,
    HangarVersion,
    PluginUpdateInfo,
    SetupProgress,
} from '../shared/ipc-types';

const HANGAR_API = 'https://hangar.papermc.io/api/v1';

// Official download URLs for vetted plugins that work well with Voxta bots
const PLUGIN_CATALOG: CatalogPlugin[] = [
    {
        id: 'skinsrestorer',
        name: 'SkinsRestorer',
        description: 'Restore skins for offline-mode servers. Required for Voxta character skins.',
        downloadUrl: 'https://github.com/SkinsRestorer/SkinsRestorer/releases/latest/download/SkinsRestorer.jar',
        fileName: 'SkinsRestorer.jar',
    },
];

interface PluginMeta {
    fileName: string;
    hangarOwner: string;
    hangarSlug: string;
    installedVersion: string;
}

export class PluginManager {
    private readonly pluginsDir: string;
    private readonly pluginMetaPath: string;

    constructor(serverDir: string) {
        this.pluginsDir = path.join(serverDir, 'plugins');
        this.pluginMetaPath = path.join(this.pluginsDir, '.voxta-plugins.json');
    }

    async loadPluginMeta(): Promise<PluginMeta[]> {
        try {
            const content = await fs.readFile(this.pluginMetaPath, 'utf-8');
            return JSON.parse(content) as PluginMeta[];
        } catch {
            return [];
        }
    }

    async savePluginMeta(meta: PluginMeta[]): Promise<void> {
        await fs.mkdir(this.pluginsDir, { recursive: true });
        await fs.writeFile(this.pluginMetaPath, JSON.stringify(meta, null, 2));
    }

    async getPlugins(): Promise<PluginInfo[]> {
        try {
            const entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
            const meta = await this.loadPluginMeta();
            const plugins: PluginInfo[] = [];

            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.jar')) {
                    const stat = await fs.stat(path.join(this.pluginsDir, entry.name));
                    const tracked = meta.find((m) => m.fileName === entry.name);
                    plugins.push({
                        name: entry.name.replace(/\.jar$/i, '').replace(/[-_]/g, ' '),
                        fileName: entry.name,
                        fileSize: stat.size,
                        installed: true,
                        hangarOwner: tracked?.hangarOwner,
                        hangarSlug: tracked?.hangarSlug,
                        installedVersion: tracked?.installedVersion,
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

    async installCatalogPlugin(
        pluginId: string,
        onProgress?: (progress: SetupProgress) => void,
    ): Promise<void> {
        const plugin = PLUGIN_CATALOG.find((p) => p.id === pluginId);
        if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);

        await fs.mkdir(this.pluginsDir, { recursive: true });
        const dest = path.join(this.pluginsDir, plugin.fileName);
        await downloadFile(plugin.downloadUrl, dest, onProgress);
    }

    async removePlugin(fileName: string, isServerRunning: boolean): Promise<void> {
        if (isServerRunning) {
            throw new Error('Stop the server before removing plugins');
        }
        const filePath = path.join(this.pluginsDir, fileName);
        await fs.unlink(filePath);

        // Clean up metadata
        const meta = await this.loadPluginMeta();
        const filtered = meta.filter((m) => m.fileName !== fileName);
        if (filtered.length !== meta.length) {
            await this.savePluginMeta(filtered);
        }
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
        const data = await fetchJson(`${HANGAR_API}/projects?${params}`);
        return data as unknown as HangarSearchResult;
    }

    async hangarGetProject(owner: string, slug: string): Promise<HangarProjectDetail> {
        const data = await fetchJson(`${HANGAR_API}/projects/${owner}/${slug}`);
        return data as unknown as HangarProjectDetail;
    }

    async hangarGetVersions(owner: string, slug: string): Promise<HangarVersion[]> {
        const data = await fetchJson(
            `${HANGAR_API}/projects/${owner}/${slug}/versions?limit=5&platform=PAPER`,
        );
        const result = data as unknown as { result: HangarVersion[] };
        return result.result;
    }

    async hangarInstallPlugin(
        owner: string,
        slug: string,
        versionName: string,
        onProgress?: (progress: SetupProgress) => void,
    ): Promise<void> {
        const data = await fetchJson(
            `${HANGAR_API}/projects/${owner}/${slug}/versions/${versionName}`,
        );
        const version = data as unknown as HangarVersion;
        const paperDownload = version.downloads['PAPER'];
        if (!paperDownload) throw new Error('No Paper download available for this version');

        const downloadUrl = paperDownload.downloadUrl ?? paperDownload.externalUrl;
        if (!downloadUrl) throw new Error('No download URL found');

        const fileName = paperDownload.fileInfo?.name ?? `${slug}-${versionName}.jar`;
        await fs.mkdir(this.pluginsDir, { recursive: true });
        const dest = path.join(this.pluginsDir, fileName);
        await downloadFile(downloadUrl, dest, onProgress);

        // Track Hangar origin for update detection
        const meta = await this.loadPluginMeta();
        const existing = meta.findIndex((m) => m.hangarOwner === owner && m.hangarSlug === slug);
        const entry: PluginMeta = { fileName, hangarOwner: owner, hangarSlug: slug, installedVersion: versionName };
        if (existing >= 0) {
            // Remove old JAR if filename changed (version upgrade)
            if (meta[existing].fileName !== fileName) {
                try { await fs.unlink(path.join(this.pluginsDir, meta[existing].fileName)); } catch { /* old file may not exist */ }
            }
            meta[existing] = entry;
        } else {
            meta.push(entry);
        }
        await this.savePluginMeta(meta);
    }

    async checkPluginUpdates(mcVersion: string | null): Promise<PluginUpdateInfo[]> {
        const meta = await this.loadPluginMeta();
        if (meta.length === 0) return [];

        const updates: PluginUpdateInfo[] = [];

        for (const plugin of meta) {
            try {
                const versions = await this.hangarGetVersions(plugin.hangarOwner, plugin.hangarSlug);
                const latest = versions[0];
                if (!latest || latest.name === plugin.installedVersion) continue;

                const paperDeps = latest.platformDependencies['PAPER'] ?? [];
                const compatible = mcVersion ? paperDeps.some((v) => mcVersion.startsWith(v)) : true;

                updates.push({
                    fileName: plugin.fileName,
                    hangarOwner: plugin.hangarOwner,
                    hangarSlug: plugin.hangarSlug,
                    installedVersion: plugin.installedVersion,
                    latestVersion: latest.name,
                    latestChannel: latest.channel,
                    compatible,
                    supportedMcVersions: paperDeps,
                });
            } catch (err) {
                console.error(`[Server] Failed to check updates for ${plugin.hangarSlug}:`, err);
            }
        }

        return updates;
    }

    /**
     * Auto-install Simple Voice Chat from Hangar during setup.
     */
    async installSimpleVoiceChat(
        emitConsoleLine: (text: string, level: 'info' | 'warn') => void,
    ): Promise<void> {
        const meta = await this.loadPluginMeta();
        const existing = meta.find((m) => m.hangarSlug === 'SimpleVoiceChat');
        if (existing) {
            console.log(`[Setup] Simple Voice Chat already installed (${existing.installedVersion})`);
            return;
        }

        try {
            console.log('[Setup] Installing Simple Voice Chat from Hangar...');
            const versions = await this.hangarGetVersions('henkelmax', 'SimpleVoiceChat');
            if (versions.length === 0) {
                console.warn('[Setup] No Simple Voice Chat versions found on Hangar');
                return;
            }
            const latest = versions[0];
            emitConsoleLine(`Installing Simple Voice Chat ${latest.name}...`, 'info');
            await this.hangarInstallPlugin('henkelmax', 'SimpleVoiceChat', latest.name);
            console.log(`[Setup] Simple Voice Chat ${latest.name} installed`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[Setup] Failed to install Simple Voice Chat: ${message}`);
            emitConsoleLine(`Could not install Simple Voice Chat: ${message}`, 'warn');
        }
    }
}
