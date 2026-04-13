// ---- Bot spawn-time subsystems ----
//
// Independent physicsTick handlers and one-time fixes that are
// registered when the bot spawns. Each function is self-contained
// and only needs the bot instance (plus doorIds for door automation).
// Extracted from bot.ts to keep the connection lifecycle code readable.

import type { Bot } from 'mineflayer';
import { isInWater } from './mineflayer-types';

// ---- Constants ----
const NAN_WARNING_RATE_LIMIT_MS = 10_000;
const DOOR_GLOBAL_COOLDOWN_MS = 1000;
const DOOR_REOPEN_COOLDOWN_MS = 3000;    // Don't re-toggle a recently opened door
const DOOR_WALK_THROUGH_MS = 800;        // Time to walk through after opening
const DOOR_CLEANUP_TIMEOUT_MS = 10_000;  // Prune old door-open timestamps
const STUCK_MOVEMENT_THRESHOLD = 0.1;    // Blocks moved to count as "not stuck"
const STUCK_DETECTION_TIMEOUT_MS = 1500; // Must be stuck this long before teleporting
const STUCK_DIAG_Y_MIN = -1;
const STUCK_DIAG_Y_MAX = 2;
const TREE_SPAWN_JUMP_DURATION_MS = 1500;
const SHELTER_CHECK_INTERVAL_TICKS = 40;  // ~2 seconds
const SHELTER_DETECTION_RADIUS = 16;      // How far to scan for shelter doors
const SHELTER_ROOF_CHECK_MAX_Y = 24;

// ---- NaN position/velocity guard ----
// mineflayer's physics engine (prismarine-physics) clones bot.entity.position
// every tick, runs simulation, then REPLACES the reference:
//   bot.entity.position = clonedState.pos
// If the simulation produces NaN (e.g., stale GoalFollow target, arrow
// knockback edge cases), the NaN-infected clone is assigned back.
//
// Fix: intercept writes at TWO levels:
//   1. Vec3 level: block NaN writes to x/y/z properties
//   2. Entity level: when a new Vec3 is assigned, auto-guard it

