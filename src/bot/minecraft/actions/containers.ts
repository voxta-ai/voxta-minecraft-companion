import type { Bot } from 'mineflayer';
import { findAndReachBlock } from './action-helpers.js';

/** Find a nearby chest/barrel and walk to it. Returns the block or an error message. */
function findAndReachChest(bot: Bot) {
    return findAndReachBlock(
        bot,
        (block) => block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel',
        'Looked around but there is no chest or container nearby',
        'Cannot reach the chest',
    );
}

export async function storeItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const result = await findAndReachChest(bot);
    if ('error' in result) return result.error;
    const chestBlock = result.block;

    try {
        const container = await bot.openContainer(chestBlock);
        let stored = 0;

        if (itemName.toLowerCase() === 'all') {
            // Store everything in inventory
            const items = bot.inventory.items();
            for (const item of items) {
                try {
                    await container.deposit(item.type, null, item.count);
                    stored += item.count;
                } catch {
                    // Chest might be full
                    break;
                }
            }
            container.close();
            if (stored === 0) return 'Opened the chest but could not store anything — it may be full';
            return `Stored ${stored} items into the chest`;
        } else {
            // Store specific item
            const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
            if (!item) {
                container.close();
                return `Checked inventory but has no ${itemName}`;
            }
            const count = countStr ? Math.min(parseInt(countStr, 10), item.count) : item.count;
            await container.deposit(item.type, null, count);
            container.close();
            return `Put ${count} ${item.name.replace(/_/g, ' ')} into the chest`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to store items: ${message}`;
    }
}

export async function takeItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const result = await findAndReachChest(bot);
    if ('error' in result) return result.error;
    const chestBlock = result.block;

    try {
        const container = await bot.openContainer(chestBlock);

        // Find the item in the chest's slots
        const chestItems = container.containerItems();
        const item = chestItems.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
        if (!item) {
            container.close();
            return `Looked through the chest but couldn't find any ${itemName} inside`;
        }

        const count = countStr ? Math.min(parseInt(countStr, 10), item.count) : item.count;
        await container.withdraw(item.type, null, count);
        container.close();
        return `Took ${count} ${item.name.replace(/_/g, ' ')} from the chest`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to take items: ${message}`;
    }
}

export async function inspectContainer(bot: Bot, target: string | undefined): Promise<string> {
    if (!target) return 'No target specified. Use "chest", "furnace", "barrel", or "inventory"';

    const t = target.toLowerCase();

    // Inspect own inventory
    if (t === 'inventory' || t === 'self' || t === 'me') {
        const items = bot.inventory.items();
        if (items.length === 0) return 'Checked inventory — it is empty';
        const list = items.map((i) => `${i.count}x ${(i.displayName ?? i.name).replace(/_/g, ' ')}`).join(', ');
        return `Checked inventory and has: ${list}`;
    }

    // Determine which block type to look for
    const blockMatchers: Record<string, (name: string) => boolean> = {
        chest: (name) => name === 'chest' || name === 'trapped_chest',
        furnace: (name) => name === 'furnace' || name === 'smoker' || name === 'blast_furnace',
        barrel: (name) => name === 'barrel',
        crafting_table: (name) => name === 'crafting_table',
    };

    const matcher = blockMatchers[t];
    if (!matcher) {
        // Try to match any container
        const allMatcher = (name: string): boolean =>
            name === 'chest' ||
            name === 'trapped_chest' ||
            name === 'barrel' ||
            name === 'furnace' ||
            name === 'smoker' ||
            name === 'blast_furnace' ||
            name === 'crafting_table';
        return await doInspect(bot, allMatcher, target);
    }

    // Crafting table is not a container — just confirm it exists
    if (t === 'crafting_table') {
        const block = bot.findBlock({
            matching: (b) => b.name === 'crafting_table',
            maxDistance: 32,
        });
        if (!block) return 'Looked around but there is no crafting table nearby';
        const dist = Math.round(block.position.distanceTo(bot.entity.position));
        return `Crafting table found ${dist} blocks away (crafting tables don't store items)`;
    }

    return await doInspect(bot, matcher, t);
}

async function doInspect(bot: Bot, matcher: (name: string) => boolean, label: string): Promise<string> {
    const result = await findAndReachBlock(
        bot,
        (b) => matcher(b.name),
        `Looked around but there is no ${label} nearby`,
        `Cannot reach the ${label}`,
    );
    if ('error' in result) return result.error;
    const block = result.block;

    // Furnace has special slots
    if (block.name === 'furnace' || block.name === 'smoker' || block.name === 'blast_furnace') {
        try {
            const furnace = await bot.openFurnace(block);
            const parts: string[] = [];
            const input = furnace.inputItem();
            const fuel = furnace.fuelItem();
            const output = furnace.outputItem();
            if (input) parts.push(`Input: ${input.count}x ${input.name.replace(/_/g, ' ')}`);
            if (fuel) parts.push(`Fuel: ${fuel.count}x ${fuel.name.replace(/_/g, ' ')}`);
            if (output) parts.push(`Output: ${output.count}x ${output.name.replace(/_/g, ' ')}`);
            furnace.close();
            if (parts.length === 0) return `Opened the ${block.name.replace(/_/g, ' ')} — it is empty`;
            return `Opened the ${block.name.replace(/_/g, ' ')} and found: ${parts.join(', ')}`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to inspect ${label}: ${message}`;
        }
    }

    // Regular container (chest, barrel)
    try {
        const container = await bot.openContainer(block);
        const items = container.containerItems();
        container.close();
        if (items.length === 0) return `Opened the ${label} — it is empty`;
        const list = items.map((i) => `${i.count}x ${(i.displayName ?? i.name).replace(/_/g, ' ')}`).join(', ');
        return `Opened a ${label} and found: ${list}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to inspect ${label}: ${message}`;
    }
}
