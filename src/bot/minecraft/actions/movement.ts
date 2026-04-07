import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
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

    // When the player is mounted, their entity position goes stale.
    // Follow the vehicle entity instead — it gets real position updates.
    const playerVehicle = (player as unknown as { vehicle: Entity | null }).vehicle;
    const followTarget = playerVehicle ?? player;
    const goal = new goals.GoalFollow(followTarget, 3);
    bot.pathfinder.setGoal(goal, true); // dynamic = true → keeps following
    console.log(`[MC Action] Follow goal set for ${displayName}${playerVehicle ? ' (via vehicle)' : ''}, goal active: ${!!bot.pathfinder.goal}`);

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

    const playerVehicle = (player as unknown as { vehicle: Entity | null }).vehicle;
    const followTarget = playerVehicle ?? player;
    const goal = new goals.GoalFollow(followTarget, 3);
    bot.pathfinder.setGoal(goal, true);
    console.log(`[MC Action] Resume follow goal set for ${displayName}${playerVehicle ? ' (via vehicle)' : ''}, goal active: ${!!bot.pathfinder.goal}`);

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

    // If it's a villager or trader, try to read their trades
    const traderType = (nearest.entity.name ?? '').toLowerCase();
    const TRADER_TYPES = ['villager', 'wandering_trader'];
    if (TRADER_TYPES.includes(traderType) && bot.entities[target.id]) {
        try {
            // openVillager asserts entityType === villager, which fails for
            // wandering_trader. Temporarily spoof the entityType so the assert
            // passes — openVillager handles trade_list packet registration
            // that openEntity alone does NOT do.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const registry = (bot as any).registry;
            const villagerTypeId = registry.entitiesByName.villager?.id ?? registry.entitiesByName.Villager?.id;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const entityObj = nearest.entity as any;
            const originalType = entityObj.entityType;
            entityObj.entityType = villagerTypeId;

            let villager;
            try {
                villager = await bot.openVillager(nearest.entity);
            } finally {
                entityObj.entityType = originalType;
            }

            const trades = villager.trades ?? [];
            bot.closeWindow(villager);

            if (trades.length > 0) {
                const tradeList = trades.map((t, i) => {
                    const input1 = `${String(t.inputItem1.count)}x ${t.inputItem1.name.replace(/_/g, ' ')}`;
                    const input2 = t.inputItem2 && t.inputItem2.type
                        ? ` + ${String(t.inputItem2.count)}x ${t.inputItem2.name.replace(/_/g, ' ')}`
                        : '';
                    const output = `${String(t.outputItem.count)}x ${t.outputItem.name.replace(/_/g, ' ')}`;
                    const stock = t.nbTradeUses < t.maximumNbTradeUses ? '' : ' (SOLD OUT)';
                    return `  ${i + 1}. ${input1}${input2} -> ${output}${stock}`;
                }).join('\n');
                console.log(`[MC Action] ${displayName} trades:\n${tradeList}`);
                return `Reached the ${displayName}. Their trades:\n${tradeList}`;
            }
            return `Reached the ${displayName} but they have no trades available`;
        } catch (err) {
            console.log(`[MC Action] Could not read trades from ${displayName}:`, err);
        }
    }

    return `Reached the ${displayName}`;
}

// ---- Rideable entities ----

/** Entity names that can be mounted/ridden in Minecraft */
const RIDEABLE_ENTITIES = new Set([
    'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse',
    'pig', 'strider', 'camel', 'llama', 'trader_llama',
    'boat', 'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
    'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'bamboo_raft',
    'minecart',
]);

/** bot.vehicle exists at runtime but is missing from mineflayer's TS declarations */
function getVehicle(bot: Bot): Entity | null {
    return (bot as unknown as { vehicle: Entity | null }).vehicle ?? null;
}

/** Manually set/clear bot.vehicle — needed to work around mineflayer's stale state bug */
function setVehicle(bot: Bot, vehicle: Entity | null): void {
    (bot as unknown as { vehicle: Entity | null }).vehicle = vehicle;
}

