import type { Bot as MineflayerBot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../bot/name-registry';
import { isPositionFinite } from '../bot/minecraft/utils';
import {
    isAutoDefending,
    isActionBusy,
    getCurrentCombatTarget,
    getBotMode,
    getGuardCenter,
    setAutoDefending,
} from '../bot/minecraft/actions/action-state';
import { findPlayerEntity } from '../bot/minecraft/actions/action-helpers';
import { executeAction, resumeFollowPlayer } from '../bot/minecraft/action-dispatcher';
import { hasLineOfSight } from '../bot/minecraft/perception';
import { isHostileEntity } from '../bot/minecraft/events';
import { getClient, getFollowDistance, getVehicle, getEntityVehicle, setEntityVehicle } from '../bot/minecraft/mineflayer-types';
import { AGGRO_SKIP_MOBS, HUNTABLE_ANIMALS, SPLIT_MOBS, LOW_HEALTH_THRESHOLD } from '../bot/minecraft/game-data';

// ---- Timing constants ----
const BATCH_FLUSH_MS = 5000;         // Delay before flushing batched kill notes
const SPLIT_MOB_COOLDOWN_MS = 5000;  // Ignore split mob babies after a kill
const FOLLOW_RESUME_DELAY_MS = 2000; // Wait before resuming follow after combat
const MODE_SCAN_INTERVAL_MS = 2000;  // How often aggro/hunt/guard scans for targets
const WATCHDOG_INTERVAL_MS = 5000;   // Follow watchdog check frequency
const DEFAULT_MOVE_SPEED = 0.225;    // Minecraft default movement speed attribute

// ---- Mode scan constants ----
const AGGRO_TARGET_RANGE = 16;       // Blocks to scan for hostile mobs in aggro mode
const HUNT_TARGET_RANGE = 12;        // Blocks to scan for animals in hunt mode
const GUARD_TARGET_RANGE = 16;       // Blocks to scan for hostiles in guard mode
const HUNT_POST_KILL_COOLDOWN_MS = 1500;
const PATROL_MIN_RADIUS = 3;         // Closest patrol point from guard center
const PATROL_MAX_RADIUS = 5;         // Additional random radius (total = 3-8)
const PATROL_PAUSE_MIN_MS = 3000;    // Min pause between patrol moves
const PATROL_PAUSE_RANGE_MS = 3000;  // Random extra pause (total = 3-6s)

// ---- Mounted steering constants ----
const COMPANION_AVOIDANCE_RANGE = 4; // Blocks — push apart when horses overlap
const PUSH_WEIGHT_DIVISOR = 2;       // Divisor for avoidance weight scaling
const PUSH_WEIGHT_MIN = 0.3;
const MOVE_STEP_CAP = 2.0;           // Max blocks per steering tick
const STEER_TICK_MS = 50;            // Mounted steering loop interval
const STEER_LOG_INTERVAL_MS = 2000;
const STEP_UP_HEIGHT_MIN = 0.5;      // Jump if ground rises at least this much
const STEP_UP_HEIGHT_MAX = 1.5;      // Don't jump if rise is bigger than this
const VERTICAL_CORRECTION_CAP = 0.5; // Max Y adjustment per tick when not jumping

// ---- Watchdog constants ----
const WATCHDOG_CLOSE_DIST = 5;       // Stop following within this range
const WATCHDOG_MOVED_THRESHOLD = 0.5; // Reset stuck counter if moved this far

/** Callbacks the movement loops use to interact with BotEngine state */
export interface MovementCallbacks {
    getFollowingPlayer(): string | null;
    getNames(): NameRegistry;
    isAutoDismounting(): boolean;
    addChat(type: 'action' | 'note' | 'event', sender: string, text: string): void;
    queueNote(text: string): void;
}

// ---- Batch kill state (shared across aggro/hunt modes) ----

interface ModeBatchState {
    killCounts: Record<string, number>;
    timer: ReturnType<typeof setTimeout> | null;
    modeLabel: string;
}

// ---- Entity finding helpers ----

const PLAYER_LEASH_RANGE = 20; // Max distance from player for aggro/hunt targets

/** Find the nearest entity matching a filter, within range, with LOS and optional player leash */
function findNearestEntity(
    bot: MineflayerBot,
    maxRange: number,
    playerEntity: Entity | null,
    filter: (e: Entity) => boolean,
): Entity | undefined {
    let nearest: Entity | undefined;
    let nearestDist = Infinity;
    const pos = bot.entity.position;
    for (const e of Object.values(bot.entities)) {
        if (e === bot.entity) continue;
        if (!filter(e)) continue;
        const d = e.position.distanceTo(pos);
        if (d < maxRange && d < nearestDist) {
            if (playerEntity && e.position.distanceTo(playerEntity.position) > PLAYER_LEASH_RANGE) continue;
            if (!hasLineOfSight(bot, e)) continue;
            nearest = e;
            nearestDist = d;
        }
    }
    return nearest;
}

/** Find the nearest hostile mob within range, optionally leashed to a player */
function findNearestHostile(
    bot: MineflayerBot,
    maxRange: number,
    playerEntity: Entity | null,
    aggroCooldowns?: Record<string, number>,
): Entity | undefined {
    return findNearestEntity(bot, maxRange, playerEntity, (e) => {
        if (!isHostileEntity(e)) return false;
        const name = e.name ?? '';
        if (AGGRO_SKIP_MOBS.includes(name)) return false;
        // Skip split-mob babies during cooldown (aggro only)
        if (aggroCooldowns && SPLIT_MOBS.includes(name) && aggroCooldowns[name] && Date.now() < aggroCooldowns[name]) return false;
        return true;
    });
}

/** Find the nearest huntable animal within range, optionally leashed to a player */
function findNearestHuntable(
    bot: MineflayerBot,
    maxRange: number,
    playerEntity: Entity | null,
): Entity | undefined {
    return findNearestEntity(bot, maxRange, playerEntity, (e) => {
        return HUNTABLE_ANIMALS.includes(e.name ?? '');
    });
}

// ---- Combat result handling (shared between aggro/hunt) ----

/** Flush batched kill counts as a single summary note */
function flushModeBatch(
    batch: ModeBatchState,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
    label: string,
): void {
    if (batch.timer) { clearTimeout(batch.timer); batch.timer = null; }
    const entries = Object.entries(batch.killCounts).filter(([, count]) => count > 0);
    if (entries.length === 0) return;
    const botName = getAssistantName();
    const summary = entries.map(([mob, count]) => `${count} ${mob}${count > 1 ? 's' : ''}`).join(', ');
    const verb = batch.modeLabel === 'hunt' ? 'Hunted' : 'Defeated';
    callbacks.queueNote(`${botName}: ${verb} ${summary} in ${batch.modeLabel} mode.`);
    console.log(`[${label}] ${batch.modeLabel} batch note: ${verb} ${summary}`);
    for (const key of Object.keys(batch.killCounts)) {
        batch.killCounts[key] = 0;
    }
}

/** Process a combat result: batch kills, handle creeper explosions, send failure notes */
function handleCombatResult(
    result: string,
    mobName: string,
    modeLabel: string,
    batch: ModeBatchState,
    label: string,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
): void {
    console.log(`[${label}] ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} attack result: ${result}`);

    if (result.toLowerCase().includes('defeated')) {
        callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
        batch.modeLabel = modeLabel;
        batch.killCounts[mobName] = (batch.killCounts[mobName] ?? 0) + 1;
        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = setTimeout(() => flushModeBatch(batch, getAssistantName, callbacks, label), BATCH_FLUSH_MS);
    } else if (!result) {
        // Empty = creeper explosion (only relevant in aggro mode)
        if (modeLabel === 'aggro') {
            callbacks.addChat('note', 'Note', 'Creeper exploded nearby');
            callbacks.queueNote('Creeper exploded nearby');
        }
    } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
        callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
        callbacks.queueNote(`${getAssistantName()}: ${result}`);
    }
}

