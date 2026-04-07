import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { CRAFT_ALIASES } from '../game-data';
import { setSuppressPickups } from './action-state.js';

// Delay between crafting steps to avoid Paper's place_recipe rate limiter
// (default: 5 packets per 4 seconds). Each bot.craft() fires multiple packets.
const CRAFT_STEP_DELAY_MS = 250;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- Crafting types ----

type McDataItems = Record<string, { id: number; displayName: string; name: string } | undefined>;
type McDataItemsById = Record<number, { id: number; displayName: string; name: string } | undefined>;

/** Get the display name for an item ID, falling back to the raw ID */
function getItemDisplayName(mcData: { items: McDataItemsById }, itemId: number): string {
    const info = mcData.items[itemId];
    return info?.displayName ?? `item#${itemId}`;
}

/** Count how many of a specific item ID the bot has in inventory */
function countItemInInventory(bot: Bot, itemId: number): number {
    return bot.inventory
        .items()
        .filter((i) => i.type === itemId)
        .reduce((sum, i) => sum + i.count, 0);
}

interface CraftResult {
    success: boolean;
    crafted: number;
    steps: string[];
    missing: string[];
}

/**
 * Recursively craft an item and its prerequisites.
 * Uses BFS-style dependency resolution: if ingredient X is missing,
 * try to craft X first from whatever raw materials are available.
 */
