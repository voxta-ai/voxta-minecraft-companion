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
const STUCK_PROGRESS_INTERVAL_MS = 1500; // How often to sample progress (longer-window check)
const STUCK_PROGRESS_MIN_DIST = 0.3;     // Must move this far per progress interval to not be stuck
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
                    let isOpen: boolean;
                    let facing = 'unknown';
                    let openSource: string;
                    try {
                        const doorProps = doorBlock.getProperties() as Record<string, unknown>;
                        // Property can be boolean true or string 'true' depending on server
                        isOpen = String(doorProps['open']) === 'true';
                        facing = typeof doorProps['facing'] === 'string' ? doorProps['facing'] : 'unknown';
                        openSource = `prop:${String(doorProps['open'])}(${typeof doorProps['open']})`;
                    } catch {
                        try {
                            const blockProps = block.getProperties() as Record<string, unknown>;
                            isOpen = String(blockProps['open']) === 'true';
                            openSource = `fallback:${String(blockProps['open'])}(${typeof blockProps['open']})`;
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

// ---- Non-full-height block ground fix ----
// Paper servers report onGround=false when the bot stands on blocks with
// non-standard heights (dirt_path/farmland = 15/16, soul_sand = 14/16).
// This prevents jumping, step-up, and reduces movement speed to air-control.
// Fix: detect when the bot is resting on such a block and force onGround=true.

/** Blocks shorter than 1.0 and their actual surface heights */
const NON_FULL_BLOCK_HEIGHTS: Record<string, number> = {
    'dirt_path': 0.9375,     // 15/16
    'farmland': 0.9375,      // 15/16
    'soul_sand': 0.875,      // 14/16
};

/** Maximum gap between bot feet and block surface to count as "standing on" */
const GROUND_FIX_TOLERANCE = 0.03;

export function setupNonFullBlockGroundFix(bot: Bot): void {

    // ---- Ground fix: onGround correction for non-full blocks ----
    bot.on('physicsTick', () => {
        const pos = bot.entity.position;
        const feetY = pos.y;

        const block = bot.blockAt(pos.offset(0, -0.1, 0));
        if (!block) return;

        // Use known height for non-full blocks, or 1.0 for full solid blocks.
        // Paper often reports onGround=false even on full blocks (grass_block,
        // dirt, stone, etc.), crippling movement to airborne acceleration (1/5th
        // normal speed). We must fix onGround for ALL solid blocks, not just
        // the non-full ones.
        let blockHeight = NON_FULL_BLOCK_HEIGHTS[block.name];
        if (blockHeight === undefined) {
            if (block.boundingBox === 'block') {
                blockHeight = 1.0;
            } else {
                return;
            }
        }

        const surface = block.position.y + blockHeight;
        if (Math.abs(feetY - surface) < GROUND_FIX_TOLERANCE) {
            bot.entity.onGround = true;
        }
    });

    // ---- Monkey-patch setControlState to intercept and suppress jump ----
    // The pathfinder sets jump internally; we can't cancel it after the fact
    // because physics already processes it. Intercept at the source.
    const origSetControlState = bot.setControlState.bind(bot);
    bot.setControlState = (control: Parameters<typeof origSetControlState>[0], state: boolean): void => {
        if (control === 'jump' && state) {
            // Suppress jump near shelter entrances (any door within 5 blocks)
            const pos = bot.entity.position;
            try {
                const nearbyDoors = bot.findBlocks({
                    matching: (block) => block.name.includes('door'),
                    maxDistance: 5,
                    count: 1,
                    point: pos,
                });
                if (nearbyDoors.length > 0) {
                    return; // swallow the jump command
                }
            } catch { /* findBlocks can fail before chunks load */ }
        }
        origSetControlState(control, state);
    };

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
    let zoneStuckPos: ReturnType<typeof bot.entity.position.clone> | null = null; // Where the bot FIRST got stuck in this zone
    const ZONE_STUCK_RADIUS = 2.0; // If bot keeps getting stuck within this radius, escalate recovery
    let consecutiveStuckCount = 0;
    let isRecovering = false;
    let graceUntil = 0; // Timestamp — ignore checks until pathfinder re-engages

    // Longer-window progress tracker — catches "jittering without progress"
    // (bot moves > 0.1 blocks per tick but < 0.5 blocks per 3 seconds)
    let lastProgressPos = bot.entity.position.clone();
    let lastProgressCheck = performance.now();

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
                    // Moved from recovery pos — but are we still in the same stuck zone?
                    if (zoneStuckPos && pos.distanceTo(zoneStuckPos) < ZONE_STUCK_RADIUS) {
                        // Still oscillating in the same area — don't reset counter
                        // This lets narrow-passage recovery (cycle 3) trigger
                    } else {
                        console.log(`[MC Stuck] Genuinely unstuck (moved ${realMoved.toFixed(2)} from pre-recovery pos) after ${consecutiveStuckCount} cycles`);
                        consecutiveStuckCount = 0;
                        zoneStuckPos = null;
                    }
                }
            }
            lastMovePos = pos.clone();

            // Longer-window progress check: bot moved per-tick but is it
            // making real progress? Catches jittering at obstacles.
            if (hasGoal && now - lastProgressCheck > STUCK_PROGRESS_INTERVAL_MS) {
                const progress = pos.distanceTo(lastProgressPos);
                lastProgressPos = pos.clone();
                lastProgressCheck = now;
                if (progress < STUCK_PROGRESS_MIN_DIST) {
                    // Jittering without progress — force into stuck state
                    console.log(
                        `[MC Stuck] Jitter detected: moved ${progress.toFixed(2)} in ${STUCK_PROGRESS_INTERVAL_MS}ms` +
                        ` (threshold: ${STUCK_PROGRESS_MIN_DIST}) — forcing stuck recovery`,
                    );
                    stuckSince = now - STUCK_DETECTION_TIMEOUT_MS - 1; // Force immediate timeout
                    // Fall through to stuck handling below
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        // No goal — nothing to be stuck about
        if (!hasGoal) {
            if (consecutiveStuckCount > 0) {
                console.log(`[MC Stuck] Goal cleared — resetting (was at cycle #${consecutiveStuckCount})`);
                consecutiveStuckCount = 0;
                zoneStuckPos = null;
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
            // Record zone center on first stuck detection
            if (consecutiveStuckCount === 1) {
                zoneStuckPos = pos.clone();
            }

            // ---- Give up after too many consecutive stuck cycles ----
            if (consecutiveStuckCount >= STUCK_MAX_CYCLES) {
                console.log(`[MC Stuck] Giving up after ${consecutiveStuckCount} consecutive stuck cycles — canceling pathfinder goal`);
                bot.pathfinder.stop();
                consecutiveStuckCount = 0;
                zoneStuckPos = null;
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

            // Force onGround during recovery — but ONLY when near a block surface.
            // Unconditional forceGround enables step-up at any height, letting
            // the bot climb wall blocks (the root cause of doorframe wall-jumping).
            const forceGroundGeneric = (): void => {
                const y = bot.entity.position.y;
                const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
                if (below && below.boundingBox === 'block') {
                    const blockTop = below.position.y + 1.0;
                    if (Math.abs(y - blockTop) < 0.2) {
                        bot.entity.onGround = true;
                    }
                }
            };

            // ---- Door alignment recovery ----
            // When stuck near a door (open or closed), the bot is usually at an
            // angle and its hitbox clips the door frame. Fix: back up, face
            // perpendicular through the passage, strafe to center on the opening,
            // then walk straight through.
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
                        // Resolve to bottom half for reliable property reading
                        try {
                            const props = doorBlock.getProperties() as Record<string, unknown>;
                            if (String(props['half']) === 'upper') {
                                const below = bot.blockAt(doorPos.offset(0, -1, 0));
                                if (below && doorIds.has(below.type)) doorBlock = below;
                            }
                        } catch { /* use as-is */ }

                        let doorFacing = 'north';
                        let doorIsOpen = false;
                        try {
                            const props = doorBlock.getProperties() as Record<string, unknown>;
                            doorFacing = typeof props['facing'] === 'string' ? props['facing'] : 'north';
                            doorIsOpen = String(props['open']) === 'true';
                        } catch { /* defaults */ }

                        doorRecovery = true;

                        // Door facing north/south → passage along Z, center on X
                        // Door facing east/west  → passage along X, center on Z
                        const isNS = doorFacing === 'north' || doorFacing === 'south';

                        // Detect double doors — check adjacent blocks along the lateral axis
                        const allDoors = [doorBlock];
                        const lateralOffsets = isNS
                            ? [[1, 0], [-1, 0]]  // N/S: check east/west
                            : [[0, 1], [0, -1]];  // E/W: check north/south
                        for (const [dx, dz] of lateralOffsets) {
                            const neighbor = bot.blockAt(doorBlock.position.offset(dx, 0, dz));
                            if (neighbor && doorIds.has(neighbor.type)) {
                                try {
                                    const nProps = neighbor.getProperties() as Record<string, unknown>;
                                    if (String(nProps['half']) !== 'upper' &&
                                        String(nProps['facing']) === doorFacing) {
                                        allDoors.push(neighbor);
                                    }
                                } catch { /* skip */ }
                            }
                        }

                        // Center of all door blocks (handles single + double doors)
                        let doorCenterX = 0;
                        let doorCenterZ = 0;
                        for (const d of allDoors) {
                            doorCenterX += d.position.x + 0.5;
                            doorCenterZ += d.position.z + 0.5;
                        }
                        doorCenterX /= allDoors.length;
                        doorCenterZ /= allDoors.length;

                        const botPos = bot.entity.position;

                        // Determine through direction based on where the player is.
                        // The bot's own yaw is unreliable here — the pathfinder may
                        // point at an angle or even away from the door when stuck.
                        // The bot always wants to reach the player, so we just check
                        // which side of the door the player is on.
                        const targetPlayer = Object.values(bot.players).find(
                            p => p.entity && p.username !== bot.username,
                        );
                        let throughDx = 0;
                        let throughDz = 0;
                        if (targetPlayer?.entity) {
                            const playerPos = targetPlayer.entity.position;
                            if (isNS) {
                                throughDz = playerPos.z > doorCenterZ ? 1 : -1;
                            } else {
                                throughDx = playerPos.x > doorCenterX ? 1 : -1;
                            }
                        } else {
                            // No player visible — fall back to bot's heading
                            const yaw = bot.entity.yaw;
                            const headingX = -Math.sin(yaw);
                            const headingZ = Math.cos(yaw);
                            if (isNS) {
                                throughDz = Math.abs(headingZ) > 0.1
                                    ? (headingZ < 0 ? -1 : 1)
                                    : (botPos.z < doorCenterZ ? 1 : -1);
                            } else {
                                throughDx = Math.abs(headingX) > 0.1
                                    ? (headingX < 0 ? -1 : 1)
                                    : (botPos.x < doorCenterX ? 1 : -1);
                            }
                        }

                        // Calculate lateral offset — how far off-center the bot is
                        const lateralOffset = isNS
                            ? botPos.x - doorCenterX
                            : botPos.z - doorCenterZ;

                        const doorDesc = allDoors.length > 1
                            ? `double-door at (${doorBlock.position.x},${doorBlock.position.z})+(${allDoors[1].position.x},${allDoors[1].position.z})`
                            : `door at (${doorBlock.position.x},${doorBlock.position.z})`;
                        console.log(
                            `[MC Stuck] Door-align #${consecutiveStuckCount}: ${doorDesc}` +
                            ` facing=${doorFacing} open=${doorIsOpen}` +
                            ` center=(${doorCenterX.toFixed(2)},${doorCenterZ.toFixed(2)})` +
                            ` bot=(${botPos.x.toFixed(2)},${botPos.z.toFixed(2)})` +
                            ` through=(${throughDx},${throughDz}) offset=${lateralOffset.toFixed(3)}`,
                        );

                        const goal = bot.pathfinder.goal;
                        bot.pathfinder.stop();
                        const theDoor = doorBlock;
                        const allDoorsRef = allDoors;

                        // Boost airborne acceleration to match ground speed.
                        // The physicsTick handler sets onGround=true, but it fires
                        // AFTER the physics simulation already ran that tick. So every
                        // other tick the engine sees onGround=false and uses the tiny
                        // airborne acceleration (0.02). Boosting it ensures the bot
                        // moves at full speed regardless of onGround timing.
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const savedAirborneAccel = (bot as any).physics?.airborneAcceleration;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        if ((bot as any).physics) (bot as any).physics.airborneAcceleration = 0.1;

                        const alignAndWalk = async (): Promise<void> => {
                            bot.on('physicsTick', forceGroundGeneric);

                            // The bot is stuck at a door at an angle because the
                            // pathfinder was heading toward the player who moved
                            // sideways after going through. Recovery strategy:
                            //   1. Face through the door (perpendicular to the wall)
                            //   2. Back up straight to clear the door frame
                            //   3. Open any closed doors
                            //   4. Strafe laterally to center on the opening
                            //   5. Sprint straight through

                            const throughPoint = theDoor.position.offset(
                                0.5 + throughDx * 2,
                                0.5,
                                0.5 + throughDz * 2,
                            );

                            // Step 1: Sprint AWAY from the door to create clearance.
                            // Walking backward is too slow (~0.5 blocks in 400ms).
                            // Instead: face away, sprint forward, then turn back.
                            // This gives ~2-3 blocks of clearance so the strafe won't
                            // clip wall corners next to the door frame.
                            const awayPoint = theDoor.position.offset(
                                0.5 - throughDx * 3,
                                0.5,
                                0.5 - throughDz * 3,
                            );
                            await bot.lookAt(awayPoint, true);
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            await new Promise(r => setTimeout(r, 500));
                            bot.setControlState('forward', false);
                            bot.setControlState('sprint', false);
                            await new Promise(r => setTimeout(r, 100));

                            // Step 3: Open all closed doors (handles double doors)
                            for (const d of allDoorsRef) {
                                const freshBlock = bot.blockAt(d.position);
                                if (!freshBlock || !doorIds.has(freshBlock.type)) continue;
                                try {
                                    const dProps = freshBlock.getProperties() as Record<string, unknown>;
                                    if (String(dProps['open']) !== 'true') {
                                        const center = freshBlock.position.offset(0.5, 0.5, 0.5);
                                        await bot.lookAt(center, true);
                                        await bot.activateBlock(freshBlock);
                                        console.log(`[MC Stuck] Door-align: opened door at (${freshBlock.position.x},${freshBlock.position.z})`);
                                        await new Promise(r => setTimeout(r, 200));
                                    }
                                } catch { /* skip */ }
                            }

                            // Step 4: Strafe laterally to center on the door opening.
                            // Pure sideways movement — no forward/back — so the bot
                            // stays at the same distance from the door while centering.
                            // Re-aim through the door first so strafe is perpendicular.
                            await bot.lookAt(throughPoint, true);

                            const postBackupPos = bot.entity.position;
                            const currentOffset = isNS
                                ? postBackupPos.x - doorCenterX
                                : postBackupPos.z - doorCenterZ;

                            if (Math.abs(currentOffset) > 0.05) {
                                // Strafe left/right are relative to the bot's look direction.
                                // When looking along (throughDx, throughDz), the "left" direction
                                // in world coords is (throughDz, -throughDx). We care about its
                                // lateral component: throughDz for N/S doors, -throughDx for E/W.
                                // If that component has opposite sign to offset, 'left' reduces it.
                                const leftLateral = isNS ? throughDz : -throughDx;
                                const strafeDir: 'left' | 'right' =
                                    (currentOffset * leftLateral < 0) ? 'left' : 'right';
                                const strafeDist = Math.abs(currentOffset);
                                // Walk speed ~4.3 blocks/sec → ~230ms/block + buffer
                                const strafeDuration = Math.min(Math.max(strafeDist * 250 + 250, 300), 1200);

                                console.log(
                                    `[MC Stuck] Door-align: offset=${currentOffset.toFixed(3)}` +
                                    ` → strafe ${strafeDir} for ${strafeDuration.toFixed(0)}ms`,
                                );

                                bot.setControlState(strafeDir, true);
                                await new Promise(r => setTimeout(r, strafeDuration));
                                bot.setControlState(strafeDir, false);
                                await new Promise(r => setTimeout(r, 100));
                            } else {
                                console.log(`[MC Stuck] Door-align: offset=${currentOffset.toFixed(3)} — centered, skipping strafe`);
                            }

                            // Step 5: Sprint straight through the door
                            await bot.lookAt(throughPoint, true);
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);
                            await new Promise(r => setTimeout(r, 1000));

                            bot.removeListener('physicsTick', forceGroundGeneric);
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            if ((bot as any).physics && savedAirborneAccel !== undefined) (bot as any).physics.airborneAcceleration = savedAirborneAccel;
                            clearRecoveryControls();
                            bot.setControlState('sprint', false);

                            const endPos = bot.entity.position;
                            const recoveryDist = startPos.distanceTo(endPos);
                            console.log(
                                `[MC Stuck] Door-align done: moved ${recoveryDist.toFixed(2)}` +
                                ` ${recoveryDist > 0.3 ? 'OK' : 'FAILED'}`,
                            );

                            if (goal) bot.pathfinder.setGoal(goal, true);
                            isRecovering = false;
                            graceUntil = performance.now() + STUCK_POST_RECOVERY_GRACE_MS;
                            stuckSince = null;
                            lastMovePos = bot.entity.position.clone();
                        };

                        alignAndWalk().catch((err) => {
                            console.warn(`[MC Stuck] Door-align failed: ${err}`);
                            bot.removeListener('physicsTick', forceGroundGeneric);
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            if ((bot as any).physics && savedAirborneAccel !== undefined) (bot as any).physics.airborneAcceleration = savedAirborneAccel;
                            clearRecoveryControls();
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

            if (!doorRecovery) {
                // ---- Narrow-passage recovery (cycle >= 3) ----
                // Detects when the bot is stuck at a narrow opening (1-2 block wide
                // passage with walls on sides). Instead of random strafe bouncing,
                // align to the center of the opening and walk straight through.
                if (consecutiveStuckCount >= 3) {
                    // Scan N/S/E/W for walls vs openings at head height (y+1)
                    const dirs = [
                        { name: 'N', dx: 0, dz: -1 },
                        { name: 'S', dx: 0, dz: 1 },
                        { name: 'E', dx: 1, dz: 0 },
                        { name: 'W', dx: -1, dz: 0 },
                    ];
                    const wallDirs: typeof dirs = [];
                    const openDirs: typeof dirs = [];
                    for (const d of dirs) {
                        const checkBlock = bot.blockAt(pos.offset(d.dx, 0, d.dz));
                        // Wall = solid block at foot level (y+0) that isn't a door or short block
                        // Doors are OPENINGS — the bot should walk through them, not away!
                        if (checkBlock && checkBlock.boundingBox === 'block' &&
                            !NON_FULL_BLOCK_HEIGHTS[checkBlock.name] &&
                            !checkBlock.name.includes('door')) {
                            wallDirs.push(d);
                        } else {
                            openDirs.push(d);
                        }
                    }

                    // Narrow passage = at least 1 wall direction and at least 1 open direction
                    // The bot should walk toward the open direction that the pathfinder wants
                    if (wallDirs.length >= 1 && openDirs.length >= 1) {
                        // Pick the open direction closest to where the pathfinder was heading
                        const yaw = bot.entity.yaw;
                        const lookDx = -Math.sin(yaw);
                        const lookDz = Math.cos(yaw);

                        let bestDir = openDirs[0];
                        let bestDot = -Infinity;
                        for (const d of openDirs) {
                            const dot = d.dx * lookDx + d.dz * lookDz;
                            if (dot > bestDot) {
                                bestDot = dot;
                                bestDir = d;
                            }
                        }

                        console.log(
                            `[MC Stuck] Narrow-passage #${consecutiveStuckCount}: walls=[${wallDirs.map(d => d.name).join(',')}]` +
                            ` open=[${openDirs.map(d => d.name).join(',')}] → walking ${bestDir.name}`,
                        );

                        // Stop pathfinder, align, and walk through
                        const goal = bot.pathfinder.goal;
                        bot.pathfinder.stop();

                        const walkThrough = async (): Promise<void> => {
                            // Force ground during walk-through (Paper reports onGround=false
                            // even on grass_block, blocking all horizontal movement)
                            bot.on('physicsTick', forceGroundGeneric);

                            // Open any closed door at current position AND in walking direction
                            const doorPositions = [
                                pos,                                          // bot's current block
                                pos.offset(bestDir.dx, 0, bestDir.dz),        // next block in walking direction
                            ];
                            for (const doorPos of doorPositions) {
                                const doorCheck = bot.blockAt(doorPos);
                                if (doorCheck && doorCheck.name.includes('door')) {
                                    const doorProps = doorCheck.getProperties();
                                    const isOpen = doorProps['open'] === true || doorProps['open'] === 'true';
                                    if (!isOpen) {
                                        console.log(`[MC Stuck] Opening door at ${String(doorCheck.position)} before walk-through`);
                                        await bot.activateBlock(doorCheck);
                                        await new Promise(r => setTimeout(r, 200));
                                    }
                                }
                            }

                            // Look toward the center of the opening (2 blocks ahead)
                            await bot.lookAt(
                                pos.offset(bestDir.dx * 2, 0.5, bestDir.dz * 2),
                                true,
                            );

                            // Sprint forward through the opening
                            bot.setControlState('forward', true);
                            bot.setControlState('sprint', true);

                            await new Promise(r => setTimeout(r, 600));
                            bot.removeListener('physicsTick', forceGroundGeneric);
                            clearRecoveryControls();
                            bot.setControlState('sprint', false);

                            const endPos = bot.entity.position;
                            const recoveryDist = startPos.distanceTo(endPos);
                            console.log(
                                `[MC Stuck] Narrow-passage done: moved ${recoveryDist.toFixed(2)}` +
                                ` ${recoveryDist > 0.3 ? 'OK' : 'FAILED'}`,
                            );

                            // Restore goal
                            if (goal) bot.pathfinder.setGoal(goal, true);
                            isRecovering = false;
                            graceUntil = performance.now() + STUCK_POST_RECOVERY_GRACE_MS;
                            stuckSince = null;
                            lastMovePos = bot.entity.position.clone();
                        };

                        walkThrough().catch((err) => {
                            console.warn(`[MC Stuck] Narrow-passage failed: ${err}`);
                            bot.removeListener('physicsTick', forceGroundGeneric);
                            if (goal) bot.pathfinder.setGoal(goal, true);
                            isRecovering = false;
                            stuckSince = null;
                            lastMovePos = bot.entity.position.clone();
                        });

                        // Early return — async flow handles cleanup
                        stuckSince = null;
                        return;
                    }
                }

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