/** Wait, then resume following the player if no new combat started */
function scheduleFollowResume(
    bot: MineflayerBot,
    label: string,
    callbacks: MovementCallbacks,
): void {
    setTimeout(() => {
        const combatTarget = getCurrentCombatTarget(bot);
        const defending = isAutoDefending(bot);
        const currentFollowing = callbacks.getFollowingPlayer();
        console.log(`[${label}] Follow resume check — following=${currentFollowing}, combatTarget=${combatTarget}, defending=${defending}`);
        if (currentFollowing && !combatTarget && !defending) {
            void executeAction(
                bot,
                'mc_follow_player',
                [{ name: 'player_name', value: currentFollowing }],
                callbacks.getNames(),
            ).then((r) => console.log(`[${label}] Resumed following after kill: ${r}`));
        } else {
            console.log(`[${label}] Skipped follow resume (busy or no player)`);
        }
    }, FOLLOW_RESUME_DELAY_MS);
}

/** Mutable state shared between mode scan ticks */
interface ScanLoopState {
    huntCooldownUntil: number;
    patrolPauseUntil: number;
}

/** Aggro mode tick: attack nearest hostile while following player */
function tickAggroMode(
    bot: MineflayerBot,
    player: Entity | null,
    batch: ModeBatchState,
    aggroCooldowns: Record<string, number>,
    label: string,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
): void {
    const target = findNearestHostile(bot, AGGRO_TARGET_RANGE, player, aggroCooldowns);
    if (!target || getCurrentCombatTarget(bot)) return;
    const mobName = target.name ?? 'unknown';
    const dist = target.position.distanceTo(bot.entity.position);
    console.log(`[${label}] Aggro mode: attacking ${mobName} (${dist.toFixed(1)} blocks)`);
    setAutoDefending(bot, true);
    callbacks.addChat('action', 'Action', `${getAssistantName()} fighting ${mobName}!`);
    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], callbacks.getNames())
        .then((result) => {
            handleCombatResult(result, mobName, 'aggro', batch, label, getAssistantName, callbacks);
            if (SPLIT_MOBS.includes(mobName)) {
                aggroCooldowns[mobName] = Date.now() + SPLIT_MOB_COOLDOWN_MS;
                console.log(`[${label}] Aggro: ${mobName} split cooldown set for 5s`);
            }
        })
        .catch((err) => console.log(`[${label}] Aggro attack failed:`, err))
        .finally(() => {
            setAutoDefending(bot, false);
            scheduleFollowResume(bot, label, callbacks);
        });
}

