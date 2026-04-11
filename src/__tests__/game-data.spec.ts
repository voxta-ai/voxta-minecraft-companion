import { describe, it, expect } from 'vitest';
import {
    TOOL_REQUIREMENTS,
    TOOL_TIERS,
    TOOL_MIN_TIER,
    FOOD_ITEMS,
    RANGED_WEAPONS,
    ARROW_ITEMS,
    COOKABLE_ITEMS,
    FUEL_ITEMS,
    BED_BLOCKS,
    CRAFT_ALIASES,
    ITEM_ALIASES,
    ENTITY_ALIASES,
    LOW_HEALTH_THRESHOLD,
    RANGED_MOBS,
    DOOR_BLOCKS,
    RIDEABLE_ENTITIES,
    NEUTRAL_HOSTILE_MOBS,
    AGGRO_SKIP_MOBS,
    HUNTABLE_ANIMALS,
    SPLIT_MOBS,
} from '../bot/minecraft/game-data';

// ---- Static data integrity ----

describe('TOOL_REQUIREMENTS', () => {
    it('maps blocks to valid tool categories', () => {
        const validCategories = ['axe', 'pickaxe', 'shovel', 'none'];
        for (const [block, category] of Object.entries(TOOL_REQUIREMENTS)) {
            expect(validCategories, `${block} has invalid category "${category}"`).toContain(category);
        }
    });

    it('has entries for common blocks', () => {
        expect(TOOL_REQUIREMENTS['stone']).toBe('pickaxe');
        expect(TOOL_REQUIREMENTS['iron_ore']).toBe('pickaxe');
        expect(TOOL_REQUIREMENTS['dirt']).toBe('none');
    });
});

describe('TOOL_TIERS', () => {
    it('is ordered from strongest to weakest', () => {
        expect(TOOL_TIERS[0]).toBe('netherite');
        expect(TOOL_TIERS[TOOL_TIERS.length - 1]).toBe('wooden');
    });

    it('has no duplicates', () => {
        expect(new Set(TOOL_TIERS).size).toBe(TOOL_TIERS.length);
    });
});

describe('TOOL_MIN_TIER', () => {
    it('references valid tiers', () => {
        for (const [block, tier] of Object.entries(TOOL_MIN_TIER)) {
            expect(TOOL_TIERS, `${block} requires unknown tier "${tier}"`).toContain(tier);
        }
    });

    it('obsidian requires diamond tier', () => {
        expect(TOOL_MIN_TIER['obsidian']).toBe('diamond');
    });
});

describe('FOOD_ITEMS', () => {
    it('has positive values for cooked foods', () => {
        expect(FOOD_ITEMS['cooked_beef']).toBeGreaterThan(0);
        expect(FOOD_ITEMS['bread']).toBeGreaterThan(0);
    });

    it('has negative values for dangerous foods', () => {
        expect(FOOD_ITEMS['rotten_flesh']).toBeLessThan(0);
        expect(FOOD_ITEMS['spider_eye']).toBeLessThan(0);
    });
});

describe('COOKABLE_ITEMS', () => {
    it('raw foods map to cooked variants', () => {
        expect(COOKABLE_ITEMS['beef']).toBe('cooked_beef');
        expect(COOKABLE_ITEMS['porkchop']).toBe('cooked_porkchop');
        expect(COOKABLE_ITEMS['cod']).toBe('cooked_cod');
    });

    it('ores map to ingots', () => {
        expect(COOKABLE_ITEMS['raw_iron']).toBe('iron_ingot');
        expect(COOKABLE_ITEMS['raw_gold']).toBe('gold_ingot');
    });
});

// ---- Entity classifications ----

describe('LOW_HEALTH_THRESHOLD', () => {
    it('is 6 HP (3 hearts)', () => {
        expect(LOW_HEALTH_THRESHOLD).toBe(6);
    });
});

describe('RANGED_MOBS', () => {
    it('is a Set with no implicit duplicates', () => {
        expect(RANGED_MOBS).toBeInstanceOf(Set);
        expect(RANGED_MOBS.size).toBeGreaterThan(0);
    });

    it('includes known ranged mobs', () => {
        expect(RANGED_MOBS.has('skeleton')).toBe(true);
        expect(RANGED_MOBS.has('ghast')).toBe(true);
        expect(RANGED_MOBS.has('blaze')).toBe(true);
    });

    it('does not include melee mobs', () => {
        expect(RANGED_MOBS.has('zombie')).toBe(false);
        expect(RANGED_MOBS.has('creeper')).toBe(false);
    });
});

describe('NEUTRAL_HOSTILE_MOBS', () => {
    it('is a superset of AGGRO_SKIP_MOBS', () => {
        for (const mob of AGGRO_SKIP_MOBS) {
            expect(NEUTRAL_HOSTILE_MOBS.has(mob), `${mob} is in AGGRO_SKIP but not NEUTRAL_HOSTILE`).toBe(true);
        }
    });

    it('includes passive-neutral mobs not in AGGRO_SKIP', () => {
        expect(NEUTRAL_HOSTILE_MOBS.has('wolf')).toBe(true);
        expect(NEUTRAL_HOSTILE_MOBS.has('bee')).toBe(true);
        expect(NEUTRAL_HOSTILE_MOBS.has('iron_golem')).toBe(true);
        // These should NOT be in the aggro skip list
        expect(AGGRO_SKIP_MOBS.includes('wolf')).toBe(false);
        expect(AGGRO_SKIP_MOBS.includes('bee')).toBe(false);
    });
});

