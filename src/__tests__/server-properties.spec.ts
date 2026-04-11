import { describe, it, expect } from 'vitest';
import { parseProperties, updatePropertiesContent } from '../main/server-properties';

describe('parseProperties', () => {
    it('parses key=value pairs', () => {
        const content = 'server-port=25565\ndifficulty=easy\n';
        expect(parseProperties(content)).toEqual({
            'server-port': '25565',
            'difficulty': 'easy',
        });
    });

    it('skips comments', () => {
        const content = '# This is a comment\nserver-port=25565\n#another=comment\n';
        expect(parseProperties(content)).toEqual({
            'server-port': '25565',
        });
    });

    it('skips blank lines', () => {
        const content = '\nserver-port=25565\n\ndifficulty=easy\n\n';
        expect(parseProperties(content)).toEqual({
            'server-port': '25565',
            'difficulty': 'easy',
        });
    });

    it('handles values with equals signs', () => {
        const content = 'motd=Welcome = to the server\n';
        expect(parseProperties(content)).toEqual({
            'motd': 'Welcome = to the server',
        });
    });

    it('handles empty values', () => {
        const content = 'level-seed=\n';
        expect(parseProperties(content)).toEqual({
            'level-seed': '',
        });
    });

    it('returns empty object for empty content', () => {
        expect(parseProperties('')).toEqual({});
    });

    it('handles lines without equals sign', () => {
        const content = 'no-equals-here\nserver-port=25565\n';
        expect(parseProperties(content)).toEqual({
            'server-port': '25565',
        });
    });
});

describe('updatePropertiesContent', () => {
    it('updates existing properties', () => {
        const original = 'server-port=25565\ndifficulty=easy\n';
        const result = updatePropertiesContent(original, { 'difficulty': 'hard' });
        expect(result).toContain('difficulty=hard');
        expect(result).toContain('server-port=25565');
    });

    it('preserves comments and ordering', () => {
        const original = '# Server config\nserver-port=25565\n# Game settings\ndifficulty=easy\n';
        const result = updatePropertiesContent(original, { 'difficulty': 'hard' });
        const lines = result.split('\n');
        expect(lines[0]).toBe('# Server config');
        expect(lines[1]).toBe('server-port=25565');
        expect(lines[2]).toBe('# Game settings');
        expect(lines[3]).toBe('difficulty=hard');
    });

    it('appends new properties not in original', () => {
        const original = 'server-port=25565\n';
        const result = updatePropertiesContent(original, { 'motd': 'Hello World' });
        expect(result).toContain('server-port=25565');
        expect(result).toContain('motd=Hello World');
    });

    it('creates content from scratch when original is empty', () => {
        const result = updatePropertiesContent('', {
            'server-port': '25565',
            'difficulty': 'easy',
        });
        expect(result).toContain('server-port=25565');
        expect(result).toContain('difficulty=easy');
    });

    it('creates content from scratch when original is whitespace', () => {
        const result = updatePropertiesContent('   \n  \n', {
            'server-port': '25565',
        });
        expect(result).toBe('server-port=25565\n');
    });
});