/** Hunt mode tick: attack nearest farm animal while following player */
function tickHuntMode(
    bot: MineflayerBot,
    player: Entity | null,
    state: ScanLoopState,
    batch: ModeBatchState,
    label: string,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
): void {
    if (Date.now() < state.huntCooldownUntil) return;
    const target = findNearestHuntable(bot, HUNT_TARGET_RANGE, player);
    if (!target || getCurrentCombatTarget(bot)) return;
    const animalName = target.name ?? 'unknown';
    const dist = target.position.distanceTo(bot.entity.position);
    console.log(`[${label}] Hunt mode: targeting ${animalName} (${dist.toFixed(1)} blocks)`);
    setAutoDefending(bot, true);
    callbacks.addChat('action', 'Action', `${getAssistantName()} hunting ${animalName}!`);
    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: animalName }], callbacks.getNames())
        .then((result) => {
            handleCombatResult(result, animalName, 'hunt', batch, label, getAssistantName, callbacks);
        })
        .catch((err) => console.log(`[${label}] Hunt attack failed:`, err))
        .finally(() => {
            setAutoDefending(bot, false);
            state.huntCooldownUntil = Date.now() + HUNT_POST_KILL_COOLDOWN_MS;
            scheduleFollowResume(bot, label, callbacks);
        });
}

