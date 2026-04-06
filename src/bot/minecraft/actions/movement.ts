import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { findPlayerEntity } from './action-helpers.js';
import { getActionAbort, getHomePosition, clearHome } from './action-state.js';

export async function followPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    // Guard: bot position can be NaN after combat/respawn
    const pos = bot.entity.position;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
        return 'Cannot follow right now — position not available, try again in a moment';
    }

    // Don't follow ourselves — AI sometimes sends the bot's own name.
    // Auto-reroute to the first online human player instead.
    const mcName = names.resolveToMc(playerName);
    if (mcName.toLowerCase() === bot.username.toLowerCase()) {
        const otherPlayer = Object.values(bot.players).find(
            (p) => p.username.toLowerCase() !== bot.username.toLowerCase(),
        );
        if (otherPlayer) {
            playerName = names.resolveToVoxta(otherPlayer.username) || otherPlayer.username;
            console.log(`[MC Action] Bot tried to follow itself, rerouting to ${playerName}`);
        } else {
            return 'No other players nearby to follow';
        }
    }

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) {
        // Check if the player is online but out of render distance
        const mcName = names.resolveToMc(playerName);
        const onlinePlayer = Object.values(bot.players).find(
            (p) => p.username.toLowerCase() === mcName.toLowerCase(),
        );
        if (onlinePlayer) {
            return `${displayName} is too far away to follow — need to be closer first`;
        }
        return `Cannot find player "${displayName}" nearby`;
    }

    // Re-equip previous item BEFORE setting goal (equip can interrupt pathfinder)
    const heldItem = bot.heldItem;
    if (heldItem) {
        try {
            await bot.equip(heldItem.type, 'hand');
        } catch {
            // Best effort — item might have been consumed
        }
    }

    // Flush any pending pathfinder stop — pathfinder.stop() sets an internal
    // "stopPathing" flag. If we call setGoal() while that flag is true, resetPath()
    // sees it and immediately nullifies our new goal. Setting null first clears it.
    bot.pathfinder.setGoal(null);

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true); // dynamic = true → keeps following
    console.log(`[MC Action] Follow goal set for ${displayName}, goal active: ${!!bot.pathfinder.goal}`);

    return `Following ${displayName}`;
}

/**
 * Resume following a player after auto-defense WITHOUT going through executeAction.
 * executeAction's physical action handling (actionAbort.abort(), actionBusy) interferes
 * with the pathfinder after combat. This function directly sets the goal.
 */
export function resumeFollowPlayer(bot: Bot, playerName: string, names: NameRegistry, retryCount = 0): string {
    // Guard: bot position can be NaN after combat/respawn — pathfinder can't
    // compute a path from NaN coordinates. Schedule a retry instead.
    // The NaN recovery in bot.ts will fix the position on the next physics tick.
    const pos = bot.entity.position;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
        if (retryCount >= 5) {
            console.log(`[MC Action] Bot position still NaN after ${retryCount} retries, giving up`);
            return 'Cannot resume following — position unavailable';
        }
        console.log(`[MC Action] Bot position is NaN, retrying follow in 500ms (attempt ${retryCount + 1})`);
        setTimeout(() => resumeFollowPlayer(bot, playerName, names, retryCount + 1), 500);
        return `Waiting for valid position to resume following`;
    }

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Flush pending a stop flag (see comment in followPlayer above)
    bot.pathfinder.setGoal(null);

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true);
    console.log(`[MC Action] Resume follow goal set for ${displayName}, goal active: ${!!bot.pathfinder.goal}`);

    return `Following ${displayName}`;
}

export async function goTo(
    bot: Bot,
    xStr: string | undefined,
    yStr: string | undefined,
    zStr: string | undefined,
): Promise<string> {
    if (!xStr || !yStr || !zStr) return 'Missing coordinates';

    const x = parseFloat(xStr);
    const y = parseFloat(yStr);
    const z = parseFloat(zStr);

    if (isNaN(x) || isNaN(y) || isNaN(z)) return 'Invalid coordinates';

    // Reject obviously hallucinated coordinates (AI sends 0,0,0 when unsure)
    if (x === 0 && y === 0 && z === 0) {
        return 'Cannot go to 0,0,0 — no valid destination. Try mc_follow_player instead.';
    }

    // Reject unreasonably far destinations (>1000 blocks away)
    const dist = bot.entity.position.distanceTo(bot.entity.position.offset(x - bot.entity.position.x, y - bot.entity.position.y, z - bot.entity.position.z));
    if (dist > 1000) {
        return `Destination is ${Math.round(dist)} blocks away — too far to navigate safely.`;
    }

    const goal = new goals.GoalBlock(x, y, z);
    await bot.pathfinder.goto(goal);
    return `Made it to the destination`;
}

