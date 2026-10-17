import { describe, it, expect } from 'vitest';
import { toMinecraftUsername, toSecondMinecraftUsername } from '../bot/minecraft/username';

describe('toMinecraftUsername', () => {
    it('keeps a name that is already valid', () => {
        expect(toMinecraftUsername('Zara', 'Companion')).toBe('Zara');
        expect(toMinecraftUsername('Bat_Guy2', 'Companion')).toBe('Bat_Guy2');
    });

    it('turns spaces and hyphens into underscores', () => {
        expect(toMinecraftUsername('Voxta Assistant', 'Companion')).toBe('Voxta_Assistant');
        expect(toMinecraftUsername('Mary-Jane', 'Companion')).toBe('Mary_Jane');
    });

    it('strips accents instead of dropping the letter', () => {
        expect(toMinecraftUsername('Zoë', 'Companion')).toBe('Zoe');
        expect(toMinecraftUsername('Señorita', 'Companion')).toBe('Senorita');
    });

    it('drops characters Minecraft rejects', () => {
        expect(toMinecraftUsername("D'Arcy", 'Companion')).toBe('DArcy');
        expect(toMinecraftUsername('Luna ✨', 'Companion')).toBe('Luna');
        expect(toMinecraftUsername('Dr. Who?', 'Companion')).toBe('Dr_Who');
    });

    it('cuts names longer than 16 characters', () => {
        expect(toMinecraftUsername('Professor Archibald', 'Companion')).toBe('Professor_Archib');
    });

    it('pads names shorter than 3 characters', () => {
        expect(toMinecraftUsername('Al', 'Companion')).toBe('AlBot');
    });

    it('uses the fallback when nothing valid is left', () => {
        expect(toMinecraftUsername('ルナ', 'Companion')).toBe('Companion');
        expect(toMinecraftUsername('   ', 'Companion')).toBe('Companion');
    });

    it('always produces a name Minecraft accepts', () => {
        for (const name of [
            'Voxta Assistant',
            'Zoë',
            'ルナ',
            'Al',
            'Professor Archibald',
            '__x__',
            'a b c d e f g h i j',
        ]) {
            expect(toMinecraftUsername(name, 'Companion')).toMatch(/^[A-Za-z0-9_]{3,16}$/);
        }
    });
});

describe('toSecondMinecraftUsername', () => {
    it('keeps a distinct name as is', () => {
        expect(toSecondMinecraftUsername('Brick', 'Zara')).toBe('Brick');
    });

    it('makes a duplicate distinct from the first bot', () => {
        expect(toSecondMinecraftUsername('Luna!', 'Luna')).toBe('Luna2');
        expect(toSecondMinecraftUsername('Professor Archibald', 'Professor_Archib')).toBe('Professor_Archi2');
    });

    it('falls back to a different default than the first bot', () => {
        expect(toSecondMinecraftUsername('ルナ', 'Companion')).toBe('Companion2');
    });
});
