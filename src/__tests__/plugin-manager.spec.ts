import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('fs/promises', () => ({
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../main/server-http', () => ({
    fetchJson: vi.fn(),
    downloadFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
import { fetchJson, downloadFile } from '../main/server-http';
import { PluginManager } from '../main/plugin-manager';

const viaVersionRelease = {
    name: '5.12.1',
    downloads: {
        PAPER: {
            downloadUrl: 'https://hangar.papermc.io/api/v1/projects/ViaVersion/versions/5.12.1/PAPER/download',
            fileInfo: { name: 'ViaVersion-5.12.1.jar' },
        },
    },
};

describe('PluginManager.installViaVersion', () => {
    let manager: PluginManager;
    const emit = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new PluginManager('/tmp/server');
    });

    it('installs the latest stable release when missing', async () => {
        vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
        vi.mocked(fetchJson).mockImplementation((url: string) =>
            Promise.resolve(url.includes('/versions?') ? { result: [viaVersionRelease] } : viaVersionRelease),
        );

        await manager.installViaVersion(emit);

        expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain('/projects/ViaVersion/ViaVersion/versions?');
        expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain('channel=Release');
        expect(vi.mocked(downloadFile).mock.calls[0][1]).toMatch(/ViaVersion-5\.12\.1\.jar$/);
        expect(emit).toHaveBeenCalledWith('Installing ViaVersion 5.12.1...', 'info');
    });

    it('does nothing when ViaVersion is already installed', async () => {
        vi.mocked(fs.readFile).mockResolvedValue(
            JSON.stringify([
                {
                    fileName: 'ViaVersion-5.12.0.jar',
                    hangarOwner: 'ViaVersion',
                    hangarSlug: 'ViaVersion',
                    installedVersion: '5.12.0',
                },
            ]),
        );

        await manager.installViaVersion(emit);

        expect(fetchJson).not.toHaveBeenCalled();
        expect(downloadFile).not.toHaveBeenCalled();
    });

    it('warns instead of failing setup when Hangar is unreachable', async () => {
        vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
        vi.mocked(fetchJson).mockRejectedValue(new Error('getaddrinfo ENOTFOUND hangar.papermc.io'));

        await expect(manager.installViaVersion(emit)).resolves.toBeUndefined();
        expect(emit).toHaveBeenCalledWith(expect.stringContaining('Could not install ViaVersion'), 'warn');
    });
});
