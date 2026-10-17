import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn().mockReturnValue('/tmp/test-userdata') } }));

import { requiredJavaMajor } from '../main/java-manager';

describe('requiredJavaMajor', () => {
    it('needs Java 21 for 1.x servers', () => {
        expect(requiredJavaMajor('1.21.11')).toBe(21);
        expect(requiredJavaMajor('1.20.6')).toBe(21);
    });

    it('needs Java 25 for 26.x and later', () => {
        expect(requiredJavaMajor('26.1.2')).toBe(25);
        expect(requiredJavaMajor('27.1')).toBe(25);
    });

    it('falls back to Java 21 when the version is unknown', () => {
        expect(requiredJavaMajor(null)).toBe(21);
        expect(requiredJavaMajor('')).toBe(21);
    });
});
