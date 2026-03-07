import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { COOKABLE_ITEMS, FUEL_ITEMS } from '../game-data';

export async function cookFood(bot: Bot, itemName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    // Find cookable item
    let rawItem;
    if (itemName) {
        rawItem = items.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()) && i.name in COOKABLE_ITEMS);
        if (!rawItem) {
            // Maybe they gave us the exact name
            rawItem = items.find((i) => i.name in COOKABLE_ITEMS && i.name.includes(itemName.toLowerCase()));
        }
        if (!rawItem) return `No cookable ${itemName} in inventory`;
    } else {
        rawItem = items.find((i) => i.name in COOKABLE_ITEMS);
        if (!rawItem) return 'No raw food to cook in inventory';
    }

    // Find fuel
    const fuelItem = items.find((i) => FUEL_ITEMS.includes(i.name));
    if (!fuelItem) return 'No fuel in inventory (need coal, wood, or planks)';

    // Find nearby furnace
    const furnaceBlock = bot.findBlock({
        matching: (block) => block.name === 'furnace' || block.name === 'smoker' || block.name === 'blast_furnace',
        maxDistance: 32,
    });
    if (!furnaceBlock) return 'No furnace found nearby';

    // Walk to furnace
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the furnace';
    }

    // Open furnace and cook
    try {
        // Unequip held item so it moves back into inventory slots
        // (furnace putFuel/putInput only search slots 3-39, not the hand)
        try { await bot.unequip('hand'); } catch { /* nothing equipped */ }

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
        if (totalTaken === 0) return `Put ${cookCount} ${rawItem.name} in furnace but nothing cooked yet`;
        return `Cooked ${totalTaken} ${cookedName.replace(/_/g, ' ')}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to cook: ${message}`;
    }
}
