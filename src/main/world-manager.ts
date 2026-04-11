import * as path from 'path';
import * as fs from 'fs/promises';
import type { WorldInfo, WorldBackup, ServerProperties } from '../shared/ipc-types';

export class WorldManager {
    private readonly serverDir: string;
    private readonly backupsDir: string;

    constructor(serverDir: string) {
        this.serverDir = serverDir;
        this.backupsDir = path.join(serverDir, 'backups');
    }

    async getWorlds(
        getProperties: () => Promise<ServerProperties>,
    ): Promise<WorldInfo[]> {
        const worlds: WorldInfo[] = [];
        const activeWorld = await this.getActiveWorldName(getProperties);
        try {
            const entries = await fs.readdir(this.serverDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
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

                        const backupCount = await this.getBackupCount(entry.name);
                        worlds.push({
                            name: entry.name,
                            directory: entry.name,
                            isActive: entry.name === activeWorld,
                            sizeBytes,
                            backupCount,
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
                backupCount: 0,
            });
        }

        // Sort alphabetically, no reordering on selection
        worlds.sort((a, b) => a.name.localeCompare(b.name));
        return worlds;
    }

    async setActiveWorld(
        worldName: string,
        isServerRunning: boolean,
        saveProperties: (props: ServerProperties) => Promise<void>,
    ): Promise<void> {
        if (isServerRunning) {
            throw new Error('Cannot change active world while server is running. Stop the server first.');
        }
        await saveProperties({ 'level-name': worldName });
    }

    async renameWorld(
        oldName: string,
        newName: string,
        isServerRunning: boolean,
        getProperties: () => Promise<ServerProperties>,
        saveProperties: (props: ServerProperties) => Promise<void>,
    ): Promise<void> {
        if (isServerRunning) {
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

        // Also rename associated dimension folders
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
        const activeWorld = await this.getActiveWorldName(getProperties);
        if (activeWorld === oldName) {
            await saveProperties({ 'level-name': newName });
        }
    }

    async deleteWorld(
        worldName: string,
        isServerRunning: boolean,
        getProperties: () => Promise<ServerProperties>,
        saveProperties: (props: ServerProperties) => Promise<void>,
    ): Promise<void> {
        if (isServerRunning) {
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
        const activeWorld = await this.getActiveWorldName(getProperties);
        if (activeWorld === worldName) {
            await saveProperties({ 'level-name': 'world' });
        }
    }

    async createWorld(
        worldName: string,
        seed: string | undefined,
        isServerRunning: boolean,
        saveProperties: (props: ServerProperties) => Promise<void>,
    ): Promise<void> {
        if (isServerRunning) {
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

        // Set as active world + seed — Paper will generate it on next server start
        const props: ServerProperties = { 'level-name': worldName };
        if (seed) props['level-seed'] = seed;
        await saveProperties(props);
    }

    // ---- World Backups ----

    async backupWorld(worldName: string): Promise<void> {
        const worldPath = path.join(this.serverDir, worldName);
        try {
            await fs.access(worldPath);
        } catch {
            throw new Error(`World "${worldName}" does not exist.`);
        }

        const timestamp = Date.now();
        const backupId = `${worldName}_${timestamp}`;
        const backupPath = path.join(this.backupsDir, backupId);
        await fs.mkdir(backupPath, { recursive: true });

        // Copy main world folder
        await this.copyDirectory(worldPath, path.join(backupPath, worldName));

        // Copy dimension folders
        for (const suffix of ['_nether', '_the_end']) {
            const dimPath = path.join(this.serverDir, worldName + suffix);
            try {
                await fs.access(dimPath);
                await this.copyDirectory(dimPath, path.join(backupPath, worldName + suffix));
            } catch {
                // Dimension folder doesn't exist
            }
        }
    }

    async getBackups(worldName: string): Promise<WorldBackup[]> {
        const backups: WorldBackup[] = [];
        try {
            const entries = await fs.readdir(this.backupsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith(worldName + '_')) {
                    const timestampStr = entry.name.substring(worldName.length + 1);
                    const timestamp = parseInt(timestampStr, 10);
                    if (isNaN(timestamp)) continue;

                    const backupPath = path.join(this.backupsDir, entry.name);
                    const sizeBytes = await this.getDirectorySize(backupPath);
                    backups.push({
                        id: entry.name,
                        worldName,
                        timestamp,
                        sizeBytes,
                    });
                }
            }
        } catch {
            // Backups dir doesn't exist yet
        }
        // Newest first
        backups.sort((a, b) => b.timestamp - a.timestamp);
        return backups;
    }

    async restoreBackup(backupId: string, isServerRunning: boolean): Promise<void> {
        if (isServerRunning) {
            throw new Error('Cannot restore while server is running. Stop the server first.');
        }

        const backupPath = path.join(this.backupsDir, backupId);
        try {
            await fs.access(backupPath);
        } catch {
            throw new Error('Backup not found.');
        }

        // Read the backup contents to find the world name
        const entries = await fs.readdir(backupPath, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const destPath = path.join(this.serverDir, entry.name);
                // Remove existing folder before restoring
                await fs.rm(destPath, { recursive: true, force: true });
                await this.copyDirectory(path.join(backupPath, entry.name), destPath);
            }
        }
    }

    async deleteBackup(backupId: string): Promise<void> {
        const backupPath = path.join(this.backupsDir, backupId);
        await fs.rm(backupPath, { recursive: true, force: true });
    }

    // ---- Internal Helpers ----

    private async getActiveWorldName(
        getProperties: () => Promise<ServerProperties>,
    ): Promise<string> {
        const props = await getProperties();
        return props['level-name'] ?? 'world';
    }

    private async getBackupCount(worldName: string): Promise<number> {
        try {
            const entries = await fs.readdir(this.backupsDir);
            return entries.filter((e) => e.startsWith(worldName + '_')).length;
        } catch {
            return 0;
        }
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

    private async copyDirectory(src: string, dest: string): Promise<void> {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            } else {
                try {
                    await fs.copyFile(srcPath, destPath);
                } catch (err) {
                    // Skip locked files (e.g. session.lock while server is running)
                    if ((err as NodeJS.ErrnoException).code === 'EBUSY') continue;
                    throw err;
                }
            }
        }
    }
}
