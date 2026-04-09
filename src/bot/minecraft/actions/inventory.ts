import type { Bot } from 'mineflayer';
import type { Item } from 'prismarine-item';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { FOOD_ITEMS, ITEM_ALIASES } from '../game-data';
import { findPlayerEntity, getEquipSlot } from './action-helpers.js';
import { setSuppressPickups } from './action-state.js';
import { fishAction } from './fishing.js';

/** Find an inventory item by name — resolves AI aliases, then tries exact → partial matching */
function findInventoryItem(bot: Bot, rawName: string): Item | undefined {
    const normalized = rawName.toLowerCase().replace(/\s+/g, '_');
    const resolved = ITEM_ALIASES[normalized] ?? normalized;
    const items = bot.inventory.items();

    // Exact match on internal name
    const exact = items.find((i) => i.name.toLowerCase() === resolved);
    if (exact) return exact;

    // Exact match on displayName
    const displayExact = items.find(
        (i) => i.displayName && i.displayName.toLowerCase() === rawName.toLowerCase(),
    );
    if (displayExact) return displayExact;

    // Partial match — 'log' matches 'spruce_log', 'sword' matches 'wooden_sword'
    return items.find(
        (i) =>
            i.name.toLowerCase().includes(resolved) ||
            (i.displayName && i.displayName.toLowerCase().includes(rawName.toLowerCase())),
    );
}

/** Find all matching inventory items by name (for toss/count operations) */
function findAllInventoryItems(bot: Bot, rawName: string): Item[] {
    const normalized = rawName.toLowerCase().replace(/\s+/g, '_');
    const resolved = ITEM_ALIASES[normalized] ?? normalized;
    const items = bot.inventory.items();

    // Exact match first
    const exact = items.filter((i) => i.name.toLowerCase() === resolved);
    if (exact.length > 0) return exact;

    // Partial match fallback
    return items.filter(
        (i) =>
            i.name.toLowerCase().includes(resolved) ||
            (i.displayName && i.displayName.toLowerCase().includes(rawName.toLowerCase())),
    );
}

export async function equipItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const item = findInventoryItem(bot, itemName);
    if (!item) return `Checked inventory but has no ${itemName}`;

    const slot = getEquipSlot(item.name);
    try {
        setSuppressPickups(bot, true);
        await bot.equip(item.type, slot);
        setTimeout(() => {
            setSuppressPickups(bot, false);
        }, 200);
        const slotLabel = slot === 'hand' ? 'hand' : `${slot} armor slot`;
        return `Equipped ${item.displayName ?? item.name} (${slotLabel})`;
    } catch (err) {
        setTimeout(() => {
            setSuppressPickups(bot, false);
        }, 200);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to equip ${item.name}: ${message}`;
    }
}

export async function eatFood(bot: Bot, foodName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    let foodItem;
    if (foodName) {
        // Eat specific food — resolve aliases + partial match
        foodItem = findInventoryItem(bot, foodName);
        if (!foodItem) return `Checked inventory but has no ${foodName} to eat`;
        // Validate item is actually edible
        if (!(foodItem.name in FOOD_ITEMS)) {
            return `${foodItem.displayName ?? foodItem.name} is not edible food`;
        }
    } else {
        // Find the best food in inventory
        const foodItems = items
            .filter((i) => i.name in FOOD_ITEMS)
            .sort((a, b) => (FOOD_ITEMS[b.name] ?? 0) - (FOOD_ITEMS[a.name] ?? 0));
        foodItem = foodItems[0];
        if (!foodItem) return 'Checked inventory but has nothing to eat';
    }

    try {
        // Stop movement — can't eat while sprinting/pathfinding
        bot.pathfinder.stop();
        bot.setControlState('sprint', false);
        bot.setControlState('forward', false);
        await bot.equip(foodItem.type, 'hand');
        await bot.consume();
        const DEBUFF_FOODS: Record<string, string> = {
            rotten_flesh: 'but got the Hunger debuff (food drains faster for 30s)',
            spider_eye: 'but got Poison (taking damage for 4s)',
            chicken: 'but might get food poisoning (30% chance of Hunger debuff)',
            pufferfish: 'but got severe Nausea, Hunger, and Poison',
        };
        const debuff = DEBUFF_FOODS[foodItem.name];
        if (debuff) {
            return `Ate ${foodItem.displayName ?? foodItem.name} ${debuff}`;
        }
        return `Ate some ${foodItem.displayName ?? foodItem.name} and feels better`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to eat ${foodItem.name}: ${message}`;
    }
}