async function autoCraftWithPrereqs(
    bot: Bot,
    mcData: { items: McDataItemsById; itemsByName: McDataItems },
    itemId: number,
    count: number,
    craftingTable: ReturnType<Bot['findBlock']>,
    depth: number = 0,
): Promise<CraftResult> {
    const displayName = getItemDisplayName(mcData, itemId);

    // Safety: prevent infinite recursion
    if (depth > 5) {
        return { success: false, crafted: 0, steps: [], missing: [`don't have the materials to make ${displayName}`] };
    }

    // For prerequisites only: skip crafting if we already have enough
    // (Top-level craft: user wants N MORE, not "ensure I have N")
    const alreadyHave = countItemInInventory(bot, itemId);
    if (depth > 0 && alreadyHave >= count) {
        return { success: true, crafted: 0, steps: [], missing: [] };
    }
    const stillNeed = depth > 0 ? count - alreadyHave : count;

    // Try direct craft first (bot has all materials)
    let recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    if (recipes.length > 0) {
        try {
            const before = countItemInInventory(bot, itemId);
            await bot.craft(recipes[0], stillNeed, craftingTable ?? undefined);
            const gained = countItemInInventory(bot, itemId) - before;
            return { success: true, crafted: gained, steps: [`${gained} ${displayName}`], missing: [] };
        } catch {
            // Fall through to try auto-prereqs
        }
    }

    // Delay before switching to auto-prereq path — let server process previous packets
    if (depth > 0) await delay(CRAFT_STEP_DELAY_MS);

    // Can't craft directly — get ALL recipes (regardless of inventory)
    const allRecipes = bot.recipesAll(itemId, null, craftingTable);
    if (allRecipes.length === 0) {
        // No recipe exists — this is a raw material (logs, ores, etc.)
        return {
            success: false,
            crafted: 0,
            steps: [],
            missing: [`need to find ${stillNeed} ${displayName} in the world`],
        };
    }

    // Score each recipe variant by how many ingredients we already have,
    // so we prefer oak_planks when we have oak_log over cherry_planks when we don't have cherry_log.
    // Tiebreaker: for missing ingredients, check if their own recipes can be satisfied
    // (e.g., oak_planks needs oak_log — score higher if we have oak_log).
    const scored = allRecipes.map((recipe) => {
        let score = 0;
        let tiebreaker = 0;
        for (const delta of recipe.delta) {
            if (delta.count < 0) {
                const have = countItemInInventory(bot, delta.id);
                score += have;
                // For missing ingredients, check if we can craft them from available materials
                if (have < Math.abs(delta.count)) {
                    const subRecipes = bot.recipesAll(delta.id, null, craftingTable);
                    for (const sub of subRecipes) {
                        for (const subDelta of sub.delta) {
                            if (subDelta.count < 0) {
                                tiebreaker += countItemInInventory(bot, subDelta.id);
                            }
                        }
                    }
                }
            }
        }
        return { recipe, score, tiebreaker };
    });
    scored.sort((a, b) => b.score - a.score || b.tiebreaker - a.tiebreaker);

    // Try each recipe variant until one succeeds
    let lastMissing: string[] = [];
    for (const { recipe } of scored) {
        const ingredients: { id: number; countPerCraft: number }[] = [];
        for (const delta of recipe.delta) {
            if (delta.count < 0) {
                ingredients.push({ id: delta.id, countPerCraft: Math.abs(delta.count) });
            }
        }

        // Figure out how many times we need to run this recipe
        const resultPerCraft = recipe.result?.count ?? 1;
        const craftRuns = Math.ceil(stillNeed / resultPerCraft);

        // Recursively ensure we have enough of each ingredient
        const allSteps: string[] = [];
        const allMissing: string[] = [];
        let prereqFailed = false;
        for (const ingredient of ingredients) {
            const totalNeeded = ingredient.countPerCraft * craftRuns;
            const have = countItemInInventory(bot, ingredient.id);
            if (have < totalNeeded) {
                const prereqResult = await autoCraftWithPrereqs(
                    bot,
                    mcData,
                    ingredient.id,
                    totalNeeded,
                    craftingTable,
                    depth + 1,
                );
                allSteps.push(...prereqResult.steps);
                allMissing.push(...prereqResult.missing);
                if (!prereqResult.success) {
                    prereqFailed = true;
                    break;
                }
                // Delay between prerequisite crafts to avoid Paper rate-limiting
                await delay(CRAFT_STEP_DELAY_MS);
            }
        }

        if (prereqFailed) {
            lastMissing = allMissing;
            continue; // Try the next recipe variant
        }

        // All prerequisites resolved — delay to let server catch up, then retry
        await delay(CRAFT_STEP_DELAY_MS);
        recipes = bot.recipesFor(itemId, null, 1, craftingTable);
        if (recipes.length > 0) {
            try {
                const before = countItemInInventory(bot, itemId);
                await bot.craft(recipes[0], craftRuns, craftingTable ?? undefined);
                const gained = countItemInInventory(bot, itemId) - before;
                allSteps.push(`${gained} ${displayName}`);
                return { success: true, crafted: gained, steps: allSteps, missing: [] };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { success: false, crafted: 0, steps: allSteps, missing: [`${displayName}: ${message}`] };
            }
        }

        // Collect what's still missing for this variant
        const missingDetails: string[] = [];
        for (const ingredient of ingredients) {
            const totalNeeded = ingredient.countPerCraft * craftRuns;
            const have = countItemInInventory(bot, ingredient.id);
            if (have < totalNeeded) {
                const name = getItemDisplayName(mcData, ingredient.id);
                missingDetails.push(`${totalNeeded - have} ${name}`);
            }
        }
        lastMissing = missingDetails;
    }

    // No recipe variant worked
    return {
        success: false,
        crafted: 0,
        steps: [],
        missing: lastMissing.length > 0 ? lastMissing : [`${displayName} (unknown reason)`],
    };
}

/** Re-equip held item and clear suppression */
async function cleanup(bot: Bot, heldItemName: string | null): Promise<void> {
    if (heldItemName) {
        const reequip = bot.inventory.items().find((i) => i.name === heldItemName);
        if (reequip) await bot.equip(reequip, 'hand');
    }
    // Delay must exceed the 500ms inventory polling interval so the poll
    // fires at least once while suppressed and updates the snapshot
    setTimeout(() => {
        setSuppressPickups(false);
    }, 600);
}

