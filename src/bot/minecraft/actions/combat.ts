import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { findPlayerEntity, getBestWeapon, getBestBow, getArrowCount } from './action-helpers.js';
import { getActionAbort, setCurrentCombatTarget, getCurrentCombatTarget, setCurrentActivity } from './action-state.js';
import { ENTITY_ALIASES, LOW_HEALTH_THRESHOLD, RANGED_MOBS } from '../game-data';
import { ensureDismounted } from './movement.js';
import { getClient } from '../mineflayer-types';

// ---- Constants ----

const MELEE_RANGE = 3.5;            // Blocks — max distance for a melee hit
const TARGET_HEIGHT_FALLBACK = 1.8;  // Default entity height when unknown (player height)
const BOW_CHARGE_MS = 1200;          // Full charge = 1000ms + 200ms safety margin
const RANGED_MIN_DIST = 5;           // Switch to melee below this
const RANGED_MAX_DIST = 30;          // Don't try shooting beyond this
const MAX_ATTACK_RANGE = 32;         // Don't chase entities farther than this
const CHASE_TIMEOUT_MS = 15000;      // Give up if mob is far away / unreachable
const MAX_COMBAT_MS = 60_000;        // Absolute cap — give up if can't kill

// ---- Types ----

type WeaponInfo = { name: string; item: unknown } | null;
type BowInfo = { name: string; item: unknown } | null;

/** Mutable ranged combat state shared across tick functions */
interface CombatState {
    isDrawingBow: boolean;
    bowDrawStart: number;
    canUseRanged: boolean;
}

interface CombatEquipment {
    weapon: WeaponInfo;
    hasShield: boolean;
    bow: BowInfo;
}

interface TargetResolution {
    target: Entity;
    displayName: string;
    normalizedTarget: string;
}

// ---- Target resolution ----

/** Resolve entity name through aliases and name registry, find the nearest match */
function resolveAttackTarget(
    bot: Bot,
    entityName: string,
    names: NameRegistry,
): TargetResolution | string {
    const normalized = entityName.toLowerCase().replace(/ /g, '_');
    const aliased = ENTITY_ALIASES[normalized] ?? normalized;
    const mcName = names.resolveToMc(aliased);

    const target = bot.nearestEntity(
        (e) =>
            e !== bot.entity &&
            (e.username?.toLowerCase() === mcName.toLowerCase() ||
                e.name?.toLowerCase() === mcName.toLowerCase() ||
                e.displayName?.toLowerCase() === mcName.toLowerCase() ||
                e.username?.toLowerCase() === entityName.toLowerCase() ||
                e.name?.toLowerCase() === entityName.toLowerCase() ||
                e.displayName?.toLowerCase() === entityName.toLowerCase()),
    );

    const displayName = names.resolveToVoxta(names.resolveToMc(entityName));

    if (!target) return `${displayName} is nowhere in sight`;

    const dist = target.position.distanceTo(bot.entity.position);
    if (dist > MAX_ATTACK_RANGE) {
        return `${displayName} is nowhere in sight (nearest is ${Math.round(dist)} blocks away)`;
    }

    const normalizedTarget = entityName.toLowerCase();
    return { target, displayName, normalizedTarget };
}

// ---- Equipment setup ----

/** Equip the best weapon, shield, and check ranged capability */
async function equipForCombat(bot: Bot): Promise<CombatEquipment> {
    const weapon = getBestWeapon(bot);
    if (weapon) {
        try {
            await bot.equip(weapon.item as number, 'hand');
            console.log(`[MC Action] Equipped ${weapon.name} for combat`);
        } catch {
            // Best effort — continue fighting regardless
        }
    }

    let hasShield = false;
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (shield) {
        try {
            await bot.equip(shield, 'off-hand');
            hasShield = true;
            console.log('[MC Action] Equipped shield for combat');
        } catch {
            // Best effort
        }
    }

    const bow = getBestBow(bot);
    const canUseRanged = !!(bow && getArrowCount(bot) > 0);

    if (canUseRanged && bow) {
        console.log(`[MC Action] Ranged combat available: ${bow.name} + ${getArrowCount(bot)} arrows`);
    }

    return { weapon, hasShield, bow };
}

// ---- Bow management ----

