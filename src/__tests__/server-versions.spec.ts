import { describe, it, expect } from 'vitest';
import mineflayer from 'mineflayer';
import { isBotSupportedVersion, selectServerVersions } from '../main/server-versions';

describe('isBotSupportedVersion', () => {
    it('accepts the newest and oldest versions mineflayer was tested with', () => {
        expect(isBotSupportedVersion(mineflayer.latestSupportedVersion)).toBe(true);
        expect(isBotSupportedVersion(mineflayer.oldestSupportedVersion)).toBe(true);
    });

    it('accepts a patch release that shares a tested protocol', () => {
        expect(isBotSupportedVersion('1.21.10')).toBe(true);
        expect(isBotSupportedVersion('1.20.5')).toBe(true);
    });

    it('rejects versions older than the oldest supported one', () => {
        expect(isBotSupportedVersion('1.7.10')).toBe(false);
    });

    it('rejects versions minecraft-data does not know', () => {
        expect(isBotSupportedVersion('99.1')).toBe(false);
        expect(isBotSupportedVersion('not-a-version')).toBe(false);
    });
});

describe('selectServerVersions', () => {
    it('keeps stable supported releases, newest first', () => {
        const paper = ['1.20.4', '99.1', '1.21.11', '1.21.11-rc3', '1.21.9-pre4', '1.21.4', '1.7.10'];
        expect(selectServerVersions(paper)).toEqual(['1.21.11', '1.21.4', '1.20.4']);
    });

    it('sorts numerically, not alphabetically', () => {
        expect(selectServerVersions(['1.21.4', '1.21.10', '1.21.9'])).toEqual(['1.21.10', '1.21.9', '1.21.4']);
    });

    it('puts the newest supported version first so it becomes the default', () => {
        const [first] = selectServerVersions(['1.16.5', mineflayer.latestSupportedVersion, '1.20.4']);
        expect(first).toBe(mineflayer.latestSupportedVersion);
    });
});
