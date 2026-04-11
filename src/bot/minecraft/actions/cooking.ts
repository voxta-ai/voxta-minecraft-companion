import type { Bot } from 'mineflayer';
import { COOKABLE_ITEMS, FUEL_ITEMS } from '../game-data';
import { findAndReachBlock } from './action-helpers.js';

export async function cookFood(bot: Bot, itemName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    // Find cookable item
    let rawItem;
    if (itemName) {
        const normalized = itemName.toLowerCase().replace(/ /g, '_');
        // Strip "raw_" prefix — Minecraft names are just "porkchop", "beef", etc.
        const stripped = normalized.replace(/^raw_/, '');
        rawItem = items.find((i) => i.name in COOKABLE_ITEMS && (
            i.name === normalized ||
            i.name === stripped ||
            i.name.includes(normalized) ||
            i.name.includes(stripped) ||
            normalized.includes(i.name)
        ));
        if (!rawItem) return `Checked inventory but has no cookable ${itemName}`;
    } else {
        rawItem = items.find((i) => i.name in COOKABLE_ITEMS);
        if (!rawItem) return 'Checked inventory but has nothing that can be cooked';
    }

    // Find fuel
    const fuelItem = items.find((i) => FUEL_ITEMS.includes(i.name));
    if (!fuelItem) return 'Cannot cook without fuel — need coal, wood, or planks';

    // Find and walk to a nearby furnace
    const result = await findAndReachBlock(
        bot,
        (block) => block.name === 'furnace' || block.name === 'smoker' || block.name === 'blast_furnace',
        'Looked around but there is no furnace nearby',
        'Cannot reach the furnace from here',
    );
    if ('error' in result) return result.error;
    const furnaceBlock = result.block;

    // Open furnace and cook
    try {
        // Unequip held item so it moves back into inventory slots
        // (furnace putFuel/putInput only search slots 3-39, not the hand)
        try {
            await bot.unequip('hand');
        } catch {
            /* nothing equipped */
        }

        const furnace = await bot.openFurnace(furnaceBlock);
        const cookCount = Math.min(rawItem.count, 8); // Cook up to 8 at a time

        // Take any existing output first
        if (furnace.outputItem()) {
            await furnace.takeOutput();
        }

        // Only add fuel if the fuel slot is empty
        if (!furnace.fuelItem()) {
            await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, cookCount));
        }
        // Put raw food in
        await furnace.putInput(rawItem.type, null, cookCount);

        console.log(`[MC Action] Cooking ${cookCount} ${rawItem.name}...`);

        // Wait for cooking (10 seconds per item in furnace, 5 in smoker)
        const isSmoker = furnaceBlock.name === 'smoker';
        const cookTimeMs = (isSmoker ? 5000 : 10000) * cookCount;
        await new Promise((resolve) => setTimeout(resolve, cookTimeMs + 2000));

        // Take all output — keep grabbing until empty
        let totalTaken = 0;
        for (let i = 0; i < cookCount + 1; i++) {
            const output = furnace.outputItem();
            if (!output) break;
            await furnace.takeOutput();
            totalTaken += output.count;
            // Brief pause between takes
            await new Promise((r) => setTimeout(r, 200));
        }

        furnace.close();

        const cookedName = COOKABLE_ITEMS[rawItem.name] ?? 'cooked food';
        if (totalTaken === 0) return `Put ${cookCount} ${rawItem.name.replace(/_/g, ' ')} in the furnace but it is still cooking`;
        return `Cooked up ${totalTaken} ${cookedName.replace(/_/g, ' ')}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to cook: ${message}`;
    }
}
