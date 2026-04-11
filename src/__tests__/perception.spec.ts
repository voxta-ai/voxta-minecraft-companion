import { describe, it, expect } from 'vitest';
import { buildContextStrings } from '../bot/minecraft/perception';
import type { WorldState } from '../bot/minecraft/perception';
import { NameRegistry } from '../bot/name-registry';

/** Create a default WorldState with sensible values — override specific fields per test */
function createWorldState(overrides: Partial<WorldState> = {}): WorldState {
    return {
        position: { x: 100, y: 64, z: -200 },
        health: 20,
        food: 20,
        experience: { level: 5, points: 120 },
        gameMode: 'survival',
        biome: 'plains',
        biomeTemperature: 0.8,
        dimension: 'overworld',
        timeOfDay: 6000, // noon
        isDay: true,
        isRaining: false,
        heldItem: null,
        armor: [],
        nearbyPlayers: [],
        nearbyMobs: [],
        inventorySummary: [],
        nearbyBlocks: [],
        shelter: 'outdoors',
        currentActivity: null,
        botMode: 'passive',
        homePosition: null,
        movement: 'standing',
        oxygenLevel: 20,
        isSleeping: false,
        activeEffects: [],
        riding: null,
        ...overrides,
    };
}

describe('buildContextStrings', () => {
    const names = new NameRegistry();

    describe('basic context output', () => {
        it('includes position, game mode, biome, dimension', () => {
            const state = createWorldState({
                position: { x: 100, y: 64, z: -200 },
                gameMode: 'survival',
                biome: 'plains',
                dimension: 'overworld',
            });
            const lines = buildContextStrings(state, names, 'Inferna');
            const posLine = lines[0];
            expect(posLine).toContain('100, 64, -200');
            expect(posLine).toContain('survival');
            expect(posLine).toContain('plains');
            expect(posLine).toContain('overworld');
        });

        it('includes health, food, level', () => {
            const state = createWorldState({ health: 14.5, food: 18, experience: { level: 12, points: 500 } });
            const lines = buildContextStrings(state, names, 'Inferna');
            const statusLine = lines[1];
            expect(statusLine).toContain('14.5/20');
            expect(statusLine).toContain('18/20');
            expect(statusLine).toContain('Level: 12');
        });

        it('includes character name in output', () => {
            const state = createWorldState();
            const lines = buildContextStrings(state, names, 'Zara');
            expect(lines[0]).toContain("Zara's position");
            expect(lines[1]).toContain("Zara's Health");
        });

        it('falls back to "Bot" when character name is null', () => {
            const state = createWorldState();
            const lines = buildContextStrings(state, names, null);
            expect(lines[0]).toContain("Bot's position");
        });
    });

    describe('time of day', () => {
        it('shows Day at noon (tick 6000)', () => {
            const state = createWorldState({ timeOfDay: 6000, isDay: true });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('Day');
            expect(lines[1]).toContain('12:00 PM');
        });

        it('shows Night at midnight (tick 18000)', () => {
            const state = createWorldState({ timeOfDay: 18000, isDay: false });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('Night');
            expect(lines[1]).toContain('12:00 AM');
        });

        it('shows morning time at tick 0 (6:00 AM)', () => {
            const state = createWorldState({ timeOfDay: 0, isDay: true });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('6:00 AM');
        });

        it('shows evening time at tick 12000 (6:00 PM)', () => {
            const state = createWorldState({ timeOfDay: 12000, isDay: false });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('6:00 PM');
        });
    });

    describe('weather', () => {
        it('shows Clear when not raining', () => {
            const state = createWorldState({ isRaining: false });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('Clear');
        });

        it('shows Raining in warm biome', () => {
            const state = createWorldState({ isRaining: true, biomeTemperature: 0.8 });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('Raining');
        });

        it('shows Snowing in cold biome', () => {
            const state = createWorldState({ isRaining: true, biomeTemperature: 0.0 });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines[1]).toContain('Snowing');
        });
    });

    describe('survival warnings', () => {
        it('warns critical starvation at food=0', () => {
            const state = createWorldState({ food: 0 });
            const lines = buildContextStrings(state, names, 'Bot');
            const warningLine = lines.find((l) => l.includes('CRITICAL'));
            expect(warningLine).toContain('Starving');
        });

        it('warns very hungry at food=6', () => {
            const state = createWorldState({ food: 6 });
            const lines = buildContextStrings(state, names, 'Bot');
            const warningLine = lines.find((l) => l.includes('WARNING'));
            expect(warningLine).toContain('hungry');
        });

        it('warns critical health at health=4', () => {
            const state = createWorldState({ health: 4 });
            const lines = buildContextStrings(state, names, 'Bot');
            const warningLine = lines.find((l) => l.includes('CRITICAL'));
            expect(warningLine).toContain('4/20');
        });

        it('warns low health at health=10', () => {
            const state = createWorldState({ health: 10 });
            const lines = buildContextStrings(state, names, 'Bot');
            const warningLine = lines.find((l) => l.includes('WARNING'));
            expect(warningLine).toContain('10/20');
        });

        it('shows health regenerating when food is full and health is not', () => {
            const state = createWorldState({ health: 16, food: 20 });
            const lines = buildContextStrings(state, names, 'Bot');
            const regenLine = lines.find((l) => l.includes('regenerating'));
            expect(regenLine).toBeTruthy();
        });

        it('no warnings when health and food are full', () => {
            const state = createWorldState({ health: 20, food: 20 });
            const lines = buildContextStrings(state, names, 'Bot');
            const warningLine = lines.find((l) => l.includes('CRITICAL') || l.includes('WARNING') || l.includes('regenerating'));
            expect(warningLine).toBeUndefined();
        });
    });

    describe('behavior modes', () => {
        it('omits mode line when passive', () => {
            const state = createWorldState({ botMode: 'passive' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('behavior mode'))).toBeUndefined();
        });

        it('shows aggro mode description', () => {
            const state = createWorldState({ botMode: 'aggro' });
            const lines = buildContextStrings(state, names, 'Bot');
            const modeLine = lines.find((l) => l.includes('behavior mode'));
            expect(modeLine).toContain('AGGRO');
            expect(modeLine).toContain('hostile mobs');
        });

        it('shows hunt mode description', () => {
            const state = createWorldState({ botMode: 'hunt' });
            const lines = buildContextStrings(state, names, 'Bot');
            const modeLine = lines.find((l) => l.includes('behavior mode'));
            expect(modeLine).toContain('HUNT');
            expect(modeLine).toContain('farm animals');
        });

        it('shows guard mode description', () => {
            const state = createWorldState({ botMode: 'guard' });
            const lines = buildContextStrings(state, names, 'Bot');
            const modeLine = lines.find((l) => l.includes('behavior mode'));
            expect(modeLine).toContain('GUARD');
        });
    });

    describe('nearby entities', () => {
        it('lists nearby players with Voxta name resolution', () => {
            const playerNames = new NameRegistry();
            playerNames.register('Lapiro', 'Emptyngton');
            const state = createWorldState({
                nearbyPlayers: [{ name: 'Emptyngton', type: 'player', distance: 5.2, position: { x: 105, y: 64, z: -195 } }],
            });
            const lines = buildContextStrings(state, playerNames, 'Bot');
            const playerLine = lines.find((l) => l.includes('Nearby players'));
            expect(playerLine).toContain('Lapiro');
            expect(playerLine).toContain('5.2m');
        });

        it('lists nearby mobs', () => {
            const state = createWorldState({
                nearbyMobs: [
                    { name: 'Zombie', type: 'hostile', distance: 8.0, position: { x: 108, y: 64, z: -200 } },
                    { name: 'Cow', type: 'animal', distance: 12.5, position: { x: 112, y: 64, z: -188 } },
                ],
            });
            const lines = buildContextStrings(state, names, 'Bot');
            const mobLine = lines.find((l) => l.includes('Nearby mobs'));
            expect(mobLine).toContain('Zombie');
            expect(mobLine).toContain('Cow');
        });

        it('shows "none" when no mobs nearby', () => {
            const state = createWorldState({ nearbyMobs: [] });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('Nearby mobs: none'))).toBeTruthy();
        });

        it('limits mob list to 10 entries', () => {
            const mobs = Array.from({ length: 15 }, (_, i) => ({
                name: `Zombie${i}`, type: 'hostile', distance: i + 1, position: { x: 100 + i, y: 64, z: -200 },
            }));
            const state = createWorldState({ nearbyMobs: mobs });
            const lines = buildContextStrings(state, names, 'Bot');
            const mobLine = lines.find((l) => l.includes('Nearby mobs'));
            // Should contain Zombie0 through Zombie9 but not Zombie10+
            expect(mobLine).toContain('Zombie9');
            expect(mobLine).not.toContain('Zombie10');
        });
    });

    describe('inventory and equipment', () => {
        it('lists inventory items', () => {
            const state = createWorldState({
                inventorySummary: ['Diamond Sword x1', 'Cobblestone x64', 'Torch x32'],
            });
            const lines = buildContextStrings(state, names, 'Bot');
            const invLine = lines.find((l) => l.includes('inventory'));
            expect(invLine).toContain('Diamond Sword x1');
            expect(invLine).toContain('Cobblestone x64');
        });

        it('shows empty inventory', () => {
            const state = createWorldState({ inventorySummary: [] });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('inventory: empty'))).toBeTruthy();
        });

        it('shows held item', () => {
            const state = createWorldState({ heldItem: 'diamond_sword' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('holding: diamond_sword'))).toBeTruthy();
        });

        it('shows armor pieces', () => {
            const state = createWorldState({ armor: ['iron_helmet', 'iron_chestplate'] });
            const lines = buildContextStrings(state, names, 'Bot');
            const armorLine = lines.find((l) => l.includes('armor'));
            expect(armorLine).toContain('iron helmet');
            expect(armorLine).toContain('iron chestplate');
        });

        it('shows no armor', () => {
            const state = createWorldState({ armor: [] });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('armor: none'))).toBeTruthy();
        });
    });

    describe('riding state', () => {
        it('includes riding info for horse', () => {
            const state = createWorldState({ riding: 'Horse', movement: 'riding a Horse' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('riding a Horse'))).toBeTruthy();
            expect(lines.find((l) => l.includes('mc_dismount'))).toBeTruthy();
        });

        it('includes boat steering warning', () => {
            const state = createWorldState({ riding: 'Oak Boat', movement: 'riding a Oak Boat' });
            const lines = buildContextStrings(state, names, 'Bot');
            const boatLine = lines.find((l) => l.includes('cannot steer'));
            expect(boatLine).toContain('Boat');
        });
    });

    describe('game mode rules', () => {
        it('includes creative mode rules', () => {
            const state = createWorldState({ gameMode: 'creative' });
            const lines = buildContextStrings(state, names, 'Bot');
            const ruleLine = lines.find((l) => l.includes('GAME MODE RULES'));
            expect(ruleLine).toContain('Creative');
            expect(ruleLine).toContain('unlimited items');
        });

        it('includes adventure mode rules', () => {
            const state = createWorldState({ gameMode: 'adventure' });
            const lines = buildContextStrings(state, names, 'Bot');
            const ruleLine = lines.find((l) => l.includes('GAME MODE RULES'));
            expect(ruleLine).toContain('Adventure');
            expect(ruleLine).toContain('cannot break');
        });

        it('no rules line for survival mode', () => {
            const state = createWorldState({ gameMode: 'survival' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('GAME MODE RULES'))).toBeUndefined();
        });
    });

    describe('home position', () => {
        it('shows home distance when set', () => {
            const state = createWorldState({
                position: { x: 100, y: 64, z: -200 },
                homePosition: { x: 0, y: 64, z: 0 },
            });
            const lines = buildContextStrings(state, names, 'Bot');
            const homeLine = lines.find((l) => l.includes('Home bed'));
            expect(homeLine).toContain('0, 64, 0');
            expect(homeLine).toContain('blocks away');
        });

        it('shows not set when no home', () => {
            const state = createWorldState({ homePosition: null });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('not set'))).toBeTruthy();
        });
    });

    describe('active effects', () => {
        it('lists active effects', () => {
            const state = createWorldState({
                activeEffects: ['Poison II (0:15)', 'Slowness (1:30)'],
            });
            const lines = buildContextStrings(state, names, 'Bot');
            const effectLine = lines.find((l) => l.includes('active effects'));
            expect(effectLine).toContain('Poison II');
            expect(effectLine).toContain('Slowness');
        });

        it('omits effects line when none active', () => {
            const state = createWorldState({ activeEffects: [] });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('active effects'))).toBeUndefined();
        });
    });

    describe('activity and movement', () => {
        it('shows current activity', () => {
            const state = createWorldState({ currentActivity: 'Mining diamond_ore (3/5)' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('Mining diamond_ore'))).toBeTruthy();
        });

        it('shows idle when no activity', () => {
            const state = createWorldState({ currentActivity: null });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('activity: idle'))).toBeTruthy();
        });

        it('shows movement state', () => {
            const state = createWorldState({ movement: 'swimming' });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('movement: swimming'))).toBeTruthy();
        });
    });

    describe('nearby blocks', () => {
        it('lists nearby blocks', () => {
            const state = createWorldState({
                nearbyBlocks: ['crafting table', 'chest x3', 'furnace x2'],
            });
            const lines = buildContextStrings(state, names, 'Bot');
            const blockLine = lines.find((l) => l.includes('Nearby blocks'));
            expect(blockLine).toContain('crafting table');
            expect(blockLine).toContain('chest x3');
        });

        it('omits nearby blocks line when none found', () => {
            const state = createWorldState({ nearbyBlocks: [] });
            const lines = buildContextStrings(state, names, 'Bot');
            expect(lines.find((l) => l.includes('Nearby blocks'))).toBeUndefined();
        });
    });
});