describe('AGGRO_SKIP_MOBS', () => {
    it('has no duplicates', () => {
        expect(new Set(AGGRO_SKIP_MOBS).size).toBe(AGGRO_SKIP_MOBS.length);
    });
});

describe('HUNTABLE_ANIMALS', () => {
    it('contains only passive farm animals', () => {
        for (const animal of HUNTABLE_ANIMALS) {
            expect(NEUTRAL_HOSTILE_MOBS.has(animal), `${animal} is hostile — shouldn't be huntable`).toBe(false);
            expect(RANGED_MOBS.has(animal), `${animal} is a ranged mob — shouldn't be huntable`).toBe(false);
        }
    });

    it('has no duplicates', () => {
        expect(new Set(HUNTABLE_ANIMALS).size).toBe(HUNTABLE_ANIMALS.length);
    });
});

describe('SPLIT_MOBS', () => {
    it('contains slime and magma_cube', () => {
        expect(SPLIT_MOBS).toContain('slime');
        expect(SPLIT_MOBS).toContain('magma_cube');
    });

    it('has no duplicates', () => {
        expect(new Set(SPLIT_MOBS).size).toBe(SPLIT_MOBS.length);
    });
});

describe('DOOR_BLOCKS', () => {
    it('includes all wood types', () => {
        expect(DOOR_BLOCKS).toContain('oak_door');
        expect(DOOR_BLOCKS).toContain('spruce_door');
        expect(DOOR_BLOCKS).toContain('crimson_door');
    });

    it('all entries end with _door', () => {
        for (const door of DOOR_BLOCKS) {
            expect(door).toMatch(/_door$/);
        }
    });

    it('has no duplicates', () => {
        expect(new Set(DOOR_BLOCKS).size).toBe(DOOR_BLOCKS.length);
    });
});

describe('RIDEABLE_ENTITIES', () => {
    it('includes horses and boats', () => {
        expect(RIDEABLE_ENTITIES.has('horse')).toBe(true);
        expect(RIDEABLE_ENTITIES.has('oak_boat')).toBe(true);
        expect(RIDEABLE_ENTITIES.has('minecart')).toBe(true);
    });

    it('does not include non-rideable mobs', () => {
        expect(RIDEABLE_ENTITIES.has('zombie')).toBe(false);
        expect(RIDEABLE_ENTITIES.has('cow')).toBe(false);
    });
});

// ---- Alias tables ----

describe('ENTITY_ALIASES', () => {
    it('maps common names to minecraft names', () => {
        expect(ENTITY_ALIASES['dog']).toBe('wolf');
        expect(ENTITY_ALIASES['dragon']).toBe('ender_dragon');
        expect(ENTITY_ALIASES['bunny']).toBe('rabbit');
    });

    it('all values are lowercase with underscores', () => {
        for (const [alias, target] of Object.entries(ENTITY_ALIASES)) {
            expect(target, `alias "${alias}" maps to invalid name "${target}"`).toMatch(/^[a-z_]+$/);
        }
    });
});

describe('ITEM_ALIASES', () => {
    it('maps AI-friendly names to minecraft names', () => {
        expect(ITEM_ALIASES['raw_fish']).toBe('cod');
        expect(ITEM_ALIASES['steak']).toBe('cooked_beef');
        expect(ITEM_ALIASES['wood']).toBe('oak_log');
    });
});

describe('CRAFT_ALIASES', () => {
    it('maps common names to craftable items', () => {
        expect(CRAFT_ALIASES['crafting table']).toBe('crafting_table');
        expect(CRAFT_ALIASES['workbench']).toBe('crafting_table');
        expect(CRAFT_ALIASES['torches']).toBe('torch');
    });
});

// ---- Cross-reference validation ----

describe('cross-references', () => {
    it('RANGED_WEAPONS items are not in FOOD_ITEMS', () => {
        for (const weapon of RANGED_WEAPONS) {
            expect(weapon in FOOD_ITEMS, `${weapon} is both a weapon and food`).toBe(false);
        }
    });

    it('ARROW_ITEMS are not in FUEL_ITEMS', () => {
        for (const arrow of ARROW_ITEMS) {
            expect(FUEL_ITEMS.includes(arrow), `${arrow} is both an arrow and fuel`).toBe(false);
        }
    });

    it('BED_BLOCKS all end with _bed', () => {
        for (const bed of BED_BLOCKS) {
            expect(bed).toMatch(/_bed$/);
        }
    });

    it('BED_BLOCKS has all 16 colors', () => {
        expect(BED_BLOCKS.length).toBe(16);
    });
});