/** Cancel bow draw and re-equip melee weapon */
async function cancelBowDraw(bot: Bot, state: CombatState, weapon: WeaponInfo): Promise<void> {
    if (state.isDrawingBow) {
        bot.deactivateItem();
        state.isDrawingBow = false;
        if (weapon) {
            try { await bot.equip(weapon.item as number, 'hand'); } catch { /* best effort */ }
        }
    }
    bot.setControlState('back', false);
}

// ---- Ranged combat tick ----

/** One tick of ranged combat: aim, draw, release, track arrows */
async function performRangedTick(
    bot: Bot,
    target: Entity,
    dist: number,
    equip: CombatEquipment,
    state: CombatState,
    displayName: string,
): Promise<void> {
    // If mob is too close and we have no melee weapon, walk backward
    if (dist < RANGED_MIN_DIST && !equip.weapon) {
        bot.pathfinder.stop();
        bot.setControlState('back', true);
        bot.setControlState('sprint', false);
    } else {
        bot.pathfinder.stop();
        bot.setControlState('back', false);
    }

    if (!state.isDrawingBow) {
        // Equip bow and start drawing
        try {
            if (equip.hasShield) bot.deactivateItem(); // Lower shield
            await bot.equip(equip.bow!.item as number, 'hand');

            // Aim at target with gravity compensation for arrow arc
            const targetHeight = (target.height ?? TARGET_HEIGHT_FALLBACK) * 0.5;
            const gravityComp = dist * dist * 0.006;
            await bot.lookAt(target.position.offset(0, targetHeight + gravityComp, 0));

            bot.activateItem(); // Start drawing the bow
            state.isDrawingBow = true;
            state.bowDrawStart = Date.now();
        } catch {
            // Fall through to melee next tick
        }
    } else {
        // Bow is being drawn — keep tracking the target
        const targetHeight = (target.height ?? TARGET_HEIGHT_FALLBACK) * 0.5;
        const gravityComp = dist * dist * 0.006;
        await bot.lookAt(target.position.offset(0, targetHeight + gravityComp, 0));

        // Release when fully charged
        if (Date.now() - state.bowDrawStart >= BOW_CHARGE_MS) {
            bot.deactivateItem(); // Release arrow
            state.isDrawingBow = false;
            console.log(`[MC Action] Arrow released at ${displayName} (${dist.toFixed(1)} blocks)`);

            // Check arrow count — if out, switch to melee permanently
            const remaining = getArrowCount(bot);
            if (remaining <= 0) {
                console.log('[MC Action] Out of arrows — switching to melee');
                state.canUseRanged = false;
                if (equip.weapon) {
                    try { await bot.equip(equip.weapon.item as number, 'hand'); } catch { /* best effort */ }
                }
            }
        }
    }
}

// ---- Melee combat tick ----

/** One tick of melee combat: shield management, attack, chase */
async function performMeleeTick(
    bot: Bot,
    target: Entity,
    dist: number,
    equip: CombatEquipment,
    state: CombatState,
): Promise<void> {
    // If we were drawing the bow, cancel and switch to melee weapon
    await cancelBowDraw(bot, state, equip.weapon);

    if (dist < MELEE_RANGE) {
        // Lower shield briefly to attack
        if (equip.hasShield) bot.deactivateItem();
        bot.attack(target);
        // Raise shield again after swing
        if (equip.hasShield) {
            setTimeout(() => {
                bot.activateItem(true);
            }, 100);
        }
    } else {
        // Out of melee range — re-set follow goal to keep chasing
        // (ranged mobs like witches back away after being hit)
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);
        if (equip.hasShield) {
            // Keep the shield raised while approaching
            bot.activateItem(true);
        }
    }
}

// ---- Kiting loop (hit-and-run state machine) ----

// Kiting constants
const FLEE_TIMEOUT_MS = 30_000;
const FLEE_DIST = 16;
const MAX_DRIFT = 25;
const RETREAT_DURATION = 3000;
const ENGAGE_TIMEOUT = 5000;

/**
 * Self-contained hit-and-run kiting loop for low-health or creeper combat.
 * Returns a Promise that resolves with the combat result string.
 */
