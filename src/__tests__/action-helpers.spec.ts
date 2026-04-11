import { describe, it, expect } from 'vitest';
import {
    cleanArgValue,
    getArg,
    getEquipSlot,
    getToolCategory,
    getBestTool,
    getBestWeapon,
    getBestBow,
    getArrowCount,
    getToolIfStrongEnough,
} from '../bot/minecraft/actions/action-helpers';

// ---- cleanArgValue ----

describe('cleanArgValue', () => {
    it('returns plain values unchanged', () => {
        expect(cleanArgValue('oak_log')).toBe('oak_log');
    });

    it('trims whitespace', () => {
        expect(cleanArgValue('  oak_log  ')).toBe('oak_log');
    });

    it('strips surrounding double quotes', () => {
        expect(cleanArgValue('"oak_log"')).toBe('oak_log');
    });

    it('strips surrounding single quotes', () => {
        expect(cleanArgValue("'oak_log'")).toBe('oak_log');
    });

    it('strips type annotation prefix (string = "value")', () => {
        expect(cleanArgValue('string = "oak_log"')).toBe('oak_log');
    });

    it('strips type annotation without space (string="value")', () => {
        expect(cleanArgValue('string="oak_log"')).toBe('oak_log');
    });

    it('handles leading = sign', () => {
        expect(cleanArgValue('= "Lapiro"')).toBe('Lapiro');
    });

    it('handles unbalanced quotes', () => {
        expect(cleanArgValue('"oak_log')).toBe('oak_log');
        expect(cleanArgValue("oak_log'")).toBe('oak_log');
    });

    it('handles multiple = signs (takes after last)', () => {
        expect(cleanArgValue('a=b="final"')).toBe('final');
    });

    it('returns empty string for empty input', () => {
        expect(cleanArgValue('')).toBe('');
        expect(cleanArgValue('  ')).toBe('');
    });
});

// ---- getArg ----

describe('getArg', () => {
    const args = [
        { name: 'player_name', value: '"Steve"' },
        { name: 'count', value: '5' },
        { name: 'Block_Type', value: 'string = "oak_log"' },
    ];

    it('finds argument by name (case-insensitive)', () => {
        expect(getArg(args, 'player_name')).toBe('Steve');
        expect(getArg(args, 'PLAYER_NAME')).toBe('Steve');
        expect(getArg(args, 'Player_Name')).toBe('Steve');
    });

    it('cleans the value through cleanArgValue', () => {
        expect(getArg(args, 'block_type')).toBe('oak_log');
    });

    it('returns plain values as-is', () => {
        expect(getArg(args, 'count')).toBe('5');
    });

    it('returns undefined for missing argument', () => {
        expect(getArg(args, 'nonexistent')).toBeUndefined();
    });

    it('returns undefined for undefined args array', () => {
        expect(getArg(undefined, 'player_name')).toBeUndefined();
    });

    it('returns undefined for empty args array', () => {
        expect(getArg([], 'player_name')).toBeUndefined();
    });
});

// ---- getEquipSlot ----

describe('getEquipSlot', () => {
    it('detects helmets', () => {
        expect(getEquipSlot('iron_helmet')).toBe('head');
        expect(getEquipSlot('diamond_helmet')).toBe('head');
        expect(getEquipSlot('leather_cap')).toBe('head');
    });

    it('detects chestplates', () => {
        expect(getEquipSlot('iron_chestplate')).toBe('torso');
        expect(getEquipSlot('leather_tunic')).toBe('torso');
    });

    it('detects leggings', () => {
        expect(getEquipSlot('iron_leggings')).toBe('legs');
        expect(getEquipSlot('diamond_pants')).toBe('legs');
    });

    it('detects boots', () => {
        expect(getEquipSlot('iron_boots')).toBe('feet');
        expect(getEquipSlot('diamond_boots')).toBe('feet');
    });

    it('defaults to hand for weapons and tools', () => {
        expect(getEquipSlot('diamond_sword')).toBe('hand');
        expect(getEquipSlot('iron_pickaxe')).toBe('hand');
        expect(getEquipSlot('shield')).toBe('hand');
    });
});

// ---- getToolCategory ----

describe('getToolCategory', () => {
    it('returns pickaxe for stone and ores', () => {
        expect(getToolCategory('stone')).toBe('pickaxe');
        expect(getToolCategory('iron_ore')).toBe('pickaxe');
        expect(getToolCategory('diamond_ore')).toBe('pickaxe');
    });

    it('returns none for dirt/sand blocks', () => {
        expect(getToolCategory('dirt')).toBe('none');
        expect(getToolCategory('sand')).toBe('none');
    });

    it('returns none for unknown blocks', () => {
        expect(getToolCategory('unknown_block')).toBe('none');
    });
});

// ---- Mock bot inventory helpers ----

interface MockItem {
    name: string;
    type: number;
    count: number;
}

