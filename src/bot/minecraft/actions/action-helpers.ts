import type { Bot } from 'mineflayer';
import type { Block } from 'prismarine-block';
import type { Entity } from 'prismarine-entity';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { ActionInvocationArgument } from '../../voxta/types.js';
import type { NameRegistry } from '../../name-registry';
import type { ToolCategory } from '../game-data';
import { TOOL_REQUIREMENTS, TOOL_TIERS, TOOL_MIN_TIER, RANGED_WEAPONS, ARROW_ITEMS } from '../game-data';

// ---- Tool helpers ----

export function getToolCategory(blockName: string): ToolCategory {
    return TOOL_REQUIREMENTS[blockName] ?? 'none';
}

export function getBestTool(bot: Bot, category: ToolCategory): { item: unknown; name: string } | null {
    if (category === 'none') return null;

    const items = bot.inventory.items();
    for (const tier of TOOL_TIERS) {
        const toolName = `${tier}_${category}`;
        const found = items.find((item) => item.name === toolName);
        if (found) return { item: found, name: toolName };
    }
    return null;
}

/**
 * Check if the bot's best tool meets the minimum tier to actually get drops.
 * Returns the tool if good enough, null if too weak or missing.
 */
export function getToolIfStrongEnough(
    bot: Bot,
    category: ToolCategory,
    blockName: string,
): { item: unknown; name: string } | null {
    const tool = getBestTool(bot, category);
    if (!tool) return null;

    const minTier = TOOL_MIN_TIER[blockName];
    if (!minTier) return tool; // No minimum — any tier works

    const minTierIdx = TOOL_TIERS.indexOf(minTier);
    // Extract tier from tool name (e.g., 'stone_pickaxe' → 'stone')
    const toolTier = tool.name.replace(`_${category}`, '');
    const toolTierIdx = TOOL_TIERS.indexOf(toolTier);

    // Lower index = stronger tier (netherite=0, wooden=5)
    if (toolTierIdx > minTierIdx) return null; // Too weak
    return tool;
}

/** Find the best weapon in the inventory: swords first, then axes, then other tools as fallback */
export function getBestWeapon(bot: Bot): { item: unknown; name: string } | null {
    const items = bot.inventory.items();
    // Priority: swords (best damage) → axes → pickaxes → shovels
    for (const weaponType of ['sword', 'axe', 'pickaxe', 'shovel']) {
        for (const tier of TOOL_TIERS) {
            const weaponName = `${tier}_${weaponType}`;
            const found = items.find((item) => item.name === weaponName);
            if (found) return { item: found, name: weaponName };
        }
    }
    return null;
}

// ---- Ranged weapon helpers ----

/** Find the best ranged weapon in inventory (bow or crossbow) */
export function getBestBow(bot: Bot): { item: unknown; name: string } | null {
    const items = bot.inventory.items();
    for (const bowType of RANGED_WEAPONS) {
        const found = items.find((item) => item.name === bowType);
        if (found) return { item: found, name: bowType };
    }
    return null;
}

/** Count available arrows in inventory */
export function getArrowCount(bot: Bot): number {
    return bot.inventory.items()
        .filter((i) => ARROW_ITEMS.includes(i.name))
        .reduce((sum, i) => sum + i.count, 0);
}

// ---- Argument helpers ----

/** Strip type annotations, leading '=' and surrounding quotes from argument values.
 *  Handles LLM quirks like: '= "Lapiro"', 'string = "oak_log"', 'string="oak_log', '"value"' */
export function cleanArgValue(raw: string): string {
    let val = raw.trim();
    // If the value contains '=', take everything after the last '='
    // This handles patterns like 'string = "oak_log"' or 'string="oak_log'
    const eqIdx = val.lastIndexOf('=');
    if (eqIdx >= 0) {
        val = val.slice(eqIdx + 1).trim();
    }
    // Strip leading and trailing quotes (handles both balanced and unbalanced)
    while (val.startsWith('"') || val.startsWith("'")) val = val.slice(1);
    while (val.endsWith('"') || val.endsWith("'")) val = val.slice(0, -1);
    return val.trim();
}

export function getArg(args: ActionInvocationArgument[] | undefined, name: string): string | undefined {
    const raw = args?.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
    return raw ? cleanArgValue(raw) : undefined;
}

export function findPlayerEntity(bot: Bot, playerName: string, names: NameRegistry): Entity | undefined {
    // Resolve Voxta name → MC username
    const mcName = names.resolveToMc(playerName);

    return Object.values(bot.entities).find(
        (e) => e.type === 'player' && e !== bot.entity && e.username?.toLowerCase() === mcName.toLowerCase(),
    );
}

// ---- Armor slot detection ----

/** Determine the correct equipment slot for an item */
export function getEquipSlot(itemName: string): 'head' | 'torso' | 'legs' | 'feet' | 'hand' {
    if (itemName.includes('helmet') || itemName.includes('cap')) return 'head';
    if (itemName.includes('chestplate') || itemName.includes('tunic')) return 'torso';
    if (itemName.includes('leggings') || itemName.includes('pants')) return 'legs';
    if (itemName.includes('boots')) return 'feet';
    return 'hand';
}

// ---- Block interaction helpers ----

/** Find a nearby block matching the predicate and navigate to it.
 *  Returns the block on success, or an error string on failure. */
export async function findAndReachBlock(
    bot: Bot,
    matcher: (block: Block) => boolean,
    notFoundMsg: string,
    cantReachMsg: string,
    maxDistance = 32,
): Promise<{ block: Block } | { error: string }> {
    const block = bot.findBlock({ matching: matcher, maxDistance });
    if (!block) return { error: notFoundMsg };

    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
        );
    } catch {
        return { error: cantReachMsg };
    }

    return { block };
}
