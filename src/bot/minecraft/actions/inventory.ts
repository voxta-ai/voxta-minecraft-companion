import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { FOOD_ITEMS } from '../game-data';
import { findPlayerEntity, getEquipSlot } from './action-helpers.js';
import { setSuppressPickups } from './action-state.js';
import { fishAction } from './fishing.js';

export async function equipItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
    if (!item) return `No ${itemName} found in inventory`;

    const slot = getEquipSlot(item.name);
    try {
        setSuppressPickups(true);
        await bot.equip(item.type, slot);
        setTimeout(() => {
            setSuppressPickups(false);
        }, 200);
        const slotLabel = slot === 'hand' ? 'hand' : `${slot} armor slot`;
        return `Equipped ${item.displayName ?? item.name} in ${slotLabel}`;
    } catch (err) {
        setTimeout(() => {
            setSuppressPickups(false);
        }, 200);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to equip ${item.name}: ${message}`;
    }
}

export async function eatFood(bot: Bot, foodName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    let foodItem;
    if (foodName) {
        // Eat specific food — match against both internal name and display name
        const normalized = foodName.toLowerCase().replace(/\s+/g, '_');
        foodItem = items.find(
            (i) =>
                i.name.toLowerCase() === normalized ||
                (i.displayName && i.displayName.toLowerCase() === foodName.toLowerCase()),
        );
        if (!foodItem) return `No ${foodName} in inventory`;
    } else {
        // Find the best food in inventory
        const foodItems = items
            .filter((i) => i.name in FOOD_ITEMS)
            .sort((a, b) => (FOOD_ITEMS[b.name] ?? 0) - (FOOD_ITEMS[a.name] ?? 0));
        foodItem = foodItems[0];
        if (!foodItem) return 'No food in inventory';
    }

    try {
        await bot.equip(foodItem.type, 'hand');
        await bot.consume();
        return `Ate ${foodItem.displayName ?? foodItem.name} (hunger restored)`;
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
    const checkItem = bot.inventory.items().find((i) => i.name === itemName);
    if (!checkItem) return `No ${itemName} in inventory`;

    const count = countStr ? Math.min(parseInt(countStr, 10), checkItem.count) : checkItem.count;

    // Walk to the player first (use GoalNear so we stop when close)
    try {
        await bot.pathfinder.goto(new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2));
    } catch {
        // Best effort approach
    }

    // Re-find item fresh — inventory may have changed during a walk
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return `No ${itemName} in inventory (lost while walking)`;

    const actualCount = Math.min(count, item.count);

    try {
        // Look at the player so items are tossed toward them
        await bot.lookAt(player.position.offset(0, 1, 0));
        await bot.toss(item.type, null, actualCount);
        return `Gave ${actualCount} ${itemName} to ${displayName}`;
    } catch (err) {
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
        if (items.length === 0) return 'Inventory is already empty';

        let totalDropped = 0;
        for (const item of items) {
            await bot.tossStack(item);
            totalDropped += item.count;
        }
        return `Dropped ${totalDropped} items (entire inventory)`;
    }

    // Find matching items in the inventory
    const matching = bot.inventory.items().filter((i) => i.name === resolved);
    if (matching.length === 0) return `No ${itemName} in inventory`;

    const totalHave = matching.reduce((sum, i) => sum + i.count, 0);
    const toDrop = countStr ? Math.min(parseInt(countStr, 10), totalHave) : totalHave;

    if (isNaN(toDrop) || toDrop <= 0) return `Invalid count: ${countStr}`;

    // Use bot.toss() which accepts itemType, metadata, count
    await bot.toss(matching[0].type, null, toDrop);

    const displayName = matching[0].displayName ?? itemName;
    return `Dropped ${toDrop} ${displayName}`;
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
    if (!item) return `No ${itemName} in inventory`;

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
    return `Used ${name}`;
}