export async function mountEntity(bot: Bot, entityName: string | undefined): Promise<string> {
    // Already riding something?
    const currentVehicle = getVehicle(bot);
    if (currentVehicle) {
        const vehicleName = currentVehicle.displayName ?? currentVehicle.name ?? 'something';
        return `Already riding a ${vehicleName}. Use mc_dismount first.`;
    }

    const nameLower = (entityName ?? '').toLowerCase().replace(/\s+/g, '_');

    // Find the nearest rideable entity — filter by name if provided
    let nearest: { entity: typeof bot.entity; dist: number } | null = null;
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        const eName = (entity.name ?? '').toLowerCase();

        // If a specific name was given, match against it
        if (nameLower && nameLower !== 'any') {
            if (!eName.includes(nameLower) && !nameLower.includes(eName)) continue;
        } else {
            // No name given — only consider known rideable entities
            if (!RIDEABLE_ENTITIES.has(eName)) continue;
        }

        const dist = entity.position.distanceTo(bot.entity.position);
        if (dist > 32) continue; // Too far
        if (!nearest || dist < nearest.dist) {
            nearest = { entity, dist };
        }
    }

    if (!nearest) {
        return entityName
            ? `Cannot find any ${entityName} nearby to ride`
            : 'No rideable entity nearby (horse, boat, minecart, pig, etc.)';
    }

    const displayName = nearest.entity.displayName ?? nearest.entity.name ?? 'entity';

    // Walk to the entity first if not close enough
    if (nearest.dist > 3) {
        try {
            const goal = new goals.GoalNear(
                nearest.entity.position.x,
                nearest.entity.position.y,
                nearest.entity.position.z,
                2,
            );
            await bot.pathfinder.goto(goal);
        } catch {
            // Best effort approach
        }
    }

    // Mount!
    try {
        bot.mount(nearest.entity);
        // Wait briefly for the mount event to confirm
        await new Promise((r) => setTimeout(r, 500));
        if (getVehicle(bot)) {
            return `Mounted the ${displayName}`;
        }
        return `Tried to mount the ${displayName} but it didn't work — it may not be tamed or saddled`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to mount ${displayName}: ${message}`;
    }
}

export async function dismountEntity(bot: Bot): Promise<string> {
    const currentVehicle = getVehicle(bot);
    if (!currentVehicle) {
        console.log('[MC Action] Dismount: not currently riding anything');
        return 'Not currently riding anything';
    }

    const vehicleName = currentVehicle.displayName ?? currentVehicle.name ?? 'vehicle';
    console.log(`[MC Action] Dismounting from ${vehicleName}...`);

    // Stop any stale pathfinder goals set while mounted
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (bot as any)._client;
    const botId = bot.entity.id;

    // Continuously send player_input with shift:true — the correct dismount for 1.21.2+.
    // player_input is per-tick, so we must pump it repeatedly (like holding shift).
    // NOTE: bot.dismount() is NOT used — it sends jump:true which makes the horse jump.
    try {
        let dismounted = false;
        const shiftInputs = { forward: false, backward: false, left: false, right: false, jump: false, shift: true, sprint: false };
        const releaseInputs = { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false };

        // Listen for the server's set_passengers packet confirming we're off
        const dismountPromise = new Promise<boolean>((resolve) => {
            const onSetPassengers = (packet: { entityId: number; passengers: number[] }): void => {
                if (packet.entityId === currentVehicle.id && !packet.passengers.includes(botId)) {
                    dismounted = true;
                    client.removeListener('set_passengers', onSetPassengers);
                    // Manually fix mineflayer's stale vehicle state
                    setVehicle(bot, null);
                    resolve(true);
                }
            };
            client.on('set_passengers', onSetPassengers);
            setTimeout(() => {
                client.removeListener('set_passengers', onSetPassengers);
                resolve(false);
            }, 2000);
        });

        // Pump shift every 50ms until dismounted or timeout
        const shiftPump = setInterval(() => {
            if (dismounted) return;
            client.write('player_input', { inputs: shiftInputs });
        }, 50);

        const ok = await dismountPromise;
        clearInterval(shiftPump);
        client.write('player_input', { inputs: releaseInputs });

        if (ok) {
            console.log('[MC Action] Dismounted via player_input shift (packet confirmed)');
            return `Dismounted from the ${vehicleName}`;
        }
        console.log('[MC Action] player_input shift — no packet after 2s');
    } catch (err) {
        console.log('[MC Action] player_input threw:', err instanceof Error ? err.message : err);
    }

    // Fallback: assume success — manually clear stale state
    console.log('[MC Action] No dismount packet received — clearing vehicle state manually');
    setVehicle(bot, null);
    return `Dismounted from the ${vehicleName}`;
}