export function setupNaNGuards(bot: Bot): void {
    let guardCounter = 0;
    let lastNaNWarnTime = 0;
    let suppressedNaNCount = 0;

    function guardVec3(vec: { x: number; y: number; z: number }, label: string): void {
        const id = ++guardCounter;
        for (const axis of ['x', 'y', 'z'] as const) {
            let _val = vec[axis];
            if (!Number.isFinite(_val)) {
                console.warn(`[MC Guard] ${label}.${axis} was NaN on init! Defaulting to 0 (guard #${id})`);
                _val = 0;
            }
            Object.defineProperty(vec, axis, {
                get() { return _val; },
                set(v: number) {
                    if (Number.isFinite(v)) { _val = v; }
                    else {
                        // Rate-limit NaN warnings — mineflayer sends bursts of
                        // NaN velocity from entity packets, no need to log each one.
                        const now = Date.now();
                        if (now - lastNaNWarnTime > NAN_WARNING_RATE_LIMIT_MS) {
                            if (suppressedNaNCount > 0) {
                                console.warn(`[MC Guard] (suppressed ${suppressedNaNCount} NaN blocks in the last 10s)`);
                            }
                            console.warn(`[MC Guard] NaN ${label}.${axis} BLOCKED (kept ${_val}, guard #${id})`);
                            lastNaNWarnTime = now;
                            suppressedNaNCount = 0;
                        } else {
                            suppressedNaNCount++;
                        }
                    }
                },
                configurable: true,
                enumerable: true,
            });
        }
    }

    // Guard at the entity level so new Vec3 clones are auto-protected
    function guardEntityProp(
        entity: Record<string, unknown>,
        prop: string,
        label: string,
    ): void {
        let _vec = entity[prop] as { x: number; y: number; z: number };
        console.log(`[MC Guard] Setting up entity guard: ${label} = (${_vec?.x?.toFixed(1)}, ${_vec?.y?.toFixed(1)}, ${_vec?.z?.toFixed(1)})`);
        guardVec3(_vec, label);
        Object.defineProperty(entity, prop, {
            get() { return _vec; },
            set(v: { x: number; y: number; z: number }) {
                const hasNaN = !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z);
                if (hasNaN) {
                    console.warn(`[MC Guard] entity.${label} REPLACED with NaN Vec3! (${v.x}, ${v.y}, ${v.z})`);
                    console.warn(new Error('[MC Guard] replacement stack').stack);
                }
                guardVec3(v, label);
                _vec = v;
            },
            configurable: true,
            enumerable: true,
        });
    }

    const entityObj = bot.entity as unknown as Record<string, unknown>;
    guardEntityProp(entityObj, 'position', 'position');
    guardEntityProp(entityObj, 'velocity', 'velocity');
    console.log(`[MC Guard] Guards ACTIVE — pos: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
}

// ---- Auto-open doors ----
// When bot is near a closed door while pathfinding, pause, look at the
// door, open it, and walk straight through. Track recently opened doors
// to avoid re-toggling (open→close→open spam).

export function setupDoorAutomation(bot: Bot, doorIds: Set<number>): void {
    let lastDoorOpen = 0;
    let doorWalkingThrough = false;
    const recentlyOpened = new Map<string, number>(); // "x,z" → timestamp

    bot.on('physicsTick', () => {
        const now = performance.now();
        if (doorWalkingThrough) return; // already handling a door
        if (now - lastDoorOpen < DOOR_GLOBAL_COOLDOWN_MS) return; // global cooldown
        // Fire when pathfinder is moving OR has a goal but is stuck
        if (!bot.pathfinder.isMoving() && !bot.pathfinder.goal) return;

        const pos = bot.entity.position;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = 0; dy <= 1; dy++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block || !doorIds.has(block.type)) continue;
                    if (block.boundingBox !== 'block') continue; // already open

                    // Use X, Z as a key — both top and bottom halves share the same column.
                    // This prevents the bot from opening the bottom half and then
                    // immediately closing via the top half on the next tick.
                    const key = `${block.position.x},${block.position.z}`;
                    const lastOpen = recentlyOpened.get(key);
                    if (lastOpen && now - lastOpen < DOOR_REOPEN_COOLDOWN_MS) continue;

                    // Find the bottom half of the door for more reliable activation.
                    // In Minecraft, doors have 'half' property: 'upper' or 'lower'.
                    let doorBlock = block;
                    try {
                        const props = block.getProperties() as Record<string, string>;
                        if (props['half'] === 'upper') {
                            const below = bot.blockAt(block.position.offset(0, -1, 0));
                            if (below && doorIds.has(below.type)) {
                                doorBlock = below;
                            }
                        }
                    } catch {
                        /* getProperties may not be available */
                    }

                    // Found a closed door — align, open, walk through
                    doorWalkingThrough = true;
                    lastDoorOpen = now;
                    recentlyOpened.set(key, now);
                    console.log(`[MC] Door detected at ${key}, activating...`);

                    // Look at the center of the door, then open and walk through
                    const doorCenter = doorBlock.position.offset(0.5, 0.5, 0.5);
                    bot.lookAt(doorCenter, true)
                        .then(() => {
                            return bot.activateBlock(doorBlock);
                        })
                        .then(() => {
                            console.log(`[MC] Door opened at ${key}`);
                            // Walk forward through the door
                            bot.setControlState('forward', true);
                            setTimeout(() => {
                                bot.setControlState('forward', false);
                                doorWalkingThrough = false;
                            }, DOOR_WALK_THROUGH_MS);
                        })
                        .catch((err) => {
                            console.warn(`[MC] Door activation failed at ${key}:`, err);
                            doorWalkingThrough = false;
                        });

                    // Clean up old entries
                    for (const [k, t] of recentlyOpened) {
                        if (now - t > DOOR_CLEANUP_TIMEOUT_MS) recentlyOpened.delete(k);
                    }
                    return;
                }
            }
        }
    });
}

// ---- Auto-swim (stay afloat) ----
// When the bot is in water, hold jump to swim upward and stay at the surface.
// Without this, the bot sinks and drowns if it enters water while idle.

export function setupAutoSwim(bot: Bot): void {
    let wasSwimming = false;
    bot.on('physicsTick', () => {
        const inWater = isInWater(bot.entity);
        if (inWater) {
            if (!wasSwimming) {
                console.log(`[${bot.username}] Entered water — auto-swimming`);
                wasSwimming = true;
            }
            bot.setControlState('jump', true);
        } else if (wasSwimming) {
            bot.setControlState('jump', false);
            wasSwimming = false;
            console.log(`[${bot.username}] Left water — stopped swimming`);
        }
    });
}

// ---- Narrow passage fix (stuck detection) ----
// Root cause: the pathfinder's physics simulation (canStraightLine) predicts
// the bot CAN reach the next node (returns true → forward=true), but the
// actual physics engine can't move the bot because its hitbox clips a wall
// by ~0.02 blocks. The bot sits there with forward=true but 0 displacement.
//
// Fix: detect forward=true with no movement for 1 second, then continuously
// snap the position to block center on every tick. This prevents the pathfinder
// from drifting the bot off-center between ticks.

export function setupStuckDetection(bot: Bot): void {
    let stuckSince: number | null = null;
    let lastMovePos = bot.entity.position.clone();
    let consecutiveStuckCount = 0;

    bot.on('physicsTick', () => {
        const isMoving = bot.pathfinder.isMoving();
        const forwardOn = bot.getControlState('forward');
        const pos = bot.entity.position;

        if (!isMoving || !forwardOn) {
            stuckSince = null;
            if (consecutiveStuckCount > 0) {
                console.log(`[MC Stuck] Unstuck after ${consecutiveStuckCount} cycles`);
                consecutiveStuckCount = 0;
            }
            lastMovePos = pos.clone();
            return;
        }

        const moved = pos.distanceTo(lastMovePos);
        if (moved > STUCK_MOVEMENT_THRESHOLD) {
            stuckSince = null;
            if (consecutiveStuckCount > 0) {
                console.log(`[MC Stuck] Unstuck (moved ${moved.toFixed(2)}) after ${consecutiveStuckCount} cycles`);
                consecutiveStuckCount = 0;
            }
            lastMovePos = pos.clone();
            return;
        }

        const now = performance.now();
        if (stuckSince === null) {
            stuckSince = now;
            return;
        }

        if (now - stuckSince > STUCK_DETECTION_TIMEOUT_MS) {
            consecutiveStuckCount++;

            // Teleport 1 block forward in the direction the pathfinder is facing.
            // The pathfinder already set the yaw toward the next path node.
            const yaw = bot.entity.yaw;
            const newX = pos.x + -Math.sin(yaw);
            const newZ = pos.z + -Math.cos(yaw);

            // Verify destination is air (foot + head level)
            const destFoot = bot.blockAt(pos.offset(-Math.sin(yaw), 0, -Math.cos(yaw)));
            const destHead = bot.blockAt(pos.offset(-Math.sin(yaw), 1, -Math.cos(yaw)));
            const footClear = !destFoot || destFoot.boundingBox === 'empty';
            const headClear = !destHead || destHead.boundingBox === 'empty';

            const destCenterX = Math.floor(newX) + 0.5;
            const destCenterZ = Math.floor(newZ) + 0.5;

            if (footClear && headClear) {
                // Flat teleport — destination is clear at the same level
                console.log(
                    `[MC Stuck] Teleporting forward: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})` +
                        ` → (${destCenterX.toFixed(2)}, ${destCenterZ.toFixed(2)})`,
                );
                pos.x = destCenterX;
                pos.z = destCenterZ;
            } else if (!footClear && headClear) {
                // Step-up: solid block at foot (e.g. grass_block) with air above
                // Check if space on TOP of the solid block is clear (y+1 foot, y+2 head)
                const upFoot = bot.blockAt(pos.offset(-Math.sin(yaw), 1, -Math.cos(yaw)));
                const upHead = bot.blockAt(pos.offset(-Math.sin(yaw), 2, -Math.cos(yaw)));
                const upFootClear = !upFoot || upFoot.boundingBox === 'empty';
                const upHeadClear = !upHead || upHead.boundingBox === 'empty';

                if (upFootClear && upHeadClear) {
                    console.log(
                        `[MC Stuck] Teleporting up+forward: (${pos.x.toFixed(2)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(2)})` +
                            ` → (${destCenterX.toFixed(2)}, ${(pos.y + 1).toFixed(1)}, ${destCenterZ.toFixed(2)})`,
                    );
                    pos.x = destCenterX;
                    pos.y = pos.y + 1;
                    pos.z = destCenterZ;
                } else {
                    console.log(
                        `[MC Stuck] Can't teleport up — blocked above` +
                            ` (upFoot=${upFoot?.name}, upHead=${upHead?.name})`,
                    );
                }
            } else {
                console.log(
                    `[MC Stuck] Can't teleport forward — fully blocked` +
                        ` (foot=${destFoot?.name}, head=${destHead?.name})`,
                );
            }

            // ---- Give up after too many consecutive stuck cycles ----
            // If the bot keeps getting stuck in the same spot (e.g. trapped inside
            // its own build), cancel the pathfinder goal to break the loop.
            if (consecutiveStuckCount >= 5) {
                console.log(`[MC Stuck] Giving up after ${consecutiveStuckCount} consecutive stuck cycles — canceling pathfinder goal`);
                bot.pathfinder.stop();
                consecutiveStuckCount = 0;
                stuckSince = null;
                lastMovePos = pos.clone();
                return;
            }

            // ---- Diagnostic dump when stuck repeatedly ----
            // Log full surroundings on every 2nd+ consecutive stuck cycle
            // so we can diagnose pit/wall traps without flooding logs on one-off stalls.
            if (consecutiveStuckCount >= 2) {
                const bx = Math.floor(pos.x);
                const by = Math.floor(pos.y);
                const bz = Math.floor(pos.z);
                const dirs = [
                    { label: 'N', dx: 0, dz: -1 },
                    { label: 'S', dx: 0, dz: 1 },
                    { label: 'E', dx: 1, dz: 0 },
                    { label: 'W', dx: -1, dz: 0 },
                ];
                const survey: string[] = [];
                // Current column
                for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
                    const b = bot.blockAt(pos.offset(0, dy, 0));
                    survey.push(`  self  y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
                }
                // Cardinal directions
                for (const dir of dirs) {
                    for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
                        const b = bot.blockAt(pos.offset(dir.dx, dy, dir.dz));
                        survey.push(`  ${dir.label}     y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
                    }
                }
                const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
                const activeControls = controls.filter((c) => bot.getControlState(c));
                const onGround = bot.entity.onGround;
                const inWaterDiag = isInWater(bot.entity);
                const hasGoal = !!bot.pathfinder.goal;
                const isMining = bot.pathfinder.isMining();

                console.log(
                    `[MC Stuck] === DIAGNOSTIC DUMP (cycle #${consecutiveStuckCount}) ===\n` +
                    `  pos: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) block: (${bx}, ${by}, ${bz})\n` +
                    `  yaw: ${((yaw * 180) / Math.PI).toFixed(1)}°, onGround: ${onGround}, inWater: ${inWaterDiag}\n` +
                    `  controls: [${activeControls.join(', ')}]\n` +
                    `  pathfinder: goal=${hasGoal}, moving=${isMoving}, mining=${isMining}\n` +
                    `  --- Block survey ---\n` +
                    survey.join('\n'),
                );
            }

            stuckSince = null;
            lastMovePos = pos.clone();
        }
    });
}