/** Guard mode tick: patrol area + attack hostiles */
function tickGuardMode(
    bot: MineflayerBot,
    state: ScanLoopState,
    label: string,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
): void {
    const center = getGuardCenter(bot);
    if (!center) return;
    const pos = bot.entity.position;

    const target = findNearestHostile(bot, GUARD_TARGET_RANGE, null);
    if (target && !getCurrentCombatTarget(bot)) {
        const mobName = target.name ?? 'unknown';
        const dist = target.position.distanceTo(pos);
        console.log(`[${label}] Guard mode: engaging ${mobName} (${dist.toFixed(1)} blocks)`);
        setAutoDefending(bot, true);
        callbacks.addChat('action', 'Action', `${getAssistantName()} defending area from ${mobName}!`);
        void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], callbacks.getNames())
            .then((result) => {
                callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                callbacks.queueNote(`${getAssistantName()}: ${result}`);
                console.log(`[${label}] Guard attack result: ${result}`);
            })
            .catch((err) => console.log(`[${label}] Guard attack failed:`, err))
            .finally(() => setAutoDefending(bot, false));
        return;
    }

    // Patrol: pick a new random point on each tick after pause
    if (Date.now() < state.patrolPauseUntil) return;

    const distToCenter = Math.sqrt((pos.x - center.x) ** 2 + (pos.z - center.z) ** 2);
    const angle = Math.random() * Math.PI * 2;
    const radius = PATROL_MIN_RADIUS + Math.random() * PATROL_MAX_RADIUS;
    const patrolTarget = {
        x: center.x + Math.cos(angle) * radius,
        z: center.z + Math.sin(angle) * radius,
    };
    state.patrolPauseUntil = Date.now() + PATROL_PAUSE_MIN_MS + Math.random() * PATROL_PAUSE_RANGE_MS;
    console.log(`[${label}] Patrol: walking to (${patrolTarget.x.toFixed(0)}, ${patrolTarget.z.toFixed(0)}) — ${distToCenter.toFixed(1)} from center`);
    const { GoalNear } = require('mineflayer-pathfinder').goals;
    bot.pathfinder.setGoal(new GoalNear(patrolTarget.x, center.y, patrolTarget.z, 1));
}

/**
 * Creates the aggro/hunt/guard mode scan loop for a bot.
 * Bot 1 and bot 2 can each have their own independent loop with an isolated state.
 */
export function createModeScanLoop(
    bot: MineflayerBot,
    isBotActive: () => boolean,
    label: string,
    getAssistantName: () => string,
    callbacks: MovementCallbacks,
): { loop: ReturnType<typeof setInterval>; flush: () => void } {
    const aggroCooldowns: Record<string, number> = {};
    const batch: ModeBatchState = { killCounts: {}, timer: null, modeLabel: 'aggro' };
    const state: ScanLoopState = { huntCooldownUntil: 0, patrolPauseUntil: 0 };

    const loop = setInterval(() => {
        if (!isBotActive()) return;
        const mode = getBotMode(bot);
        if (mode === 'passive') return;
        if (isAutoDefending(bot) || isActionBusy(bot)) return;
        if (bot.health > 0 && bot.health <= LOW_HEALTH_THRESHOLD) return;
        if (!isPositionFinite(bot.entity.position)) return;

        const followingPlayer = callbacks.getFollowingPlayer();
        const player = followingPlayer
            ? findPlayerEntity(bot, followingPlayer, callbacks.getNames()) ?? null
            : null;

        if (mode === 'aggro') { tickAggroMode(bot, player, batch, aggroCooldowns, label, getAssistantName, callbacks); return; }
        if (mode === 'hunt') { tickHuntMode(bot, player, state, batch, label, getAssistantName, callbacks); return; }
        if (mode === 'guard') { tickGuardMode(bot, state, label, getAssistantName, callbacks); }
    }, MODE_SCAN_INTERVAL_MS);

    return { loop, flush: () => flushModeBatch(batch, getAssistantName, callbacks, label) };
}