/** Generic crafting categories — when user says 'planks', try all variants */
const ALL_PLANKS = [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
];
const ALL_BOATS = [
    'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
    'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat',
];
const ALL_FENCES = [
    'oak_fence', 'spruce_fence', 'birch_fence', 'jungle_fence',
    'acacia_fence', 'dark_oak_fence', 'mangrove_fence', 'cherry_fence',
];
// Tools — ordered simplest-first; when no materials are available (all score 0)
// the first variant with recipes wins, so wooden is tried first
const ALL_PICKAXES = [
    'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe',
];
const ALL_SWORDS = [
    'wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword',
];
const ALL_AXES = [
    'wooden_axe', 'stone_axe', 'iron_axe', 'golden_axe', 'diamond_axe',
];
const ALL_SHOVELS = [
    'wooden_shovel', 'stone_shovel', 'iron_shovel', 'golden_shovel', 'diamond_shovel',
];
const ALL_HOES = [
    'wooden_hoe', 'stone_hoe', 'iron_hoe', 'golden_hoe', 'diamond_hoe',
];
const GENERIC_CRAFT_VARIANTS: Record<string, string[]> = {
    planks: ALL_PLANKS,
    plank: ALL_PLANKS,
    wooden_planks: ALL_PLANKS,
    wooden_plank: ALL_PLANKS,
    wood_planks: ALL_PLANKS,
    boat: ALL_BOATS,
    wooden_boat: ALL_BOATS,
    fence: ALL_FENCES,
    wooden_fence: ALL_FENCES,
    pickaxe: ALL_PICKAXES,
    pick: ALL_PICKAXES,
    sword: ALL_SWORDS,
    axe: ALL_AXES,
    shovel: ALL_SHOVELS,
    spade: ALL_SHOVELS,
    hoe: ALL_HOES,
};

