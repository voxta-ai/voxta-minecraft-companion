import { describe, it, expect } from 'vitest';
import { humanizeError } from '../main/bot-engine-voxta';

describe('humanizeError', () => {
    it('detects ECONNREFUSED', () => {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:25565');
        expect(humanizeError(err, 'MC')).toContain('Cannot connect to Minecraft server');
    });

    it('detects ETIMEDOUT', () => {
        const err = new Error('connect ETIMEDOUT');
        expect(humanizeError(err, 'MC')).toContain('Cannot reach Minecraft server');
    });

    it('detects EHOSTUNREACH', () => {
        const err = new Error('EHOSTUNREACH');
        expect(humanizeError(err, 'MC')).toContain('Cannot reach Minecraft server');
    });

    it('detects ENOTFOUND', () => {
        const err = new Error('getaddrinfo ENOTFOUND badhost.example');
        expect(humanizeError(err, 'MC')).toContain('Server address not found');
    });

    it('detects version mismatch', () => {
        const err = new Error('This server is version 1.21.1');
        const result = humanizeError(err, 'MC');
        expect(result).toContain('Version mismatch');
        expect(result).toContain('1.21.1');
    });

    it('detects Voxta negotiation failure', () => {
        const err = new Error('Failed to complete negotiation with the server');
        expect(humanizeError(err, 'Voxta')).toContain('Cannot connect to Voxta');
    });

    it('detects Voxta auth failure (401)', () => {
        const err = new Error('Status code 401');
        expect(humanizeError(err, 'Voxta')).toContain('Cannot connect to Voxta');
    });

    it('detects authentication keyword', () => {
        const err = new Error('authentication failed');
        expect(humanizeError(err, 'Voxta')).toContain('authentication failed');
    });

    it('detects generic timeout', () => {
        const err = new Error('request timed out');
        expect(humanizeError(err, 'Operation')).toBe('Operation timed out — try again.');
    });

    it('falls back to context + raw message', () => {
        const err = new Error('something weird happened');
        expect(humanizeError(err, 'Test')).toBe('Test: something weird happened');
    });

    it('handles non-Error objects', () => {
        expect(humanizeError('raw string error', 'Test')).toBe('Test: raw string error');
    });

    it('handles AggregateError with nested .code', () => {
        const nested = new Error('inner');
        (nested as Error & { code: string }).code = 'ECONNREFUSED';
        const aggregate = new Error('');
        (aggregate as Error & { errors: Error[] }).errors = [nested];
        expect(humanizeError(aggregate, 'MC')).toContain('Cannot connect to Minecraft server');
    });

    it('handles Error with .code property', () => {
        const err = new Error('connect failed');
        (err as Error & { code: string }).code = 'ETIMEDOUT';
        expect(humanizeError(err, 'MC')).toContain('Cannot reach Minecraft server');
    });
});
