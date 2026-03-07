import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { ActionInvocationArgument } from '../../voxta/types.js';
import type { NameRegistry } from '../../name-registry';
import type { ToolCategory } from '../game-data';
import { TOOL_REQUIREMENTS, TOOL_TIERS } from '../game-data';

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
        (e) => e.type === 'player' &&
            e !== bot.entity &&
            e.username?.toLowerCase() === mcName.toLowerCase()
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