/** Resolve a generic craft name to the best variant the bot can actually make */
function resolveGenericCraft(
    bot: Bot,
    mcData: { itemsByName: McDataItems },
    genericName: string,
): { id: number; displayName: string; name: string } | undefined {
    const variants = GENERIC_CRAFT_VARIANTS[genericName];
    if (!variants) return undefined;

    // Find nearby crafting table for recipe checks — tools REQUIRE one
    const craftingTable = bot.findBlock({
        matching: (block) => block.name === 'crafting_table',
        maxDistance: 32,
    });

    // Score each variant by available materials
    let bestItem: { id: number; displayName: string; name: string } | undefined;
    let bestScore = -1;
    let fallbackItem: { id: number; displayName: string; name: string } | undefined;
    for (const variant of variants) {
        const info = mcData.itemsByName[variant];
        if (!info) continue;
        // Track the last valid item as fallback (last in array = simplest tier)
        fallbackItem = info;
        // Check recipes both without and with a crafting table
        const recipes = [
            ...bot.recipesAll(info.id, null, null),
            ...bot.recipesAll(info.id, null, craftingTable),
        ];
        if (recipes.length === 0) continue;
        // Score = how many ingredient items we have
        let score = 0;
        for (const recipe of recipes) {
            for (const delta of recipe.delta) {
                if (delta.count < 0) {
                    score += bot.inventory.items()
                        .filter((i) => i.type === delta.id)
                        .reduce((sum, i) => sum + i.count, 0);
                }
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestItem = info;
        }
    }
    // If no variant had recipes (no crafting table nearby), fall back to simplest tier
    return bestItem ?? fallbackItem;
}

export async function craftItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const mcData = require('minecraft-data')(bot.version) as {
        itemsByName: McDataItems;
        items: McDataItemsById;
    };
    const count = countStr ? parseInt(countStr, 10) : 1;

    // Check for generic category first (e.g. 'planks' → best available plank type)
    const normalized = itemName.toLowerCase().replace(/ /g, '_');
    const genericItem = resolveGenericCraft(bot, mcData, normalized);

    // Resolve name via alias or generic
    const resolved = genericItem?.name ?? CRAFT_ALIASES[normalized] ?? normalized;
    const itemInfo = genericItem ?? mcData.itemsByName[resolved];
    if (!itemInfo) return `Unknown item: ${itemName}`;

    // Suppress pickup notes for the entire crafting process
    // (equip/unequip/craft all trigger inventory slot changes)
    setSuppressPickups(true);

    // Move held item to inventory so recipesFor can find it as a material
    const heldItemName = bot.heldItem?.name ?? null;
    if (heldItemName) {
        await bot.unequip('hand');
    }

    const countBefore = countItemInInventory(bot, itemInfo.id);

    // Find a crafting table if needed (try without first)
    let craftingTable: ReturnType<Bot['findBlock']> = null;
    const recipes = bot.recipesFor(itemInfo.id, null, 1, null);

    if (recipes.length === 0) {
        // Need to check with a crafting table
        craftingTable = bot.findBlock({
            matching: (block) => block.name === 'crafting_table',
            maxDistance: 32,
        });

        if (craftingTable) {
            try {
                await bot.pathfinder.goto(
                    new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2),
                );
            } catch {
                await cleanup(bot, heldItemName);
                return 'Cannot reach the crafting table';
            }
        }
    }

    // Auto-craft with prerequisite resolution
    const result = await autoCraftWithPrereqs(bot, mcData, itemInfo.id, count, craftingTable);

    let message: string;
    if (result.success) {
        const totalGained = countItemInInventory(bot, itemInfo.id) - countBefore;
        // Show what was auto-crafted along the way
        if (result.steps.length > 1) {
            // Multiple steps = auto-crafted prerequisites
            const prereqSteps = result.steps.slice(0, -1).join(', ');
            message = `Crafted ${totalGained} ${itemInfo.displayName} (auto-crafted: ${prereqSteps})`;
        } else {
            message = `Crafted ${totalGained} ${itemInfo.displayName}`;
        }
    } else if (result.missing.length > 0) {
        // Check if the missing items are raw materials with known gathering hints
        const RAW_MATERIAL_HINTS: Record<string, string> = {
            string: 'Kill spiders to get string, or mine cobwebs with a sword.',
            leather: 'Kill cows to get leather.',
            feather: 'Kill chickens to get feathers.',
            bone: 'Kill skeletons to get bones.',
            gunpowder: 'Kill creepers to get gunpowder.',
            ender_pearl: 'Kill endermen to get ender pearls.',
            blaze_rod: 'Kill blazes in the Nether.',
            slime_ball: 'Kill slimes to get slime balls.',
            spider_eye: 'Kill spiders to get spider eyes.',
            ink_sac: 'Kill squids to get ink sacs.',
            flint: 'Mine gravel — it has a chance to drop flint.',
            diamond: 'Mine diamond_ore with an iron pickaxe or better.',
            coal: 'Mine coal_ore to get coal.',
            iron_ingot: 'Mine iron_ore and smelt it in a furnace.',
            gold_ingot: 'Mine gold_ore and smelt it in a furnace.',
            rotten_flesh: 'Kill zombies to get rotten flesh.',
        };
        // If a missing item matches a raw material hint, use that instead
        const missingHints = result.missing.map((m) => {
            // Extract the item name from "need to find N ItemName in the world"
            const match = m.match(/^need to find\s+\d+\s+(.+?)\s+in the world/);
            if (match) {
                const rawName = match[1].toLowerCase().replace(/ /g, '_');
                const hint = RAW_MATERIAL_HINTS[rawName];
                if (hint) return hint;
            }
            return m;
        });
        message = `Tried to craft ${itemInfo.displayName} but ${missingHints.join('; ')}`;
    } else {
        message = `Tried to craft ${itemInfo.displayName} but don't have the right materials`;
    }

    await cleanup(bot, heldItemName);
    return message;
}