/** Compute steering direction with companion avoidance applied */
function computeSteeringDirection(
    vPos: { x: number; y: number; z: number; distanceTo: (p: { x: number; y: number; z: number }) => number },
    targetPos: { x: number; y: number; z: number },
    vehicleEntity: { attributes?: Record<string, { value?: number }> },
    companionBot: MineflayerBot | null,
): { dx: number; dz: number; yaw: number; yawDeg: number; moveStep: number } {
    let dx = targetPos.x - vPos.x;
    let dz = targetPos.z - vPos.z;

    if (companionBot) {
        const compVehicle = getVehicle(companionBot);
        const compPos = compVehicle ? compVehicle.position : companionBot.entity?.position;
        if (compPos) {
            const compDist = vPos.distanceTo(compPos);
            if (compDist < COMPANION_AVOIDANCE_RANGE) {
                const pushX = vPos.x - compPos.x;
                const pushZ = vPos.z - compPos.z;
                const pushLen = Math.sqrt(pushX * pushX + pushZ * pushZ) || 1;
                const pushWeight = Math.max(PUSH_WEIGHT_MIN, (COMPANION_AVOIDANCE_RANGE - compDist) / PUSH_WEIGHT_DIVISOR);
                dx += (pushX / pushLen) * pushWeight;
                dz += (pushZ / pushLen) * pushWeight;
            }
        }
    }

    const yaw = -Math.atan2(dx, dz);
    const yawDeg = yaw * (180 / Math.PI);

    let speedAttr = DEFAULT_MOVE_SPEED;
    if (vehicleEntity.attributes?.['minecraft:generic.movement_speed']) {
        speedAttr = vehicleEntity.attributes['minecraft:generic.movement_speed'].value ?? DEFAULT_MOVE_SPEED;
    } else if (vehicleEntity.attributes?.['generic.movementSpeed']) {
        speedAttr = vehicleEntity.attributes['generic.movementSpeed'].value ?? DEFAULT_MOVE_SPEED;
    }
    const blocksPerSec = speedAttr * 100;
    const moveStep = Math.min(blocksPerSec * (STEER_TICK_MS / 1000), MOVE_STEP_CAP);

    return { dx, dz, yaw, yawDeg, moveStep };
}

/** Sweep 5 directions to find a clear yaw that avoids obstacles */
function findClearYaw(
    bot: MineflayerBot,
    vPos: { x: number; y: number; z: number },
    yaw: number,
    moveStep: number,
): { moveYaw: number; moveYawDeg: number; foundClear: boolean } {
    const Vec3 = require('vec3');
    const isBlocked = (x: number, z: number, baseY: number): boolean => {
        try {
            const floorY = Math.floor(baseY);
            let groundLevel = floorY - 1;
            for (let y = floorY + 2; y >= floorY - 3; y--) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (b && b.boundingBox === 'block') { groundLevel = y; break; }
            }
            if ((groundLevel + 1) - baseY > STEP_UP_HEIGHT_MAX) return true;
            const standY = groundLevel + 1;
            for (let dy = 0; dy <= 2; dy++) {
                const b = bot.blockAt(new Vec3(x, standY + dy, z));
                if (b && b.boundingBox === 'block') return true;
            }
        } catch { /* world not loaded */ }
        return false;
    };

    for (const offset of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
        const tryYaw = yaw + offset;
        if (!isBlocked(vPos.x + (-Math.sin(tryYaw) * moveStep), vPos.z + (Math.cos(tryYaw) * moveStep), vPos.y)) {
            return { moveYaw: tryYaw, moveYawDeg: tryYaw * (180 / Math.PI), foundClear: true };
        }
    }
    return { moveYaw: yaw, moveYawDeg: yaw * (180 / Math.PI), foundClear: false };
}

/**
 * Creates a mounted steering loop for a bot.
 * Horse movement is client-side in MC — the client sends vehicle_move packets.
 * Bot 1 and bot 2 can each have their own independent steering loop.
 */
