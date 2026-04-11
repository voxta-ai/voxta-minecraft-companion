import { describe, it, expect, beforeEach } from 'vitest';
import { NameRegistry } from '../bot/name-registry';

describe('NameRegistry', () => {
    let registry: NameRegistry;

    beforeEach(() => {
        registry = new NameRegistry();
    });

    describe('register and resolve', () => {
        it('resolves Voxta name to MC username', () => {
            registry.register('Inferna', 'VoxtaBot');
            expect(registry.resolveToMc('Inferna')).toBe('VoxtaBot');
        });

        it('resolves MC username to Voxta name', () => {
            registry.register('Inferna', 'VoxtaBot');
            expect(registry.resolveToVoxta('VoxtaBot')).toBe('Inferna');
        });

        it('is case-insensitive for lookups', () => {
            registry.register('Inferna', 'VoxtaBot');
            expect(registry.resolveToMc('inferna')).toBe('VoxtaBot');
            expect(registry.resolveToMc('INFERNA')).toBe('VoxtaBot');
            expect(registry.resolveToVoxta('voxtabot')).toBe('Inferna');
        });

        it('returns original name when no mapping exists', () => {
            expect(registry.resolveToMc('UnknownPlayer')).toBe('UnknownPlayer');
            expect(registry.resolveToVoxta('UnknownBot')).toBe('UnknownBot');
        });

        it('handles multiple registrations', () => {
            registry.register('Inferna', 'VoxtaBot');
            registry.register('Lapiro', 'Player123');
            expect(registry.resolveToMc('Inferna')).toBe('VoxtaBot');
            expect(registry.resolveToMc('Lapiro')).toBe('Player123');
            expect(registry.resolveToVoxta('VoxtaBot')).toBe('Inferna');
            expect(registry.resolveToVoxta('Player123')).toBe('Lapiro');
        });
    });

    describe('hasMcUsername', () => {
        it('returns true for registered MC usernames', () => {
            registry.register('Inferna', 'VoxtaBot');
            expect(registry.hasMcUsername('VoxtaBot')).toBe(true);
            expect(registry.hasMcUsername('voxtabot')).toBe(true);
        });

        it('returns false for unregistered names', () => {
            expect(registry.hasMcUsername('RandomPlayer')).toBe(false);
        });
    });

    describe('resolveNamesInText', () => {
        it('replaces MC names with Voxta names in text', () => {
            registry.register('Inferna', 'VoxtaBot');
            registry.register('Lapiro', 'Emptyngton');
            expect(registry.resolveNamesInText('Teleported VoxtaBot to Emptyngton'))
                .toBe('Teleported Inferna to Lapiro');
        });

        it('is case-insensitive in replacement', () => {
            registry.register('Inferna', 'VoxtaBot');
            expect(registry.resolveNamesInText('voxtabot joined the game'))
                .toBe('Inferna joined the game');
        });

        it('returns original text when no names match', () => {
            const text = 'Server started on port 25565';
            expect(registry.resolveNamesInText(text)).toBe(text);
        });
    });

    describe('clear', () => {
        it('removes all registrations', () => {
            registry.register('Inferna', 'VoxtaBot');
            registry.clear();
            expect(registry.resolveToMc('Inferna')).toBe('Inferna');
            expect(registry.hasMcUsername('VoxtaBot')).toBe(false);
        });
    });
});
