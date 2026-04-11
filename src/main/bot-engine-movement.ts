import type { Bot as MineflayerBot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
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

/** Callbacks the movement loops use to interact with BotEngine state */
export interface MovementCallbacks {
    getFollowingPlayer(): string | null;
    getNames(): NameRegistry;
    isAutoDismounting(): boolean;
    addChat(type: 'action' | 'note' | 'event', sender: string, text: string): void;
    queueNote(text: string): void;
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
    let patrolTarget: { x: number; z: number } | null = null;
    const aggroCooldowns: Record<string, number> = {};

    // Batch mode kills to save LLM context — instead of sending
    // "Defeated the slime" x10, send one "Defeated 10 slimes in aggro mode."
    const modeKillCounts: Record<string, number> = {};
    let modeBatchTimer: ReturnType<typeof setTimeout> | null = null;
    let modeBatchLabel = 'aggro'; // Tracks which mode the batch belongs to
    const flushModeBatch = (): void => {
        if (modeBatchTimer) { clearTimeout(modeBatchTimer); modeBatchTimer = null; }
        const entries = Object.entries(modeKillCounts).filter(([, count]) => count > 0);
        if (entries.length === 0) return;
        const botName = getAssistantName();
        const summary = entries.map(([mob, count]) => `${count} ${mob}${count > 1 ? 's' : ''}`).join(', ');
        const verb = modeBatchLabel === 'hunt' ? 'Hunted' : 'Defeated';
        callbacks.queueNote(`${botName}: ${verb} ${summary} in ${modeBatchLabel} mode.`);
        console.log(`[${label}] ${modeBatchLabel} batch note: ${verb} ${summary}`);
        for (const key of Object.keys(modeKillCounts)) {
            modeKillCounts[key] = 0;
        }
    };

    // Farm animals that the hunt mode will target
    const HUNTABLE_ANIMALS = ['pig', 'cow', 'mooshroom', 'sheep', 'chicken', 'rabbit'];
    let huntCooldownUntil = 0; // Post-kill cooldown to let the bot settle

    let patrolPauseUntil = 0;
    const loop = setInterval(() => {
        if (!isBotActive()) return;
        const mode = getBotMode(bot);
        if (mode === 'passive') return;
        if (isAutoDefending(bot) || isActionBusy(bot)) return;
        // Don't seek new fights when critically wounded
        if (bot.health > 0 && bot.health <= 6) return;

        const pos = bot.entity.position;
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

        // ---- Aggro mode: attack nearest hostile while following player ----
        if (mode === 'aggro') {
            const followingPlayer = callbacks.getFollowingPlayer();
            const player = followingPlayer
                ? findPlayerEntity(bot, followingPlayer, callbacks.getNames())
                : null;

            // Mobs that split on death (slime → babies, magma_cube → babies).
            // After killing one we ignore that type for 5s to avoid chasing
            // tiny split babies that the attack action can't reliably hit.
            const SPLIT_MOBS = ['slime', 'magma_cube'];

            // Mobs classified as hostile but actually neutral — they only attack
            // when provoked. Don't auto-target them; the user can still say "attack the enderman".
            const NEUTRAL_HOSTILE = ['enderman', 'spider', 'cave_spider', 'zombified_piglin'];

            let nearestHostile: (typeof bot.entities)[number] | undefined;
            let nearestDist = Infinity;
            for (const e of Object.values(bot.entities)) {
                if (e === bot.entity || !isHostileEntity(e)) continue;
                const name = e.name ?? '';
                if (NEUTRAL_HOSTILE.includes(name)) continue;
                // Skip split-mob babies during cooldown
                if (SPLIT_MOBS.includes(name) && aggroCooldowns[name] && Date.now() < aggroCooldowns[name]) continue;
                const d = e.position.distanceTo(pos);
                // Within 16 blocks of bot AND within 20 blocks of player (leash)
                if (d < 16 && d < nearestDist) {
                    if (player && e.position.distanceTo(player.position) > 20) continue;
                    // Skip mobs behind solid walls (e.g., in adjacent cave systems)
                    if (!hasLineOfSight(bot, e)) continue;
                    nearestHostile = e;
                    nearestDist = d;
                }
            }

            if (nearestHostile && !getCurrentCombatTarget(bot)) {
                const mobName = nearestHostile.name ?? 'unknown';
                console.log(`[${label}] Aggro mode: attacking ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                setAutoDefending(bot, true);
                callbacks.addChat('action', 'Action', `${getAssistantName()} fighting ${mobName}!`);
                void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], callbacks.getNames())
                    .then((result) => {
                        console.log(`[${label}] Aggro attack result: ${result}`);

                        // Only batch successful kills, send failures immediately
                        if (result.toLowerCase().includes('defeated')) {
                            callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                            modeBatchLabel = 'aggro';
                            modeKillCounts[mobName] = (modeKillCounts[mobName] ?? 0) + 1;
                            // Reset batch timer — flush after 5s of no new kills
                            if (modeBatchTimer) clearTimeout(modeBatchTimer);
                            modeBatchTimer = setTimeout(flushModeBatch, 5000);
                        } else if (!result) {
                            // Empty = creeper explosion — environmental note, no bot attribution
                            callbacks.addChat('note', 'Note', 'Creeper exploded nearby');
                            callbacks.queueNote('Creeper exploded nearby');
                        } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
                            callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                            callbacks.queueNote(`${getAssistantName()}: ${result}`);
                        }

                        // Set cooldown for split mobs
                        if (SPLIT_MOBS.includes(mobName)) {
                            aggroCooldowns[mobName] = Date.now() + 5000;
                            console.log(`[${label}] Aggro: ${mobName} split cooldown set for 5s`);
                        }
                    })
                    .catch((err) => console.log(`[${label}] Aggro attack failed:`, err))
                    .finally(() => {
                        setAutoDefending(bot, false);
                        console.log(`[${label}] Aggro: combat ended, scheduling follow resume in 2s`);
                        // Wait 2s before resuming follow — if another fight starts
                        // in that window, the scan will pick it up, and this timer
                        // becomes irrelevant (the new fight sets its own goal).
                        setTimeout(() => {
                            const combatTarget = getCurrentCombatTarget(bot);
                            const defending = isAutoDefending(bot);
                            const currentFollowing = callbacks.getFollowingPlayer();
                            console.log(`[${label}] Aggro: follow resume check — following=${currentFollowing}, combatTarget=${combatTarget}, defending=${defending}`);
                            if (currentFollowing && !combatTarget && !defending) {
                                void executeAction(
                                    bot,
                                    'mc_follow_player',
                                    [{ name: 'player_name', value: currentFollowing }],
                                    callbacks.getNames(),
                                ).then((r) => console.log(`[${label}] Aggro: resumed following after kill: ${r}`));
                            } else {
                                console.log(`[${label}] Aggro: skipped follow resume (busy or no player)`);
                            }
                        }, 2000);
                    });
            }
            return;
        }

        // ---- Hunt mode: attack nearest farm animal while following player ----
        if (mode === 'hunt') {
            // Post-kill cooldown — let the bot settle, pick up loot, and breathe
            if (Date.now() < huntCooldownUntil) return;

            const followingPlayer = callbacks.getFollowingPlayer();
            const player = followingPlayer
                ? findPlayerEntity(bot, followingPlayer, callbacks.getNames())
                : null;

            let nearestAnimal: (typeof bot.entities)[number] | undefined;
            let nearestDist = Infinity;
            for (const e of Object.values(bot.entities)) {
                if (e === bot.entity) continue;
                const name = e.name ?? '';
                if (!HUNTABLE_ANIMALS.includes(name)) continue;
                const d = e.position.distanceTo(pos);
                // Within 12 blocks of bot AND within 20 blocks of player (leash)
                if (d < 12 && d < nearestDist) {
                    if (player && e.position.distanceTo(player.position) > 20) continue;
                    // Skip animals behind solid walls
                    if (!hasLineOfSight(bot, e)) continue;
                    nearestAnimal = e;
                    nearestDist = d;
                }
            }

            if (nearestAnimal && !getCurrentCombatTarget(bot)) {
                const animalName = nearestAnimal.name ?? 'unknown';
                console.log(`[${label}] Hunt mode: targeting ${animalName} (${nearestDist.toFixed(1)} blocks)`);
                setAutoDefending(bot, true);
                callbacks.addChat('action', 'Action', `${getAssistantName()} hunting ${animalName}!`);
                void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: animalName }], callbacks.getNames())
                    .then((result) => {
                        console.log(`[${label}] Hunt attack result: ${result}`);

                        if (result.toLowerCase().includes('defeated')) {
                            callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                            modeBatchLabel = 'hunt';
                            modeKillCounts[animalName] = (modeKillCounts[animalName] ?? 0) + 1;
                            if (modeBatchTimer) clearTimeout(modeBatchTimer);
                            modeBatchTimer = setTimeout(flushModeBatch, 5000);
                        } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
                            callbacks.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                            callbacks.queueNote(`${getAssistantName()}: ${result}`);
                        }
                    })
                    .catch((err) => console.log(`[${label}] Hunt attack failed:`, err))
                    .finally(() => {
                        setAutoDefending(bot, false);
                        // 1.5-second cooldown before hunting the next animal
                        huntCooldownUntil = Date.now() + 1500;
                        console.log(`[${label}] Hunt: kill ended, scheduling follow resume in 2s`);
                        setTimeout(() => {
                            const combatTarget = getCurrentCombatTarget(bot);
                            const defending = isAutoDefending(bot);
                            const currentFollowing = callbacks.getFollowingPlayer();
                            console.log(`[${label}] Hunt: follow resume check — following=${currentFollowing}, combatTarget=${combatTarget}, defending=${defending}`);
                            if (currentFollowing && !combatTarget && !defending) {
                                void executeAction(
                                    bot,
                                    'mc_follow_player',
                                    [{ name: 'player_name', value: currentFollowing }],
                                    callbacks.getNames(),
                                ).then((r) => console.log(`[${label}] Hunt: resumed following after kill: ${r}`));
                            } else {
                                console.log(`[${label}] Hunt: skipped follow resume (busy or no player)`);
                            }
                        }, 2000);
                    });
            }
            return;
        }

        // ---- Guard mode: patrol area + attack hostiles ----
        if (mode === 'guard') {
            const center = getGuardCenter(bot);
            if (!center) return;

            // Check for hostiles near guard center (skip neutral mobs like endermen)
            const GUARD_NEUTRAL = ['enderman', 'spider', 'cave_spider', 'zombified_piglin'];
            let nearestHostile: (typeof bot.entities)[number] | undefined;
            let nearestDist = Infinity;
            for (const e of Object.values(bot.entities)) {
                if (e === bot.entity || !isHostileEntity(e)) continue;
                const name = e.name ?? '';
                if (GUARD_NEUTRAL.includes(name)) continue;
                const d = e.position.distanceTo(pos);
                if (d < 16 && d < nearestDist) {
                    // Skip mobs behind solid walls
                    if (!hasLineOfSight(bot, e)) continue;
                    nearestHostile = e;
                    nearestDist = d;
                }
            }

            if (nearestHostile && !getCurrentCombatTarget(bot)) {
                const mobName = nearestHostile.name ?? 'unknown';
                console.log(`[${label}] Guard mode: engaging ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                patrolTarget = null;
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

            // Patrol: always pick a new random point on each tick after pause
            if (Date.now() < patrolPauseUntil) return;

            const distToCenter = Math.sqrt(
                (pos.x - center.x) ** 2 + (pos.z - center.z) ** 2,
            );

            // Pick new patrol point within 8 blocks of center
            const angle = Math.random() * Math.PI * 2;
            const radius = 3 + Math.random() * 5; // 3-8 blocks
            patrolTarget = {
                x: center.x + Math.cos(angle) * radius,
                z: center.z + Math.sin(angle) * radius,
            };
            patrolPauseUntil = Date.now() + 3000 + Math.random() * 3000; // 3-6s between moves
            console.log(`[${label}] Patrol: walking to (${patrolTarget.x.toFixed(0)}, ${patrolTarget.z.toFixed(0)}) — ${distToCenter.toFixed(1)} from center`);

            // Walk to patrol point
            const { GoalNear } = require('mineflayer-pathfinder').goals;
            bot.pathfinder.setGoal(new GoalNear(patrolTarget.x, center.y, patrolTarget.z, 1));
        }
    }, 2000);

    return { loop, flush: flushModeBatch };
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcClient = (bot as any)._client;
    let lastSteerLog = 0;
    // Per-bot mounted stop distance — mirrors the on-foot staggered followDistance
    const mountedStopDist = (bot as unknown as { followDistance?: number }).followDistance === 5 ? 8 : 5;
    return setInterval(() => {
        if (!isBotActive() || !callbacks.getFollowingPlayer()) return;
        if (isActionBusy(bot) || callbacks.isAutoDismounting()) return;
        const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
        if (!vehicle) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vehicleEntity = (vehicle as any);
        const vehicleName: string = (vehicleEntity.displayName ?? vehicleEntity.name ?? '').toLowerCase();
        if (vehicleName.includes('boat')) return; // Boat steering not yet implemented

        const player = findPlayerEntity(bot, callbacks.getFollowingPlayer()!, callbacks.getNames());
        if (!player) return;
        const playerVehicle = (player as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
        const targetPos = playerVehicle ? playerVehicle.position : player.position;
        const vPos = vehicleEntity.position;
        if (!vPos) return;
        const dist = vPos.distanceTo(targetPos);
        if (dist < mountedStopDist) {
            mcClient.write('player_input', {
                inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false },
            });
            return;
        }

        let dx = targetPos.x - vPos.x;
        let dz = targetPos.z - vPos.z;

        // Companion avoidance: if the other bot's horse is nearby, push away
        if (companionBot) {
            const compVehicle = (companionBot as unknown as { vehicle: { id: number } | null }).vehicle;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const compPos = compVehicle ? (compVehicle as any).position : companionBot.entity?.position;
            if (compPos) {
                const compDist = vPos.distanceTo(compPos);
                if (compDist < 4) {
                    // Push direction: away from companion
                    const pushX = vPos.x - compPos.x;
                    const pushZ = vPos.z - compPos.z;
                    const pushLen = Math.sqrt(pushX * pushX + pushZ * pushZ) || 1;
                    // Stronger push the closer they are (weight: 0.5 at 4 blocks, up to 2.0 at 0 blocks)
                    const pushWeight = Math.max(0.3, (4 - compDist) / 2);
                    dx += (pushX / pushLen) * pushWeight;
                    dz += (pushZ / pushLen) * pushWeight;
                }
            }
        }

        const yaw = -Math.atan2(dx, dz);
        const yawDeg = yaw * (180 / Math.PI);

        let speedAttr = 0.225;
        if (vehicleEntity.attributes?.['minecraft:generic.movement_speed']) {
            speedAttr = vehicleEntity.attributes['minecraft:generic.movement_speed'].value ?? 0.225;
        } else if (vehicleEntity.attributes?.['generic.movementSpeed']) {
            speedAttr = vehicleEntity.attributes['generic.movementSpeed'].value ?? 0.225;
        }
        const blocksPerSec = speedAttr * 100;
        const moveStep = Math.min(blocksPerSec * 0.05, 2.0);

        const Vec3 = require('vec3');
        const isBlocked = (x: number, z: number, baseY: number): boolean => {
            try {
                const floorY = Math.floor(baseY);
                let groundLevel = floorY - 1;
                for (let y = floorY + 2; y >= floorY - 3; y--) {
                    const b = bot.blockAt(new Vec3(x, y, z));
                    if (b && b.boundingBox === 'block') { groundLevel = y; break; }
                }
                if ((groundLevel + 1) - baseY > 1.5) return true;
                const standY = groundLevel + 1;
                for (let dy = 0; dy <= 2; dy++) {
                    const b = bot.blockAt(new Vec3(x, standY + dy, z));
                    if (b && b.boundingBox === 'block') return true;
                }
            } catch { /* world not loaded */ }
            return false;
        };

        let moveYaw = yaw;
        let moveYawDeg = yawDeg;
        let foundClear = false;
        for (const offset of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
            const tryYaw = yaw + offset;
            if (!isBlocked(vPos.x + (-Math.sin(tryYaw) * moveStep), vPos.z + (Math.cos(tryYaw) * moveStep), vPos.y)) {
                moveYaw = tryYaw;
                moveYawDeg = moveYaw * (180 / Math.PI);
                foundClear = true;
                break;
            }
        }

        if (!foundClear) {
            mcClient.write('look', { yaw: yawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
            return;
        }

        const newX = vPos.x + (-Math.sin(moveYaw) * moveStep);
        const newZ = vPos.z + (Math.cos(moveYaw) * moveStep);
        let newY = vPos.y;
        let shouldJump = false;
        try {
            const searchY = Math.floor(vPos.y);
            for (let y = searchY + 2; y >= searchY - 4; y--) {
                const b = bot.blockAt(new Vec3(newX, y, newZ));
                if (b && b.boundingBox === 'block') {
                    const yDiff = (y + 1) - vPos.y;
                    if (yDiff >= 0.5 && yDiff <= 1.5) { shouldJump = true; newY = y + 1; }
                    else { newY = vPos.y + Math.max(-0.5, Math.min(0.5, yDiff)); }
                    break;
                }
            }
        } catch { /* world not loaded */ }

        mcClient.write('look', { yaw: moveYawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
        mcClient.write('player_input', {
            inputs: { forward: true, backward: false, left: false, right: false, jump: shouldJump, shift: false, sprint: false },
        });
        mcClient.write('vehicle_move', { x: newX, y: newY, z: newZ, yaw: moveYawDeg, pitch: 0, onGround: !shouldJump });

        const now = Date.now();
        if (now - lastSteerLog > 2000) {
            lastSteerLog = now;
            console.log(`[MC Steer] Riding: dist=${dist.toFixed(1)}, speed=${blocksPerSec.toFixed(1)}b/s, step=${moveStep.toFixed(2)}, y=${newY.toFixed(1)}, pos=(${newX.toFixed(1)}, ${newZ.toFixed(1)})`);
        }
    }, 50);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcClient = (bot as any)._client;
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (player as any).vehicle = null;
            if (!isActionBusy(bot)) resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        }
    });

    return setInterval(() => {
        const followingPlayer = callbacks.getFollowingPlayer();
        if (!isBotActive() || !followingPlayer) return;
        if (getBotMode(bot) === 'guard') return;
        if (isAutoDefending(bot)) { console.log(`[${label}] Watchdog skip: auto-defending`); return; }
        if (isActionBusy(bot)) { console.log(`[${label}] Watchdog skip: action busy`); return; }

        const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
        if (vehicle) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vn = ((vehicle as any).displayName ?? (vehicle as any).name ?? 'vehicle').toLowerCase();
            console.log(`[${label}] Watchdog skip: bot is mounted (${vn})`);
            return;
        }

        const pos = bot.entity.position;
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

        const player = findPlayerEntity(bot, followingPlayer, callbacks.getNames());
        if (!player) return;

        const playerVehicleEntity = playerMountedVehicleId ? bot.entities[playerMountedVehicleId] : null;
        const targetPos = playerVehicleEntity ? playerVehicleEntity.position : player.position;
        const distToPlayer = pos.distanceTo(targetPos);
        const moved = pos.distanceTo(lastPos);
        lastPos = pos.clone();

        if (distToPlayer < 5) {
            stuckCount = 0;
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
            return;
        }
        if (moved > 0.5) { stuckCount = 0; return; }

        stuckCount++;
        if (stuckCount <= 1) {
            console.log(`[${label}] Watchdog: stuck ${distToPlayer.toFixed(1)} blocks from player, moved ${moved.toFixed(2)} — re-setting goal (tier 1)`);
            resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        } else if (stuckCount === 2) {
            console.log(`[${label}] Watchdog: still stuck — resetting pathfinder movements (tier 2)`);
            const freshMovements = new (require('mineflayer-pathfinder').Movements)(bot);
            freshMovements.canDig = true;
            freshMovements.allow1by1towers = true;
            bot.pathfinder.setMovements(freshMovements);
            resumeFollowPlayer(bot, followingPlayer, callbacks.getNames());
        } else {
            console.log(`[${label}] Watchdog: pathfinder failed — manual walking toward player (tier 3, dist=${distToPlayer.toFixed(1)})`);
            bot.pathfinder.stop();
            bot.pathfinder.setGoal(null);
            void bot.lookAt(targetPos.offset(0, 1.6, 0));
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
        }
    }, 5000);
}