function createMockBot(items: MockItem[]) {
    return {
        inventory: {
            items: () => items,
        },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

// ---- getBestTool ----

describe('getBestTool', () => {
    it('returns the best pickaxe by tier', () => {
        const bot = createMockBot([
            { name: 'stone_pickaxe', type: 1, count: 1 },
            { name: 'iron_pickaxe', type: 2, count: 1 },
        ]);
        const result = getBestTool(bot, 'pickaxe');
        expect(result).not.toBeNull();
        expect(result!.name).toBe('iron_pickaxe');
    });

    it('returns netherite over diamond', () => {
        const bot = createMockBot([
            { name: 'diamond_pickaxe', type: 1, count: 1 },
            { name: 'netherite_pickaxe', type: 2, count: 1 },
        ]);
        const result = getBestTool(bot, 'pickaxe');
        expect(result!.name).toBe('netherite_pickaxe');
    });

    it('returns null when no tool of that category exists', () => {
        const bot = createMockBot([
            { name: 'diamond_sword', type: 1, count: 1 },
        ]);
        expect(getBestTool(bot, 'pickaxe')).toBeNull();
    });

    it('returns null for category "none"', () => {
        const bot = createMockBot([
            { name: 'iron_pickaxe', type: 1, count: 1 },
        ]);
        expect(getBestTool(bot, 'none')).toBeNull();
    });
});

// ---- getBestWeapon ----

describe('getBestWeapon', () => {
    it('prefers swords over axes', () => {
        const bot = createMockBot([
            { name: 'iron_axe', type: 1, count: 1 },
            { name: 'iron_sword', type: 2, count: 1 },
        ]);
        const result = getBestWeapon(bot);
        expect(result!.name).toBe('iron_sword');
    });

    it('prefers higher tier within same weapon type', () => {
        const bot = createMockBot([
            { name: 'wooden_sword', type: 1, count: 1 },
            { name: 'diamond_sword', type: 2, count: 1 },
        ]);
        const result = getBestWeapon(bot);
        expect(result!.name).toBe('diamond_sword');
    });

    it('falls back to axes when no swords', () => {
        const bot = createMockBot([
            { name: 'stone_axe', type: 1, count: 1 },
        ]);
        const result = getBestWeapon(bot);
        expect(result!.name).toBe('stone_axe');
    });

    it('falls back to pickaxes when no swords or axes', () => {
        const bot = createMockBot([
            { name: 'iron_pickaxe', type: 1, count: 1 },
        ]);
        const result = getBestWeapon(bot);
        expect(result!.name).toBe('iron_pickaxe');
    });

    it('returns null with empty inventory', () => {
        const bot = createMockBot([]);
        expect(getBestWeapon(bot)).toBeNull();
    });
});

// ---- getBestBow ----

describe('getBestBow', () => {
    it('finds a bow in inventory', () => {
        const bot = createMockBot([
            { name: 'dirt', type: 1, count: 64 },
            { name: 'bow', type: 2, count: 1 },
        ]);
        const result = getBestBow(bot);
        expect(result!.name).toBe('bow');
    });

    it('prefers bow over crossbow', () => {
        const bot = createMockBot([
            { name: 'crossbow', type: 1, count: 1 },
            { name: 'bow', type: 2, count: 1 },
        ]);
        const result = getBestBow(bot);
        expect(result!.name).toBe('bow');
    });

    it('returns null when no ranged weapon', () => {
        const bot = createMockBot([
            { name: 'iron_sword', type: 1, count: 1 },
        ]);
        expect(getBestBow(bot)).toBeNull();
    });
});

// ---- getArrowCount ----

describe('getArrowCount', () => {
    it('counts all arrow types', () => {
        const bot = createMockBot([
            { name: 'arrow', type: 1, count: 32 },
            { name: 'spectral_arrow', type: 2, count: 8 },
            { name: 'tipped_arrow', type: 3, count: 4 },
        ]);
        expect(getArrowCount(bot)).toBe(44);
    });

    it('returns 0 with no arrows', () => {
        const bot = createMockBot([
            { name: 'dirt', type: 1, count: 64 },
        ]);
        expect(getArrowCount(bot)).toBe(0);
    });

    it('returns 0 with empty inventory', () => {
        const bot = createMockBot([]);
        expect(getArrowCount(bot)).toBe(0);
    });
});

// ---- getToolIfStrongEnough ----

describe('getToolIfStrongEnough', () => {
    it('returns tool when no minimum tier required', () => {
        const bot = createMockBot([
            { name: 'wooden_pickaxe', type: 1, count: 1 },
        ]);
        // stone has no min tier requirement
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'stone');
        expect(result).not.toBeNull();
        expect(result!.name).toBe('wooden_pickaxe');
    });

    it('returns null when tool is too weak for the block', () => {
        const bot = createMockBot([
            { name: 'wooden_pickaxe', type: 1, count: 1 },
        ]);
        // iron_ore requires stone tier minimum
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'iron_ore');
        expect(result).toBeNull();
    });

    it('returns tool when tier meets minimum', () => {
        const bot = createMockBot([
            { name: 'stone_pickaxe', type: 1, count: 1 },
        ]);
        // iron_ore requires stone tier — stone meets it
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'iron_ore');
        expect(result).not.toBeNull();
        expect(result!.name).toBe('stone_pickaxe');
    });

    it('returns tool when tier exceeds minimum', () => {
        const bot = createMockBot([
            { name: 'diamond_pickaxe', type: 1, count: 1 },
        ]);
        // iron_ore requires stone — diamond exceeds it
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'iron_ore');
        expect(result).not.toBeNull();
        expect(result!.name).toBe('diamond_pickaxe');
    });

    it('returns null when no tool of that category exists', () => {
        const bot = createMockBot([
            { name: 'iron_sword', type: 1, count: 1 },
        ]);
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'stone');
        expect(result).toBeNull();
    });

    it('diamond pickaxe can mine obsidian', () => {
        const bot = createMockBot([
            { name: 'diamond_pickaxe', type: 1, count: 1 },
        ]);
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'obsidian');
        expect(result).not.toBeNull();
    });

    it('iron pickaxe cannot mine obsidian', () => {
        const bot = createMockBot([
            { name: 'iron_pickaxe', type: 1, count: 1 },
        ]);
        const result = getToolIfStrongEnough(bot, 'pickaxe', 'obsidian');
        expect(result).toBeNull();
    });
});
