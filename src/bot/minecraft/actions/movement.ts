import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { findPlayerEntity } from './action-helpers.js';
import { getActionAbort, getHomePosition } from './action-state.js';

export async function followPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

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
export function resumeFollowPlayer(bot: Bot, playerName: string, names: NameRegistry): string {
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

    const goal = new goals.GoalBlock(x, y, z);
    await bot.pathfinder.goto(goal);
    return `Arrived at ${x}, ${y}, ${z}`;
}

export async function goHome(bot: Bot): Promise<string> {
    const homePosition = getHomePosition();
    if (!homePosition) return 'No home bed set yet. I need to sleep in a bed first to remember where home is.';

    const dx = bot.entity.position.x - homePosition.x;
    const dy = bot.entity.position.y - homePosition.y;
    const dz = bot.entity.position.z - homePosition.z;
    const distance = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
    console.log(`[MC Action] Going home to bed at ${homePosition.x}, ${homePosition.y}, ${homePosition.z} (${distance} blocks away)`);

    const goal = new goals.GoalNear(homePosition.x, homePosition.y, homePosition.z, 2);
    await bot.pathfinder.goto(goal);
    return `Arrived home at ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`;
}

export async function collectItems(bot: Bot): Promise<string> {
    const items = Object.values(bot.entities).filter(
        (e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 32
    );

    if (items.length === 0) return 'No dropped items nearby';

    const signal = getActionAbort().signal;
    let collected = 0;
    for (const item of items.slice(0, 5)) {
        if (signal.aborted) break;
        try {
            await bot.pathfinder.goto(new goals.GoalBlock(
                Math.floor(item.position.x),
                Math.floor(item.position.y),
                Math.floor(item.position.z),
            ));
            collected++;
        } catch {
            // Item may have despawned
        }
    }

    return `Collected ${collected} dropped item${collected !== 1 ? 's' : ''}`;
}