function runKitingLoop(
    bot: Bot,
    target: Entity,
    displayName: string,
    normalizedTarget: string,
): Promise<string> {
    const isCreeper = normalizedTarget === 'creeper' || normalizedTarget === 'charged_creeper';
    const isRangedMob = RANGED_MOBS.has(normalizedTarget);

    console.log(`[MC Action] Health critical (${Math.round(bot.health)}/20) — kiting away from ${displayName}`);

    // Anchor = bot's current position. Kite around this spot.
    const anchor = bot.entity.position.clone();
    bot.setControlState('sprint', true);

    return new Promise<string>((resolve) => {
        // Kiting state machine: ENGAGE first (hit) → RETREAT → ENGAGE → repeat
        const fleeStart = Date.now();
        let phase: 'retreating' | 'engaging' = 'engaging'; // Hit first, then run
        let phaseStart = Date.now();
        let lastFleeGoalSet = 0;
        let zigzagLeft = true;
        let lastZigzagSet = 0;

        // Track death via event — bot.health is unreliable (jumps to 20 after respawn)
        let kiteDied = false;
        let explosionDetected = false;
        const onKiteDeath = (): void => { kiteDied = true; };
        bot.once('death', onKiteDeath);

        // Listen for real explosion packets to detect creeper detonation
        const onExplosion = (): void => { explosionDetected = true; };
        getClient(bot).on('explosion', onExplosion as never);

        /** Clean up all listeners and state, then resolve */
        const finish = (result: string, delay?: number): void => {
            clearInterval(fleeCheck);
            bot.removeListener('death', onKiteDeath);
            bot.setControlState('sprint', false);
            bot.pathfinder.stop();
            setCurrentActivity(bot, null);

            if (delay) {
                setTimeout(() => {
                    getClient(bot).removeListener('explosion', onExplosion as never);
                    resolve(result);
                }, delay);
            } else {
                getClient(bot).removeListener('explosion', onExplosion as never);
                resolve(result);
            }
        };

        const fleeCheck = setInterval(() => {
            // Death cancels everything (flag set by 'death' event)
            if (kiteDied || bot.health <= 0) {
                finish(`Died while fighting ${displayName}`);
                return;
            }

            // Health recovered (auto-eat worked) — safe to stop kiting (not for creepers)
            if (!isCreeper && bot.health > LOW_HEALTH_THRESHOLD) {
                finish(`Recovered health — safe now (health: ${Math.round(bot.health)}/20)`);
                return;
            }

            // Mob dead or despawned
            if (!bot.entities[target.id]) {
                if (isCreeper) {
                    // Wait 150ms for explosion packet (arrives after entity_destroy)
                    clearInterval(fleeCheck);
                    bot.removeListener('death', onKiteDeath);
                    bot.setControlState('sprint', false);
                    bot.pathfinder.stop();
                    setCurrentActivity(bot, null);
                    setTimeout(() => {
                        getClient(bot).removeListener('explosion', onExplosion as never);
                        if (explosionDetected) {
                            resolve('');
                        } else {
                            resolve(`Killed the ${displayName} while kiting! (health: ${Math.round(bot.health)}/20)`);
                        }
                    }, 150);
                } else {
                    finish(`Killed the ${displayName} while kiting! (health: ${Math.round(bot.health)}/20)`);
                }
                return;
            }

            // Timeout — stop kiting regardless
            if (Date.now() - fleeStart > FLEE_TIMEOUT_MS) {
                finish(`Barely got away from the ${displayName}! (health: ${Math.round(bot.health)}/20)`);
                return;
            }

            // ---- HIT-AND-RUN STATE MACHINE ----
            const distToMob = target.position.distanceTo(bot.entity.position);
            const now = Date.now();
            const phaseElapsed = now - phaseStart;

            if (phase === 'retreating') {
                // RETREAT: sprint away from the mob
                if (now - lastFleeGoalSet > 2000 || distToMob < 5) {
                    const dx = bot.entity.position.x - target.position.x;
                    const dz = bot.entity.position.z - target.position.z;
                    const awayAngle = Math.atan2(dz, dx);
                    const offset = (Math.random() - 0.5) * (Math.PI * 2 / 3);
                    const fleeAngle = awayAngle + offset;

                    let fleeX = Math.round(bot.entity.position.x + Math.cos(fleeAngle) * FLEE_DIST);
                    let fleeZ = Math.round(bot.entity.position.z + Math.sin(fleeAngle) * FLEE_DIST);

                    // Clamp to stay within MAX_DRIFT blocks of anchor
                    const driftX = fleeX - anchor.x;
                    const driftZ = fleeZ - anchor.z;
                    const driftDist = Math.sqrt(driftX * driftX + driftZ * driftZ);
                    if (driftDist > MAX_DRIFT) {
                        fleeX = Math.round(anchor.x + (driftX / driftDist) * MAX_DRIFT);
                        fleeZ = Math.round(anchor.z + (driftZ / driftDist) * MAX_DRIFT);
                    }

                    bot.pathfinder.setGoal(new goals.GoalXZ(fleeX, fleeZ));
                    lastFleeGoalSet = now;
                }

                // Switch to ENGAGE after retreating long enough or far enough
                if (phaseElapsed > RETREAT_DURATION || distToMob > 12) {
                    phase = 'engaging';
                    phaseStart = now;
                    lastZigzagSet = 0; // Force immediate zigzag waypoint
                    setCurrentActivity(bot, `fighting ${displayName} — hit and run`);
                }
            } else {
                // ENGAGE: approach and attack
                if (distToMob < MELEE_RANGE) {
                    // In melee range — HIT then immediately RETREAT
                    bot.attack(target);
                    phase = 'retreating';
                    phaseStart = now;
                    lastFleeGoalSet = 0;
                    setCurrentActivity(bot, `fleeing from ${displayName} — critically wounded`);
                } else if (phaseElapsed > ENGAGE_TIMEOUT) {
                    // Couldn't reach mob in time — retreat and try again
                    phase = 'retreating';
                    phaseStart = now;
                    lastFleeGoalSet = 0;
                    setCurrentActivity(bot, `fleeing from ${displayName} — critically wounded`);
                } else if (isRangedMob) {
                    // RANGED MOB: zigzag approach to dodge projectiles
                    if (now - lastZigzagSet > 1500) {
                        const towardAngle = Math.atan2(
                            target.position.z - bot.entity.position.z,
                            target.position.x - bot.entity.position.x,
                        );
                        const perpAngle = towardAngle + (zigzagLeft ? Math.PI / 2 : -Math.PI / 2);
                        const lateralDist = 6;
                        const forwardDist = Math.min(distToMob * 0.6, 10);

                        const wpX = Math.round(
                            bot.entity.position.x +
                            Math.cos(towardAngle) * forwardDist +
                            Math.cos(perpAngle) * lateralDist,
                        );
                        const wpZ = Math.round(
                            bot.entity.position.z +
                            Math.sin(towardAngle) * forwardDist +
                            Math.sin(perpAngle) * lateralDist,
                        );

                        bot.pathfinder.setGoal(new goals.GoalXZ(wpX, wpZ));
                        zigzagLeft = !zigzagLeft;
                        lastZigzagSet = now;
                    }
                } else {
                    // MELEE MOB: charge but stop at arm's length
                    bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
                }
            }
        }, 250); // 250ms — fast reaction for melee hit-and-run
    });
}

