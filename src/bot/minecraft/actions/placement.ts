import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { setSuppressPickups } from './action-state.js';
import { findNearestPlayer, raycastFromPlayer } from './action-helpers.js';
import { getErrorMessage } from '../utils';

const TORCH_NAMES = ['torch', 'soul_torch'];
const MAX_TORCH_RANGE = 20;

/** Check if a block name is a torch type */
function isTorch(name: string): boolean {
    return TORCH_NAMES.some((t) => name.includes(t));
}

/**
 * Place a torch where the nearest player is looking.
 * Returns a result message, or null to fall back to default placement.
 */
async function placeTorchAtCrosshair(bot: Bot, displayName: string): Promise<string | null> {
    const Vec3 = require('vec3').Vec3;
    const player = findNearestPlayer(bot);
    if (!player) {
        console.log('[MC Action] placeTorch: no nearby player found, falling back to default placement');
        return null;
    }

    const yaw = player.yaw ?? 0;
    const pitch = player.pitch ?? 0;
    console.log(`[MC Action] placeTorch: player "${player.username}" at (${player.position.x.toFixed(2)}, ${player.position.y.toFixed(2)}, ${player.position.z.toFixed(2)}) yaw=${yaw.toFixed(3)} pitch=${pitch.toFixed(3)}`);
    console.log(`[MC Action] placeTorch: ray dir = (${(-Math.sin(yaw) * Math.cos(pitch)).toFixed(3)}, ${Math.sin(pitch).toFixed(3)}, ${(-Math.cos(yaw) * Math.cos(pitch)).toFixed(3)})`);

    const hit = raycastFromPlayer(bot, player, MAX_TORCH_RANGE);
    if (!hit) {
        console.log('[MC Action] placeTorch: player not looking at any block within range, falling back to default');
        return null;
    }

    console.log(`[MC Action] placeTorch: hit block "${hit.block.name}" at (${hit.block.position.x}, ${hit.block.position.y}, ${hit.block.position.z}) face=(${hit.face.x}, ${hit.face.y}, ${hit.face.z})`);

    // Torches can't be placed on the bottom face (ceiling) — fall back to default
    if (hit.face.y === -1) {
        console.log('[MC Action] placeTorch: cannot place on ceiling, falling back to default');
        return null;
    }

    // Too far from player — fall back to default placement near bot
    const distFromPlayer = player.position.distanceTo(hit.block.position);
    if (distFromPlayer > MAX_TORCH_RANGE) {
        console.log(`[MC Action] placeTorch: target too far (${distFromPlayer.toFixed(1)} blocks), falling back to default`);
        return null;
    }

    // The position where the torch will appear (adjacent to the hit face)
    const targetPos = hit.block.position.offset(hit.face.x, hit.face.y, hit.face.z);
    console.log(`[MC Action] placeTorch: torch will go at (${targetPos.x}, ${targetPos.y}, ${targetPos.z}), dist from player=${distFromPlayer.toFixed(1)}`);
    const targetBlock = bot.blockAt(targetPos);
    if (targetBlock && targetBlock.name !== 'air' && targetBlock.name !== 'cave_air') {
        console.log(`[MC Action] placeTorch: target position occupied by ${targetBlock.name}, falling back to default`);
        return null;
    }

    // Navigate the bot close enough to place (within 4 blocks)
    const botDist = bot.entity.position.distanceTo(hit.block.position);
    if (botDist > 4) {
        try {
            await bot.pathfinder.goto(
                new goals.GoalNear(hit.block.position.x, hit.block.position.y, hit.block.position.z, 3),
            );
        } catch {
            return `Cannot reach the spot to place ${displayName}`;
        }
    }

    const faceVec = new Vec3(hit.face.x, hit.face.y, hit.face.z);
    try {
        await bot.placeBlock(hit.block, faceVec);

        // Verify placement
        const placed = bot.blockAt(targetPos);
        if (!placed || placed.name === 'air' || placed.name === 'cave_air') {
            console.log('[MC Action] placeTorch: server rejected placement');
            return `Failed to place ${displayName} — server rejected placement`;
        }

        console.log(`[MC Action] placeTorch: placed ${displayName} where player is looking`);
        return `Placed ${displayName} where you're looking`;
    } catch (err) {
        const msg = getErrorMessage(err);
        console.log(`[MC Action] placeTorch: failed: ${msg}`);
        return `Failed to place ${displayName}: ${msg}`;
    }
}

/**
 * Place a block from inventory onto the ground.
 * For torches: raytraces from the nearest player's crosshair and places there.
 * For other blocks: tries in front of the bot first, then adjacent positions.
 */
export async function placeBlock(bot: Bot, blockName: string | undefined): Promise<string> {
    if (!blockName) return 'No block name provided';

    const resolved = blockName.toLowerCase().replace(/ /g, '_');

    // Find the block in inventory (main slots + held item + off-hand)
    const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(resolved));
    const heldItem = bot.heldItem;
    const isHeld = heldItem && heldItem.name.toLowerCase().includes(resolved);
    const offHandItem = bot.inventory.slots[45];
    const isOffHand = offHandItem && offHandItem.name.toLowerCase().includes(resolved);

    if (!item && !isHeld && !isOffHand) return `Checked inventory but has no ${blockName} to place`;

    // Use the display name of the item we're actually going to place
    const sourceItem = item ?? (isHeld ? heldItem : null) ?? (isOffHand ? offHandItem : null);
    const displayName = sourceItem?.displayName ?? blockName;

    // Save currently held item to re-equip after
    const previousHeld = !isHeld && heldItem ? heldItem.name : null;

    setSuppressPickups(bot, true);
    if (!isHeld) {
        // Prefer main inventory, fall back to off-hand item
        const toEquip = item ?? offHandItem;
        if (toEquip) await bot.equip(toEquip, 'hand');
    }

    // Torch: place where the player is looking
    if (isTorch(resolved)) {
        const torchResult = await placeTorchAtCrosshair(bot, displayName);
        if (torchResult !== null) {
            if (previousHeld) {
                const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
                if (reequip) await bot.equip(reequip, 'hand');
            }
            setTimeout(() => setSuppressPickups(bot, false), 200);
            return torchResult;
        }
        // Fall through to default placement if crosshair targeting failed
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