export function createMountedSteeringLoop(
    bot: MineflayerBot,
    isBotActive: () => boolean,
    companionBot: MineflayerBot | null,
    callbacks: MovementCallbacks,
): ReturnType<typeof setInterval> {
    const mcClient = getClient(bot);
    let lastSteerLog = 0;
    const mountedStopDist = getFollowDistance(bot) === 5 ? 8 : 5;

    return setInterval(() => {
        if (!isBotActive() || !callbacks.getFollowingPlayer()) return;
        if (isActionBusy(bot) || callbacks.isAutoDismounting()) return;
        const vehicle = getVehicle(bot);
        if (!vehicle) return;

        const vehicleName: string = (vehicle.displayName ?? vehicle.name ?? '').toLowerCase();
        if (vehicleName.includes('boat')) return;

        const player = findPlayerEntity(bot, callbacks.getFollowingPlayer()!, callbacks.getNames());
        if (!player) return;
        const playerVehicle = getEntityVehicle(player);
        const targetPos = playerVehicle ? playerVehicle.position : player.position;
        const vPos = vehicle.position;
        if (!vPos) return;
        const dist = vPos.distanceTo(targetPos);
        if (dist < mountedStopDist) {
            mcClient.write('player_input', {
                inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false },
            });
            return;
        }

        const steering = computeSteeringDirection(vPos, targetPos, vehicle, companionBot);
        const clear = findClearYaw(bot, vPos, steering.yaw, steering.moveStep);

        if (!clear.foundClear) {
            mcClient.write('look', { yaw: steering.yawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
            return;
        }

        // Calculate destination position and height adjustment
        const Vec3 = require('vec3');
        const newX = vPos.x + (-Math.sin(clear.moveYaw) * steering.moveStep);
        const newZ = vPos.z + (Math.cos(clear.moveYaw) * steering.moveStep);
        let newY = vPos.y;
        let shouldJump = false;
        try {
            const searchY = Math.floor(vPos.y);
            for (let y = searchY + 2; y >= searchY - 4; y--) {
                const b = bot.blockAt(new Vec3(newX, y, newZ));
                if (b && b.boundingBox === 'block') {
                    const yDiff = (y + 1) - vPos.y;
                    if (yDiff >= STEP_UP_HEIGHT_MIN && yDiff <= STEP_UP_HEIGHT_MAX) { shouldJump = true; newY = y + 1; }
                    else { newY = vPos.y + Math.max(-VERTICAL_CORRECTION_CAP, Math.min(VERTICAL_CORRECTION_CAP, yDiff)); }
                    break;
                }
            }
        } catch { /* world not loaded */ }

        mcClient.write('look', { yaw: clear.moveYawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
        mcClient.write('player_input', {
            inputs: { forward: true, backward: false, left: false, right: false, jump: shouldJump, shift: false, sprint: false },
        });
        mcClient.write('vehicle_move', { x: newX, y: newY, z: newZ, yaw: clear.moveYawDeg, pitch: 0, onGround: !shouldJump });

        const now = Date.now();
        if (now - lastSteerLog > STEER_LOG_INTERVAL_MS) {
            lastSteerLog = now;
            const blocksPerSec = steering.moveStep / (STEER_TICK_MS / 1000);
            console.log(`[MC Steer] Riding: dist=${dist.toFixed(1)}, speed=${blocksPerSec.toFixed(1)}b/s, step=${steering.moveStep.toFixed(2)}, y=${newY.toFixed(1)}, pos=(${newX.toFixed(1)}, ${newZ.toFixed(1)})`);
        }
    }, STEER_TICK_MS);
}

/**
 * Creates a follow watchdog for a bot.
 * Detects when pathfinder silently stops and uses escalating recovery strategies.
 * Bot 1 and bot 2 can each have their own independent watchdog.
 */
export function createFollowWatchdog(
    bot: MineflayerBot,
    isBotActive: () => boolean,
    label: string,
    callbacks: MovementCallbacks,
): ReturnType<typeof setInterval> {
    const mcClient = getClient(bot);
    let lastPos = bot.entity.position.clone();
    let stuckCount = 0;
    let playerMountedVehicleId: number | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mcClient.on('set_passengers', (packet: any) => {
        const followingPlayer = callbacks.getFollowingPlayer();
        if (!followingPlayer) return;
        const player = findPlayerEntity(bot, followingPlayer, callbacks.getNames());
        if (!player) return;
        const passengerIds: number[] = packet.passengers ?? [];
        const vehicleEntityId: number = packet.entityId;
        const vEntity = bot.entities[vehicleEntityId];
        const vName = vEntity?.displayName ?? vEntity?.name ?? 'unknown';
        if (passengerIds.includes(player.id)) {
            if (playerMountedVehicleId !== vehicleEntityId) {
                playerMountedVehicleId = vehicleEntityId;
                console.log(`[${label}] Player mounted ${vName} (id=${vehicleEntityId})`);
                if (!isActionBusy(bot)) resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
            }
        } else if (playerMountedVehicleId === vehicleEntityId) {
            console.log(`[${label}] Player dismounted ${vName} (id=${vehicleEntityId})`);
            playerMountedVehicleId = null;
            setEntityVehicle(player, null);
            if (!isActionBusy(bot)) resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        }
    });

    return setInterval(() => {
        const followingPlayer = callbacks.getFollowingPlayer();
        if (!isBotActive() || !followingPlayer) return;
        if (getBotMode(bot) === 'guard') return;
        if (isAutoDefending(bot)) { console.log(`[${label}] Watchdog skip: auto-defending`); return; }
        if (isActionBusy(bot)) { console.log(`[${label}] Watchdog skip: action busy`); return; }

        const vehicle = getVehicle(bot);
        if (vehicle) {
            const vn = (vehicle.displayName ?? vehicle.name ?? 'vehicle').toLowerCase();
            console.log(`[${label}] Watchdog skip: bot is mounted (${vn})`);
            return;
        }

        const pos = bot.entity.position;
        if (!isPositionFinite(pos)) return;

        const player = findPlayerEntity(bot, followingPlayer, callbacks.getNames());
        if (!player) return;

        const playerVehicleEntity = playerMountedVehicleId ? bot.entities[playerMountedVehicleId] : null;
        const targetPos = playerVehicleEntity ? playerVehicleEntity.position : player.position;
        const distToPlayer = pos.distanceTo(targetPos);
        const moved = pos.distanceTo(lastPos);
        lastPos = pos.clone();

        if (distToPlayer < WATCHDOG_CLOSE_DIST) {
            stuckCount = 0;
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
            return;
        }
        if (moved > WATCHDOG_MOVED_THRESHOLD) { stuckCount = 0; return; }

        stuckCount++;
        if (stuckCount <= 1) {
            console.log(`[${label}] Watchdog: stuck ${distToPlayer.toFixed(1)} blocks from player, moved ${moved.toFixed(2)} — re-setting goal (tier 1)`);
            resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        } else if (stuckCount === 2) {
            console.log(`[${label}] Watchdog: still stuck — re-setting movements + goal (tier 2)`);
            // Re-apply the existing movements (preserves door monkey-patch, canDig, etc.)
            // This forces the pathfinder to recalculate without losing movement config.
            const currentMovements = bot.pathfinder.movements;
            if (currentMovements) {
                bot.pathfinder.setMovements(currentMovements);
            }
            resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        } else {
            console.log(`[${label}] Watchdog: pathfinder failed — manual walking toward player (tier 3, dist=${distToPlayer.toFixed(1)})`);
            bot.pathfinder.stop();
            bot.pathfinder.setGoal(null);
            void bot.lookAt(targetPos.offset(0, 1.6, 0));
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
        }
    }, WATCHDOG_INTERVAL_MS);
}