// ---- Main attack function ----

export async function attackEntity(bot: Bot, entityName: string | undefined, names: NameRegistry): Promise<string> {
    if (!entityName) return 'No entity name provided';

    await ensureDismounted(bot);

    // 1. Resolve target
    const resolution = resolveAttackTarget(bot, entityName, names);
    if (typeof resolution === 'string') return resolution;
    const { target, displayName, normalizedTarget } = resolution;

    // 2. Equip for combat
    const equip = await equipForCombat(bot);
    const state: CombatState = {
        isDrawingBow: false,
        bowDrawStart: 0,
        canUseRanged: !!(equip.bow && getArrowCount(bot) > 0),
    };

    // 3. Track combat target and start chasing
    setCurrentCombatTarget(bot, normalizedTarget);
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);

    let startTime = Date.now();
    const combatStart = Date.now();

    // Listen for explosion packets to detect creeper detonation
    let mainLoopExplosion = false;
    const onMainExplosion = (): void => { mainLoopExplosion = true; };
    getClient(bot).on('explosion', onMainExplosion as never);
    const cleanupExplosionListener = (): void => {
        getClient(bot).removeListener('explosion', onMainExplosion as never);
    };

    // 4. Main attack loop
    return new Promise<string>((resolve) => {
        const signal = getActionAbort(bot).signal;
        let tickBusy = false;

        const attackLoop = setInterval(() => {
            if (tickBusy) return;
            tickBusy = true;
            void (async () => {
            try {
            // ---- Abort check ----
            if (signal.aborted) {
                clearInterval(attackLoop);
                cleanupExplosionListener();
                await cancelBowDraw(bot, state, equip.weapon);
                if (getCurrentCombatTarget(bot) === normalizedTarget) setCurrentCombatTarget(bot, null);
                resolve(`Stopped fighting ${displayName}`);
                return;
            }

            // ---- Target dead check ----
            if (!bot.entities[target.id]) {
                clearInterval(attackLoop);
                setCurrentCombatTarget(bot, null);
                await cancelBowDraw(bot, state, equip.weapon);
                bot.pathfinder.stop();
                if (bot.health <= 0) {
                    cleanupExplosionListener();
                    resolve(`Died while fighting ${displayName}`);
                } else if (normalizedTarget === 'creeper' || normalizedTarget === 'charged_creeper') {
                    // Wait 150ms for explosion packet (arrives after entity_destroy)
                    setTimeout(() => {
                        cleanupExplosionListener();
                        if (mainLoopExplosion) {
                            resolve('');
                        } else {
                            resolve(`Killed the ${displayName} while kiting! (health: ${Math.round(bot.health)}/20)`);
                        }
                    }, 150);
                } else {
                    cleanupExplosionListener();
                    resolve(`Defeated the ${displayName}`);
                }
                return;
            }

            // ---- Low health / creeper → transition to kiting ----
            const isCreeper = normalizedTarget === 'creeper' || normalizedTarget === 'charged_creeper';
            if (bot.health > 0 && (bot.health <= LOW_HEALTH_THRESHOLD || isCreeper)) {
                clearInterval(attackLoop);
                cleanupExplosionListener();
                await cancelBowDraw(bot, state, equip.weapon);
                setCurrentCombatTarget(bot, null);
                setCurrentActivity(bot, `fleeing from ${displayName} — critically wounded`);
                resolve(await runKitingLoop(bot, target, displayName, normalizedTarget));
                return;
            }

            // ---- Timeout checks ----
            const distToTarget = target.position.distanceTo(bot.entity.position);
            if (Date.now() - combatStart > MAX_COMBAT_MS) {
                clearInterval(attackLoop);
                cleanupExplosionListener();
                await cancelBowDraw(bot, state, equip.weapon);
                setCurrentCombatTarget(bot, null);
                bot.pathfinder.stop();
                resolve(`Gave up fighting ${displayName} — too tough to kill`);
                return;
            } else if (Number.isFinite(distToTarget) && distToTarget < 16) {
                startTime = Date.now(); // Still in combat range — reset chase timer
            } else if (Date.now() - startTime > CHASE_TIMEOUT_MS) {
                clearInterval(attackLoop);
                cleanupExplosionListener();
                await cancelBowDraw(bot, state, equip.weapon);
                setCurrentCombatTarget(bot, null);
                bot.pathfinder.stop();
                resolve(`Lost sight of ${displayName} and gave up the chase`);
                return;
            }

            // ---- Attack: ranged or melee ----
            const dist = target.position.distanceTo(bot.entity.position);
            if (!Number.isFinite(dist)) return; // Stale entity — skip this tick

            const preferRanged = state.canUseRanged && equip.bow && dist <= RANGED_MAX_DIST &&
                (dist >= RANGED_MIN_DIST || !equip.weapon);
            if (preferRanged) {
                await performRangedTick(bot, target, dist, equip, state, displayName);
            } else {
                await performMeleeTick(bot, target, dist, equip, state);
            }
            } finally {
                tickBusy = false;
            }
            })();
        }, 500); // MC attack cooldown is ~500ms
    });
}

// ---- Look at player ----

export async function lookAtPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Initial look
    await bot.lookAt(player.position.offset(0, 1.6, 0));

    // Continuously track the player until another action cancels us
    const signal = getActionAbort(bot).signal;
    const trackLoop = async (): Promise<void> => {
        while (!signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (signal.aborted) break;

            // Re-find the player in case they moved
            const updated = findPlayerEntity(bot, playerName, names);
            if (!updated) break;

            await bot.lookAt(updated.position.offset(0, 1.6, 0));
        }
    };

    // Start tracking in the background (don't await — action returns immediately)
    void trackLoop();

    return ''; // Silent — AI doesn't need to know about look_at
}
