import { describe, it, expect } from 'vitest';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';

describe('MINECRAFT_ACTIONS', () => {
    it('has at least 20 actions defined', () => {
        expect(MINECRAFT_ACTIONS.length).toBeGreaterThanOrEqual(20);
    });

    it('has no duplicate action names', () => {
        const names = MINECRAFT_ACTIONS.map((a) => a.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
    });

    it('every action has required fields', () => {
        for (const action of MINECRAFT_ACTIONS) {
            expect(action.name, `action missing name`).toBeTruthy();
            expect(action.description, `${action.name} missing description`).toBeTruthy();
            expect(action.category, `${action.name} missing category`).toBeTruthy();
            expect(typeof action.isQuick, `${action.name} missing isQuick`).toBe('boolean');
            expect(typeof action.isPhysical, `${action.name} missing isPhysical`).toBe('boolean');
        }
    });

    it('every action name starts with mc_', () => {
        for (const action of MINECRAFT_ACTIONS) {
            expect(action.name).toMatch(/^mc_/);
        }
    });

    it('every action has a valid category', () => {
        const validCategories = ['movement', 'combat', 'survival', 'interaction', 'meta'];
        for (const action of MINECRAFT_ACTIONS) {
            expect(validCategories, `${action.name} has invalid category "${action.category}"`)
                .toContain(action.category);
        }
    });

    it('actions with arguments have typed argument definitions', () => {
        for (const action of MINECRAFT_ACTIONS) {
            if (action.arguments && action.arguments.length > 0) {
                for (const arg of action.arguments) {
                    expect(arg.name, `${action.name} arg missing name`).toBeTruthy();
                    expect(arg.type, `${action.name}.${arg.name} missing type`).toBeTruthy();
                }
            }
        }
    });
});