export async function giveItem(
    bot: Bot,
    itemName: string | undefined,
    playerName: string | undefined,
    countStr: string | undefined,
    names: NameRegistry,
): Promise<string> {
    if (!itemName) return 'No item name provided';
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Check item exists before walking
    const checkItem = findInventoryItem(bot, itemName);
    if (!checkItem) return `Checked inventory but has no ${itemName} to give`;

    const count = countStr ? Math.min(parseInt(countStr, 10), checkItem.count) : checkItem.count;

    // Walk to the player first (use GoalNear so we stop when close)
    try {
        await bot.pathfinder.goto(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2));
    } catch {
        // Best effort approach
    }

    // Re-find item fresh — inventory may have changed during a walk
    const item = findInventoryItem(bot, itemName);
    if (!item) return `Had ${itemName} but it seems to be gone now`;

    const actualCount = Math.min(count, item.count);

    try {
        // Look at the player so items are tossed toward them
        await bot.lookAt(player.position.offset(0, 1, 0));
        // Suppress pickup/break detection — tossing removes items from inventory
        setSuppressPickups(bot, true);
        await bot.toss(item.type, null, actualCount);
        setTimeout(() => setSuppressPickups(bot, false), 600);
        return `Handed ${actualCount} ${item.displayName ?? itemName} over to ${displayName}`;
    } catch (err) {
        setTimeout(() => setSuppressPickups(bot, false), 600);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to give ${itemName}: ${message}`;
    }
}

export async function tossItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const resolved = itemName.toLowerCase().replace(/ /g, '_');

    // Handle "all" — drop the entire inventory
    if (resolved === 'all') {
        const items = bot.inventory.items();
        if (items.length === 0) return 'Inventory is already empty, nothing to drop';

        let totalDropped = 0;
        for (const item of items) {
            await bot.tossStack(item);
            totalDropped += item.count;
        }
        return `Tossed out everything — dropped ${totalDropped} items`;
    }

    // Find matching items in the inventory (alias + partial matching)
    const matching = findAllInventoryItems(bot, itemName);
    if (matching.length === 0) return `Checked inventory but has no ${itemName} to drop`;

    const totalHave = matching.reduce((sum, i) => sum + i.count, 0);
    const toDrop = countStr ? Math.min(parseInt(countStr, 10), totalHave) : totalHave;

    if (isNaN(toDrop) || toDrop <= 0) return `Invalid count: ${countStr}`;

    // Suppress pickup/break detection — tossing removes items from inventory
    setSuppressPickups(bot, true);
    await bot.toss(matching[0].type, null, toDrop);
    setTimeout(() => setSuppressPickups(bot, false), 600);

    const itemDisplayName = matching[0].displayName ?? itemName;
    return `Dropped ${toDrop} ${itemDisplayName} on the ground`;
}

export async function useHeldItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const resolved = itemName.toLowerCase().replace(/ /g, '_');

    // Redirect fishing rod to the proper fishing action (cast + wait + reel in)
    if (resolved === 'fishing_rod') {
        return fishAction(bot, '1');
    }

    // Find the item in inventory
    const item = bot.inventory
        .items()
        .find((i) => i.name === resolved || i.displayName?.toLowerCase() === itemName.toLowerCase());
    if (!item) return `Checked inventory but has no ${itemName}`;

    // Auto-equip if not already held
    if (bot.heldItem?.name !== item.name) {
        try {
            await bot.equip(item, 'hand');
        } catch {
            return `Failed to equip ${item.displayName ?? itemName}`;
        }
    }

    const name = item.displayName ?? item.name;

    // Activate the item (right-click)
    bot.activateItem();
    return `Used the ${name}`;
}
