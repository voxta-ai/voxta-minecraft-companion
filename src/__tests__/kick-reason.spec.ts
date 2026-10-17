import { describe, it, expect } from 'vitest';
import { kickReasonText } from '../bot/minecraft/connection-diagnostics';

describe('kickReasonText', () => {
    it('passes plain text through', () => {
        expect(kickReasonText('You are not whitelisted on this server!')).toBe(
            'You are not whitelisted on this server!',
        );
    });

    it('reads a JSON chat component', () => {
        expect(kickReasonText('{"text":"Server closed"}')).toBe('Server closed');
        expect(kickReasonText('{"translate":"multiplayer.disconnect.invalid_player_data"}')).toBe(
            'multiplayer.disconnect.invalid_player_data',
        );
    });

    it('reads a component object with extra parts', () => {
        expect(kickReasonText({ text: 'Banned: ', extra: [{ text: 'griefing' }] })).toBe('Banned: griefing');
    });

    it('handles empty values', () => {
        expect(kickReasonText(undefined)).toBe('');
        expect(kickReasonText(null)).toBe('');
    });
});
