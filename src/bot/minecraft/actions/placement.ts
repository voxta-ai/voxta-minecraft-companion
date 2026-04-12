import type { Bot } from 'mineflayer';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { setSuppressPickups } from './action-state.js';
import { getErrorMessage } from '../utils';

/**
 * Place a block from inventory onto the ground.
 * Strategy: try in front of the bot first (where the hitbox won't collide),
 * then try adjacent positions if the first attempt fails.
 */
export async function placeBlock(bot: Bot, blockName: string | undefined): Promise<string> {
    if (!blockName) return 'No block name provided';

    const resolved = blockName.toLowerCase().replace(/ /g, '_');

    // Find the block in inventory
    const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(resolved));
    const heldItem = bot.heldItem;
    const isHeld = heldItem && heldItem.name.toLowerCase().includes(resolved);

    if (!item && !isHeld) return `Checked inventory but has no ${blockName} to place`;

    const displayName = item?.displayName ?? heldItem?.displayName ?? blockName;

    // Save currently held item to re-equip after
    const previousHeld = !isHeld && heldItem ? heldItem.name : null;

    setSuppressPickups(bot, true);
    if (!isHeld && item) {
        await bot.equip(item, 'hand');
    }

    const Vec3 = require('vec3').Vec3;
    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const topFace = new Vec3(0, 1, 0);

    // Build candidate positions: in front, left, right, behind — then at feet
    const offsets = [
        { dx: -Math.sin(yaw), dz: -Math.cos(yaw), label: 'in front' },
        { dx: -Math.sin(yaw + Math.PI / 2), dz: -Math.cos(yaw + Math.PI / 2), label: 'to the left' },
        { dx: -Math.sin(yaw - Math.PI / 2), dz: -Math.cos(yaw - Math.PI / 2), label: 'to the right' },
        { dx: Math.sin(yaw), dz: Math.cos(yaw), label: 'behind' },
    ];

    for (const { dx, dz, label } of offsets) {
        const refPos = pos.offset(Math.round(dx), -1, Math.round(dz));
        const refBlock = bot.blockAt(refPos);
        if (!refBlock || refBlock.name === 'air' || refBlock.name === 'cave_air') {
            continue;
        }

        // Check that the placement target (block above ref) is actually air
        const targetPos = refPos.offset(0, 1, 0);
        const targetBlock = bot.blockAt(targetPos);
        if (targetBlock && targetBlock.name !== 'air' && targetBlock.name !== 'cave_air') {
            continue; // Already occupied
        }

        try {
            await bot.placeBlock(refBlock, topFace);

            // Verify the block was actually placed
            const placed = bot.blockAt(targetPos);
            if (!placed || placed.name === 'air' || placed.name === 'cave_air') {
                console.log(`[MC Action] placeBlock: server rejected placement ${label} (block still air)`);
                continue; // Silently failed — try next position
            }

            console.log(`[MC Action] placeBlock: placed ${displayName} ${label}`);

            if (previousHeld) {
                const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
                if (reequip) await bot.equip(reequip, 'hand');
            }
            setTimeout(() => setSuppressPickups(bot, false), 200);
            return `Placed down ${displayName}`;
        } catch (err) {
            const msg = getErrorMessage(err);
            console.log(`[MC Action] placeBlock: failed ${label}: ${msg}`);
        }
    }

    setTimeout(() => setSuppressPickups(bot, false), 200);
    return `Failed to place ${displayName} — could not find a valid spot nearby`;
}