// ---- Shelter wall protection ----
// When the bot is inside a player-built shelter (roof + utility blocks),
// disable pathfinder digging so it routes through doors instead of
// breaking walls. Explicit mining (bot.dig) is unaffected.

export function setupShelterProtection(bot: Bot, doorIds: Set<number>): void {
    let tickCounter = 0;
    let lastCanDig = true;

    // Blocks that don't count as a solid roof (natural foliage/trees)
    const NON_ROOF_BLOCKS = new Set([
        'air', 'cave_air', 'void_air',
        'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
        'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
        'azalea_leaves', 'flowering_azalea_leaves',
        'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
        'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
        'short_grass', 'tall_grass', 'fern', 'large_fern',
        'vine', 'glow_lichen', 'hanging_roots', 'moss_carpet',
    ]);

    /** Check if a position has a solid roof overhead */
    function hasRoofAbove(x: number, y: number, z: number): boolean {
        try {
            for (let dy = 2; dy <= SHELTER_ROOF_CHECK_MAX_Y; dy++) {
                const above = bot.blockAt(bot.entity.position.offset(
                    x - bot.entity.position.x,
                    dy,
                    z - bot.entity.position.z,
                ));
                if (above && !NON_ROOF_BLOCKS.has(above.name)) return true;
            }
        } catch { /* chunk not loaded */ }
        return false;
    }

    bot.on('physicsTick', () => {
        tickCounter++;
        if (tickCounter < SHELTER_CHECK_INTERVAL_TICKS) return;
        tickCounter = 0;

        const movements = bot.pathfinder.movements;
        if (!movements) return;

        // Find door blocks within detection range
        const nearbyDoors = bot.findBlocks({
            matching: [...doorIds],
            maxDistance: SHELTER_DETECTION_RADIUS,
            count: 10,
        });

        // No doors nearby — no shelter to protect
        if (nearbyDoors.length === 0) {
            if (!lastCanDig) {
                movements.canDig = true;
                lastCanDig = true;
                console.log('[MC Shelter] No shelter nearby — pathfinder digging enabled');
            }
            return;
        }

        // Check if any nearby door has a roof — a door with a roof = real shelter
        let shelterDetected = false;
        for (const doorPos of nearbyDoors) {
            if (hasRoofAbove(doorPos.x, doorPos.y, doorPos.z)) {
                shelterDetected = true;
                break;
            }
        }

        const shouldDig = !shelterDetected;

        if (shouldDig !== lastCanDig) {
            movements.canDig = shouldDig;
            lastCanDig = shouldDig;
            if (shouldDig) {
                console.log('[MC Shelter] Away from shelter — pathfinder digging enabled');
            } else {
                console.log('[MC Shelter] Shelter nearby — pathfinder digging disabled (use doors)');
                // Force pathfinder to recalculate — the current path may include
                // digging through walls that was planned when canDig was still true.
                const goal = bot.pathfinder.goal;
                if (goal && bot.pathfinder.isMoving()) {
                    bot.pathfinder.setGoal(goal);
                }
            }
        }
    });
}

// ---- Tree-spawn fix ----
// If the bot spawned on top of a tree (standing on leaves or logs),
// the pathfinder can't find a clean path down and spins in place.
// Detect this and make the bot jump + move off the tree so gravity
// pulls it down naturally (no position teleport — server-safe).

export function handleTreeSpawn(bot: Bot): void {
    try {
        const pos = bot.entity.position;
        const footBlock = bot.blockAt(pos.offset(0, -1, 0));
        const isOnTree = footBlock && (
            footBlock.name.endsWith('_leaves') || footBlock.name === 'leaves' ||
            footBlock.name.endsWith('_log') || footBlock.name === 'log'
        );
        if (isOnTree) {
            console.log(`[MC] Spawned on tree (${footBlock.name}) — jumping off`);
            // Jump and walk forward briefly to clear the tree canopy
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            setTimeout(() => {
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
            }, TREE_SPAWN_JUMP_DURATION_MS);
        }
    } catch {
        /* chunk not loaded — skip */
    }
}
