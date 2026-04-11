import { describe, it, expect } from 'vitest';
import { offlineUuid } from '../main/player-manager';

describe('offlineUuid', () => {
    it('generates a valid UUID format', () => {
        const uuid = offlineUuid('TestPlayer');
        // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('sets version 3 nibble', () => {
        const uuid = offlineUuid('TestPlayer');
        // 13th hex char (position after second dash) should be '3' for version 3
        expect(uuid[14]).toBe('3');
    });

    it('sets variant bits correctly', () => {
        const uuid = offlineUuid('TestPlayer');
        // 17th hex char (position after third dash) should be 8, 9, a, or b
        expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
    });

    it('is deterministic — same name always produces same UUID', () => {
        const uuid1 = offlineUuid('Player');
        const uuid2 = offlineUuid('Player');
        expect(uuid1).toBe(uuid2);
    });

    it('produces different UUIDs for different names', () => {
        const uuid1 = offlineUuid('Alice');
        const uuid2 = offlineUuid('Bob');
        expect(uuid1).not.toBe(uuid2);
    });

    it('matches known Minecraft offline UUID for "Notch"', () => {
        // Well-known offline UUID for "Notch" — verified against MC server behavior
        // OfflinePlayer:Notch → MD5 → UUID v3
        const uuid = offlineUuid('Notch');
        expect(uuid).toBe('b50ad385-829d-3141-a216-7e7d7539ba7f');
    });
});
