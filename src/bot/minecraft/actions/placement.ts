import type { Bot } from 'mineflayer';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { setSuppressPickups } from './action-state.js';

export async function placeBlock(bot: Bot, blockName: string | undefined): Promise<string> {
    if (!blockName) return 'No block name provided';

    const resolved = blockName.toLowerCase().replace(/ /g, '_');

    // Find the block in inventory
    const item = bot.inventory.items().find(
        (i) => i.name.toLowerCase().includes(resolved),
    );
    // Also check held item
    const heldItem = bot.heldItem;
    const isHeld = heldItem && heldItem.name.toLowerCase().includes(resolved);

    if (!item && !isHeld) return `No ${blockName} found in inventory`;

    const displayName = item?.displayName ?? heldItem?.displayName ?? blockName;

    // Save currently held item to re-equip after
    const previousHeld = (!isHeld && heldItem) ? heldItem.name : null;

    // Equip the block if not already held
    setSuppressPickups(true);
    if (!isHeld && item) {
        await bot.equip(item, 'hand');
    }

    // Find a reference block to place against (block at bot's feet level)
    const pos = bot.entity.position;
    const refBlock = bot.blockAt(pos.offset(0, -1, 0));
    if (!refBlock || refBlock.name === 'air' || refBlock.name === 'cave_air') {
        setSuppressPickups(false);
        return `Cannot place ${displayName}: no solid ground nearby`;
    }

    // Try to place the block on top of the reference block
    try {
        const faceVector = new (require('vec3').Vec3)(0, 1, 0); // top face
        await bot.placeBlock(refBlock, faceVector);
        // Re-equip previous item
        if (previousHeld) {
            const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
            if (reequip) await bot.equip(reequip, 'hand');
        }
        setTimeout(() => { setSuppressPickups(false); }, 200);
        return `Placed ${displayName}`;
    } catch (err) {
        // If placing at feet fails, try in front of the bot
        try {
            const yaw = bot.entity.yaw;
            const dx = -Math.sin(yaw);
            const dz = -Math.cos(yaw);
            const frontRef = bot.blockAt(pos.offset(Math.round(dx), -1, Math.round(dz)));
            if (frontRef && frontRef.name !== 'air') {
                const faceVector = new (require('vec3').Vec3)(0, 1, 0);
                await bot.placeBlock(frontRef, faceVector);
                if (previousHeld) {
                    const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
                    if (reequip) await bot.equip(reequip, 'hand');
                }
                setTimeout(() => { setSuppressPickups(false); }, 200);
                return `Placed ${displayName}`;
            }
        } catch { /* fallback failed */ }
        setTimeout(() => { setSuppressPickups(false); }, 200);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to place ${displayName}: ${message}`;
    }
}
