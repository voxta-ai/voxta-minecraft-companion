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
const DOOR_REOPEN_COOLDOWN_MS = 3000;    // Don't re-toggle a recently opened door
const DOOR_CLEANUP_TIMEOUT_MS = 10_000;  // Prune old door-open timestamps
const STUCK_MOVEMENT_THRESHOLD = 0.1;    // Blocks moved to count as "not stuck"
const STUCK_DETECTION_TIMEOUT_MS = 800;  // Must be stuck this long before recovery
const STUCK_RECOVERY_DURATION_MS = 400;  // How long to apply recovery movement
const STUCK_POST_RECOVERY_GRACE_MS = 400; // Ignore stuck checks while pathfinder re-engages
const STUCK_REAL_MOVE_THRESHOLD = 0.5;   // Must move this far to count as genuinely unstuck
const STUCK_DIAG_Y_MIN = -1;
const STUCK_DIAG_Y_MAX = 2;
const STUCK_MAX_CYCLES = 6;              // Give up after this many recovery attempts
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
    let activating = false;
    const recentlyOpened = new Map<string, number>(); // "x,z" → timestamp

    // Monkey-patch bot.blockAt so open doors have boundingBox='empty' for ALL callers,
    // including mineflayer's physics engine. Without this, the physics engine treats
    // open doors as solid walls because the block cache doesn't update boundingBox.
    // Door collision shapes are patched at the registry level in bot.ts
    // (open door states have shapes=[]), so no per-block patching is needed here.

    bot.on('physicsTick', () => {
        if (activating) return;
        if (!bot.pathfinder.isMoving() && !bot.pathfinder.goal) return;

        const now = performance.now();
        const pos = bot.entity.position;
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                for (let dy = 0; dy <= 1; dy++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block || !doorIds.has(block.type)) continue;

                    const key = `${block.position.x},${block.position.z}`;

                    // Resolve bottom half for reliable property reading and activation
                    let doorBlock = block;
                    try {
                        const props = block.getProperties() as Record<string, string>;
                        if (props['half'] === 'upper') {
                            const below = bot.blockAt(block.position.offset(0, -1, 0));
                            if (below && doorIds.has(below.type)) {
                                doorBlock = below;
                            }
                        }
                    } catch { /* getProperties may not be available */ }

                    // Read door state — check BOTH the scanned block and resolved bottom half
                    let isOpen = false;
                    let facing = 'unknown';
                    let openSource = '?';
                    try {
                        const doorProps = doorBlock.getProperties() as Record<string, unknown>;
                        // Property can be boolean true or string 'true' depending on server
                        isOpen = String(doorProps['open']) === 'true';
                        facing = String(doorProps['facing'] ?? 'unknown');
                        openSource = `prop:${doorProps['open']}(${typeof doorProps['open']})`;
                    } catch {
                        try {
                            const blockProps = block.getProperties() as Record<string, unknown>;
                            isOpen = String(blockProps['open']) === 'true';
                            openSource = `fallback:${blockProps['open']}(${typeof blockProps['open']})`;
                        } catch {
                            console.log(`[MC Door] Can't read state at ${key} — skipping`);
                            continue;
                        }
                    }

                    if (isOpen) continue; // Door already open — just walk through

                    // Per-door cooldown to prevent toggle spam
                    const lastOpen = recentlyOpened.get(key);
                    if (lastOpen && now - lastOpen < DOOR_REOPEN_COOLDOWN_MS) continue;

                    const dist = pos.distanceTo(doorBlock.position.offset(0.5, 0, 0.5));
                    activating = true;
                    recentlyOpened.set(key, now);
                    console.log(
                        `[MC Door] ${doorBlock.name} at ${key} state=${openSource} facing=${facing}` +
                        ` dist=${dist.toFixed(1)} — activating (bot at ${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`,
                    );

                    // Look at the door first (Paper requires it), then activate.
                    // No manual forward after — pathfinder handles walking through.
                    const doorCenter = doorBlock.position.offset(0.5, 0.5, 0.5);
                    bot.lookAt(doorCenter, true)
                        .then(() => bot.activateBlock(doorBlock))
                        .then(() => {
                            console.log(`[MC Door] Activated at ${key}`);
                            activating = false;
                        })
                        .catch((err) => {
                            console.warn(`[MC Door] Failed at ${key}: ${err}`);
                            activating = false;
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

export function setupStuckDetection(bot: Bot, doorIds: Set<number>): void {
    let stuckSince: number | null = null;
    let noPathSince: number | null = null; // Separate timer for "no path" state (prevents leak into physically-stuck timer)
    let lastMovePos = bot.entity.position.clone();
    let preRecoveryPos = bot.entity.position.clone(); // Position before any recovery attempts
    let consecutiveStuckCount = 0;
    let isRecovering = false;
    let graceUntil = 0; // Timestamp — ignore checks until pathfinder re-engages

    /** Stop recovery movement controls */
    function clearRecoveryControls(): void {
        bot.setControlState('back', false);
        bot.setControlState('left', false);
        bot.setControlState('right', false);
        bot.setControlState('jump', false);
    }

    bot.on('physicsTick', () => {
        if (isRecovering) return; // Don't check during recovery movement

        const now = performance.now();
        if (now < graceUntil) return; // Post-recovery grace — let pathfinder re-engage

        const hasGoal = !!bot.pathfinder.goal;
        const pos = bot.entity.position;
        const moved = pos.distanceTo(lastMovePos);

        // Bot actually moved — not stuck
        if (moved > STUCK_MOVEMENT_THRESHOLD) {
            if (stuckSince !== null) stuckSince = null;
            if (noPathSince !== null) noPathSince = null;
            if (consecutiveStuckCount > 0) {
                const realMoved = pos.distanceTo(preRecoveryPos);
                if (realMoved > STUCK_REAL_MOVE_THRESHOLD) {
                    console.log(`[MC Stuck] Genuinely unstuck (moved ${realMoved.toFixed(2)} from pre-recovery pos) after ${consecutiveStuckCount} cycles`);
                    consecutiveStuckCount = 0;
                }
            }
            lastMovePos = pos.clone();
            return;
        }

        // No goal — nothing to be stuck about
        if (!hasGoal) {
            if (consecutiveStuckCount > 0) {
                console.log(`[MC Stuck] Goal cleared — resetting (was at cycle #${consecutiveStuckCount})`);
                consecutiveStuckCount = 0;
            }
            stuckSince = null;
            noPathSince = null;
            lastMovePos = pos.clone();
            return;
        }

        // Check WHY the bot isn't moving
        const isMoving = bot.pathfinder.isMoving();
        const forwardOn = bot.getControlState('forward');
        const isPhysicallyStuck = isMoving && forwardOn; // hitbox clip — recovery can help
        const isNoPath = hasGoal && !isMoving;            // no path — recovery won't help

        // Clear no-path state when pathfinder is active again (brief recalculation pauses reset)
        if (!isNoPath && noPathSince !== null) {
            noPathSince = null;
        }

        // "No path" — pathfinder can't find a route. Don't bounce the bot around.
        // Just try opening nearby doors and let the pathfinder retry on its own.
        // Uses a SEPARATE timer (noPathSince) so the clock doesn't leak into
        // the physically-stuck timer and cause false-positive recovery triggers.
        if (isNoPath && !isPhysicallyStuck) {
            if (noPathSince === null) {
                noPathSince = now;
            }
            // Only log after 3s of CONTINUOUS no-path state.
            // The pathfinder briefly sets isMoving()=false during normal
            // recalculations — those ~100-500ms blips are not real stucks
            // and noPathSince gets cleared above when the bot starts moving again.
            const noPathDuration = now - noPathSince;
            if (noPathDuration > 5000) {
                noPathSince = now; // reset timer, keep waiting
                console.log(
                    `[MC Stuck] No path at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})` +
                    ` — waiting for watchdog to re-set goal`,
                );
            }
            return;
        }

        // Physically stuck — bot is moving with forward=true but not displacing
        if (stuckSince === null) {
            stuckSince = now;
            return; // Wait for timeout before logging — avoid noisy false positives
        }

        if (now - stuckSince > STUCK_DETECTION_TIMEOUT_MS) {
            consecutiveStuckCount++;

            // ---- Give up after too many consecutive stuck cycles ----
            if (consecutiveStuckCount >= STUCK_MAX_CYCLES) {
                console.log(`[MC Stuck] Giving up after ${consecutiveStuckCount} consecutive stuck cycles — canceling pathfinder goal`);
                bot.pathfinder.stop();
                consecutiveStuckCount = 0;
                stuckSince = null;
                lastMovePos = pos.clone();
                return;
            }

            // ---- Diagnostic dump on 3rd+ cycle ----
            if (consecutiveStuckCount >= 3) {
                const yaw = bot.entity.yaw;
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
                for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
                    const b = bot.blockAt(pos.offset(0, dy, 0));
                    survey.push(`  self  y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
                }
                for (const dir of dirs) {
                    for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
                        const b = bot.blockAt(pos.offset(dir.dx, dy, dir.dz));
                        survey.push(`  ${dir.label}     y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
                    }
                }
                const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
                const activeControls = controls.filter((c) => bot.getControlState(c));
                console.log(
                    `[MC Stuck] === DIAGNOSTIC DUMP (cycle #${consecutiveStuckCount}) ===\n` +
                    `  pos: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) block: (${bx}, ${by}, ${bz})\n` +
                    `  yaw: ${((yaw * 180) / Math.PI).toFixed(1)}°, onGround: ${bot.entity.onGround}, inWater: ${isInWater(bot.entity)}\n` +
                    `  controls: [${activeControls.join(', ')}]\n` +
                    `  pathfinder: goal=${hasGoal}, moving=${bot.pathfinder.isMoving()}, mining=${bot.pathfinder.isMining()}\n` +
                    `  --- Block survey ---\n` +
                    survey.join('\n'),
                );
            }

            // ---- Physics-based recovery ----
            const startPos = pos.clone();
            // Don't stop the pathfinder — just layer strafe/jump controls on top
            // of the pathfinder's forward movement. The bot moves diagonally to
            // clear the corner, and the pathfinder never loses its goal.
            isRecovering = true;

            // Save the position before the FIRST recovery attempt in a stuck episode
            if (consecutiveStuckCount === 1) {
                preRecoveryPos = pos.clone();
            }

            // Check if stuck near a door — open it and walk through in sequence
            let doorRecovery = false;
            try {
                const nearbyDoors = bot.findBlocks({
                    matching: [...doorIds],
                    maxDistance: 2,
                    count: 1,
                });
                if (nearbyDoors.length > 0) {
                    const doorPos = nearbyDoors[0];
                    let doorBlock = bot.blockAt(doorPos);
                    if (doorBlock) {
                        // Resolve to bottom half
                        try {
                            const props = doorBlock.getProperties() as Record<string, unknown>;
                            if (String(props['half']) === 'upper') {
                                const below = bot.blockAt(doorPos.offset(0, -1, 0));
                                if (below && doorIds.has(below.type)) doorBlock = below;
                            }
                        } catch { /* use as-is */ }

                        let doorFacing = 'north';
                        let doorHinge = 'left';
                        let doorIsOpen = false;
                        try {
                            const props = doorBlock.getProperties() as Record<string, unknown>;
                            doorFacing = String(props['facing'] ?? 'north');
                            doorHinge = String(props['hinge'] ?? 'left');
                            doorIsOpen = String(props['open']) === 'true';
                        } catch { /* defaults */ }

                        doorRecovery = true;
                        const isNS = doorFacing === 'north' || doorFacing === 'south';

                        // Calculate the walkable offset within the door block.
                        // When open, the thin panel (0.19 blocks) sits on the hinge side.
                        // The bot must walk through the OTHER side to avoid server-side collision.
                        // Offset 0.25 = hinge side (panel), 0.75 = open side (walkable)
                        let walkableX = doorBlock.position.x + 0.5; // default: center
                        let walkableZ = doorBlock.position.z + 0.5;
                        if (isNS) {
                            // N/S door: passage along Z, panel on X side
                            const panelEast =
                                (doorFacing === 'north' && doorHinge === 'right') ||
                                (doorFacing === 'south' && doorHinge === 'left');
                            walkableX = doorBlock.position.x + (panelEast ? 0.25 : 0.75);
                        } else {
                            // E/W door: passage along X, panel on Z side
                            const panelSouth =
                                (doorFacing === 'east' && doorHinge === 'left') ||
                                (doorFacing === 'west' && doorHinge === 'right');
                            walkableZ = doorBlock.position.z + (panelSouth ? 0.25 : 0.75);
                        }

                        console.log(
                            `[MC Stuck] Door-pass #${consecutiveStuckCount}: door at (${doorPos.x},${doorPos.z})` +
                            ` facing=${doorFacing} hinge=${doorHinge} open=${doorIsOpen}` +
                            ` walkable=(${walkableX.toFixed(2)},${walkableZ.toFixed(2)})`,
                        );

                        // 1. Stop pathfinder so it doesn't fight our controls
                        const goal = bot.pathfinder.goal;
                        bot.pathfinder.stop();

                        // 2. Open the door if closed
                        const theDoor = doorBlock; // capture non-null ref for async
                        const openAndWalk = async (): Promise<void> => {
                            if (!doorIsOpen) {
                                const center = theDoor.position.offset(0.5, 0.5, 0.5);
                                await bot.lookAt(center, true);
                                await bot.activateBlock(theDoor);
                                console.log(`[MC Stuck] Door opened — now walking through`);
                                await new Promise(r => setTimeout(r, 100));
                            }

                            // 3. Look through the door on the WALKABLE side (away from panel)
                            const botPos = bot.entity.position;
                            const doorCZ = theDoor.position.z + 0.5;
                            const doorCX = theDoor.position.x + 0.5;
                            let lookX = walkableX;
                            let lookZ = walkableZ;
                            if (isNS) {
                                lookZ = botPos.z < doorCZ ? doorCZ + 2 : doorCZ - 2;
                            } else {
                                lookX = botPos.x < doorCX ? doorCX + 2 : doorCX - 2;
                            }
                            console.log(
                                `[MC Stuck] Door-pass: bot=(${botPos.x.toFixed(2)},${botPos.z.toFixed(2)})` +
                                ` → looking toward (${lookX.toFixed(2)}, ${lookZ.toFixed(2)})`,
                            );
                            await bot.lookAt(
                                theDoor.position.offset(
                                    lookX - theDoor.position.x,
                                    0.5,
                                    lookZ - theDoor.position.z,
                                ),
                                true,
                            );

                            // 4. Walk forward through the door
                            // Force onGround=true EVERY TICK — Paper overrides it to
                            // false each tick, which blocks horizontal movement.
                            const forceGround = (): void => { bot.entity.onGround = true; };
                            bot.on('physicsTick', forceGround);
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);

                            const walkStart = bot.entity.position.clone();
                            await new Promise(r => setTimeout(r, 800));
                            bot.removeListener('physicsTick', forceGround);
                            clearRecoveryControls();
                            bot.setControlState('sprint', false);

                            const endPos = bot.entity.position;
                            const recoveryDist = startPos.distanceTo(endPos);
                            console.log(
                                `[MC Stuck] Door-pass done: moved ${recoveryDist.toFixed(2)}` +
                                ` ${recoveryDist > 0.3 ? 'OK' : 'FAILED'}`,
                            );

                            // 5. Restore goal
                            if (goal) bot.pathfinder.setGoal(goal, true);
                            isRecovering = false;
                            graceUntil = performance.now() + STUCK_POST_RECOVERY_GRACE_MS;
                            stuckSince = null;
                            lastMovePos = bot.entity.position.clone();
                        };

                        openAndWalk().catch((err) => {
                            console.warn(`[MC Stuck] Door-pass failed: ${err}`);
                            if (goal) bot.pathfinder.setGoal(goal, true);
                            isRecovering = false;
                            stuckSince = null;
                            lastMovePos = bot.entity.position.clone();
                        });

                        // Early return — the async flow handles cleanup
                        stuckSince = null;
                        return;
                    }
                }
            } catch { /* findBlocks can fail before chunks load */ }

            // Force onGround every tick during recovery — hoisted for setTimeout access
            const forceGroundGeneric = (): void => { bot.entity.onGround = true; };

            if (!doorRecovery) {
                // Generic wall/corner recovery — back+strafe (strategies 0-3)
                // Strategy 4 is forward+jump for micro-ledge obstacles
                // (e.g. dirt_path → grass_block = 1/16 block step at door frames)
                const strategy = ((consecutiveStuckCount - 1) % 5);
                const strategyNames = ['back+left', 'back+right', 'back', 'left', 'forward+jump'];
                console.log(`[MC Stuck] Recovery #${consecutiveStuckCount}: ${strategyNames[strategy]} at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);

                if (strategy <= 3) {
                    // Strafe recovery — force ground so Paper doesn't block movement
                    bot.on('physicsTick', forceGroundGeneric);
                    bot.setControlState('forward', false);
                    if (strategy <= 2) bot.setControlState('back', true);
                    if (strategy === 0 || strategy === 3) bot.setControlState('left', true);
                    if (strategy === 1) bot.setControlState('right', true);
                } else {
                    // Jump recovery — DON'T force ground (jump needs real ground state,
                    // forceGround + jump creates a trampoline that launches the bot)
                    bot.setControlState('forward', true);
                    bot.setControlState('jump', true);
                }
            }

            setTimeout(() => {
                bot.removeListener('physicsTick', forceGroundGeneric);
                clearRecoveryControls();
                const endPos = bot.entity.position;
                const recoveryDist = startPos.distanceTo(endPos);
                const totalDist = endPos.distanceTo(preRecoveryPos);
                console.log(
                    `[MC Stuck] Recovery done: moved ${recoveryDist.toFixed(2)} (total ${totalDist.toFixed(2)})` +
                    ` ${recoveryDist > 0.1 ? 'OK' : 'FAILED'}`,
                );
                // Pathfinder still has its goal — it resumes naturally
                isRecovering = false;
                graceUntil = performance.now() + STUCK_POST_RECOVERY_GRACE_MS;
                stuckSince = null;
                lastMovePos = bot.entity.position.clone();
            }, STUCK_RECOVERY_DURATION_MS);
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
                    bot.pathfinder.setGoal(goal, true);
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