export async function goHome(bot: Bot): Promise<string> {
    const homePosition = getHomePosition();
    if (!homePosition) return 'No home bed set yet. I need to sleep in a bed first to remember where home is.';

    // Verify the bed still exists (world may have changed)
    const { Vec3 } = require('vec3');
    const block = bot.blockAt(new Vec3(homePosition.x, homePosition.y, homePosition.z));
    if (!block || !block.name.includes('bed')) {
        console.log(`[MC Action] Saved home at ${homePosition.x}, ${homePosition.y}, ${homePosition.z} is no longer a bed (found: ${block?.name ?? 'unloaded'}). Clearing stale home.`);
        clearHome();
        return 'No home bed set yet. The previously saved bed no longer exists — I need to sleep in a new bed first.';
    }

    const dx = bot.entity.position.x - homePosition.x;
    const dy = bot.entity.position.y - homePosition.y;
    const dz = bot.entity.position.z - homePosition.z;
    const distance = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
    console.log(
        `[MC Action] Going home to bed at ${homePosition.x}, ${homePosition.y}, ${homePosition.z} (${distance} blocks away)`,
    );

    const goal = new goals.GoalNear(homePosition.x, homePosition.y, homePosition.z, 2);
    await bot.pathfinder.goto(goal);
    return `Made it back home safely near my bed`;
}

export async function collectItems(bot: Bot): Promise<string> {
    const items = Object.values(bot.entities).filter(
        (e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 32,
    );

    if (items.length === 0) return 'Looked around but there are no dropped items nearby';

    const signal = getActionAbort().signal;
    let collected = 0;
    for (const item of items.slice(0, 5)) {
        if (signal.aborted) break;
        try {
            await bot.pathfinder.goto(
                new goals.GoalBlock(
                    Math.floor(item.position.x),
                    Math.floor(item.position.y),
                    Math.floor(item.position.z),
                ),
            );
            collected++;
        } catch {
            // Item may have despawned
        }
    }

    return `Picked up ${collected} dropped item${collected !== 1 ? 's' : ''} from the ground`;
}

export async function goToEntity(bot: Bot, entityName: string | undefined): Promise<string> {
    if (!entityName) return 'No entity name provided';

    const nameLower = entityName.toLowerCase().replace(/_/g, ' ');

    // Find the nearest entity matching the name
    let nearest: { entity: typeof bot.entity; dist: number } | null = null;
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        if (entity.type === 'orb' || entity.type === 'projectile' || entity.type === 'object') continue;

        const eName = (entity.displayName ?? entity.name ?? '').toLowerCase().replace(/_/g, ' ');
        if (!eName.includes(nameLower) && !nameLower.includes(eName)) continue;

        const dist = entity.position.distanceTo(bot.entity.position);
        if (!nearest || dist < nearest.dist) {
            nearest = { entity, dist };
        }
    }

    if (!nearest) return `Cannot find any ${entityName} nearby`;

    const displayName = nearest.entity.displayName ?? nearest.entity.name ?? entityName;
    console.log(
        `[MC Action] Going to ${displayName} at ${Math.round(nearest.entity.position.x)},${Math.round(nearest.entity.position.y)},${Math.round(nearest.entity.position.z)} (${Math.round(nearest.dist)} blocks away)`,
    );

    // Use GoalFollow to dynamically track the entity as it moves
    const target = nearest.entity;
    const goal = new goals.GoalFollow(target, 2);
    bot.pathfinder.setGoal(goal, true);

    // Wait until we're close enough, then stop following
    await new Promise<void>((resolve) => {
        const check = setInterval(() => {
            // Entity despawned or we lost tracking
            if (!bot.entities[target.id]) {
                clearInterval(check);
                bot.pathfinder.stop();
                resolve();
                return;
            }
            const dist = target.position.distanceTo(bot.entity.position);
            if (dist < 3) {
                clearInterval(check);
                bot.pathfinder.stop();
                resolve();
            }
        }, 250);
        // Timeout after 30s to avoid getting stuck
        setTimeout(() => {
            clearInterval(check);
            bot.pathfinder.stop();
            resolve();
        }, 30000);
    });

    return `Reached the ${displayName}`;
}
