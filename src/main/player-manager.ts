import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { WhitelistEntry, OpsEntry } from '../shared/ipc-types';

export class PlayerManager {
    private readonly serverDir: string;

    constructor(serverDir: string) {
        this.serverDir = serverDir;
    }

    async getWhitelist(): Promise<WhitelistEntry[]> {
        try {
            const content = await fs.readFile(path.join(this.serverDir, 'whitelist.json'), 'utf-8');
            return JSON.parse(content) as WhitelistEntry[];
        } catch {
            return [];
        }
    }

    async addWhitelist(
        name: string,
        sendCommand?: (cmd: string) => void,
    ): Promise<void> {
        const list = await this.getWhitelist();
        const lower = name.toLowerCase();
        if (list.some((e) => e.name.toLowerCase() === lower)) return;
        const uuid = this.offlineUuid(name);
        list.push({ uuid, name });
        await fs.writeFile(path.join(this.serverDir, 'whitelist.json'), JSON.stringify(list, null, 2));
        sendCommand?.(`whitelist add ${name}`);
    }

    async removeWhitelist(
        name: string,
        sendCommand?: (cmd: string) => void,
    ): Promise<void> {
        const list = await this.getWhitelist();
        const lower = name.toLowerCase();
        const filtered = list.filter((e) => e.name.toLowerCase() !== lower);
        await fs.writeFile(path.join(this.serverDir, 'whitelist.json'), JSON.stringify(filtered, null, 2));
        sendCommand?.(`whitelist remove ${name}`);
    }

    async getOps(): Promise<OpsEntry[]> {
        try {
            const content = await fs.readFile(path.join(this.serverDir, 'ops.json'), 'utf-8');
            return JSON.parse(content) as OpsEntry[];
        } catch {
            return [];
        }
    }

    async addOp(
        name: string,
        sendCommand?: (cmd: string) => void,
    ): Promise<void> {
        const list = await this.getOps();
        const lower = name.toLowerCase();
        if (list.some((e) => e.name.toLowerCase() === lower)) return;
        const uuid = this.offlineUuid(name);
        list.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
        await fs.writeFile(path.join(this.serverDir, 'ops.json'), JSON.stringify(list, null, 2));
        sendCommand?.(`op ${name}`);
    }

    async removeOp(
        name: string,
        sendCommand?: (cmd: string) => void,
    ): Promise<void> {
        const list = await this.getOps();
        const lower = name.toLowerCase();
        const filtered = list.filter((e) => e.name.toLowerCase() !== lower);
        await fs.writeFile(path.join(this.serverDir, 'ops.json'), JSON.stringify(filtered, null, 2));
        sendCommand?.(`deop ${name}`);
    }

    /** Generate an offline-mode UUID v3 from a player name */
    private offlineUuid(name: string): string {
        const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
        md5[6] = (md5[6] & 0x0f) | 0x30; // version 3
        md5[8] = (md5[8] & 0x3f) | 0x80; // variant
        const hex = md5.toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}
