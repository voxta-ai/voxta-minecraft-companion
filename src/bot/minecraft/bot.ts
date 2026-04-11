import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { CompanionConfig } from '../config.js';
import { isInWater } from './mineflayer-types';

export interface MinecraftBot {
    bot: mineflayer.Bot;
    connect(): Promise<void>;
    disconnect(): void;
    /** Set the Mojang texture URL to apply via SkinsRestorer on spawn. */
    setSkinUrl(url: string | null): void;
    /** Set a companion bot reference so the pathfinder avoids overlapping with it. */
    setCompanion(companion: mineflayer.Bot | null): void;
}

export function createMinecraftBot(config: CompanionConfig): MinecraftBot {
    let resolveSpawn: (() => void) | null = null;
    let rejectSpawn: ((err: Error) => void) | null = null;
    let pendingSkinUrl: string | null = null;
    let botSpawned = false;
    let skinApplied = false;
    let companionBot: mineflayer.Bot | null = null;

    const bot = mineflayer.createBot({
        host: config.mc.host,
        port: config.mc.port,
        username: config.mc.username,
        ...(config.mc.version ? { version: config.mc.version } : {}),
        hideErrors: false,
    });

    // Load pathfinder plugin
    bot.loadPlugin(pathfinder);

    bot.on('login', () => {
        console.log(`[MC] Logged in as ${bot.username}`);
    });

    bot.on('spawn', () => {
        console.log(`[MC] Spawned at ${String(bot.entity.position)}`);
        botSpawned = true;

        // Apply skin via SkinsRestorer chat command (if plugin is installed)
        // Only apply once per session — SkinsRestorer respawns the bot to show
        // the skin, which re-triggers this event. Without this guard, the second
        // spawn causes a rate-limited duplicate /skin command.
        if (pendingSkinUrl && !skinApplied) {
            skinApplied = true;
            applySkinCommand(bot, pendingSkinUrl);
        }

        // Configure pathfinder default movements
        const mcData = require('minecraft-data')(bot.version);
        const defaultMovements = new Movements(bot);
        defaultMovements.canDig = true;
        defaultMovements.allow1by1towers = true;
        defaultMovements.canOpenDoors = false; // broken for 2-block doors

        // Only use dirt for scaffolding/pillaring — don't waste cobblestone or other materials
        const dirtBlock = mcData.blocksByName['dirt'];
        if (dirtBlock) {
            defaultMovements.scafoldingBlocks = [dirtBlock.id];
        }

        // Collect door block IDs
        const doorNames = [
            'oak_door',
            'spruce_door',
            'birch_door',
            'jungle_door',
            'acacia_door',
            'dark_oak_door',
            'mangrove_door',
            'cherry_door',
            'crimson_door',
            'warped_door',
        ];
        const doorIds = new Set<number>();
        for (const name of doorNames) {
            const block = mcData.blocksByName[name];
            if (block) {
                doorIds.add(block.id);
                defaultMovements.blocksCantBreak.add(block.id);
            }
        }
        console.log(`[MC] Registered ${doorIds.size} door types as passable`);

        // Monkey-patch getBlock so doors are treated as passable by the pathfinder.
        // Without this, closed doors have boundingBox='block' → pathfinder sees walls.
        const originalGetBlock = defaultMovements.getBlock.bind(defaultMovements);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        defaultMovements.getBlock = function (pos: any, dx: number, dy: number, dz: number) {
            const b = originalGetBlock(pos, dx, dy, dz);
            if (b && b.type !== undefined && doorIds.has(b.type)) {
                b.safe = true;
                b.physical = false;
            }
            return b;
        };

        // Lava safety — prevent digging blocks adjacent to lava/water (avoids flooding)
        defaultMovements.dontCreateFlow = true;
        defaultMovements.dontMineUnderFallingBlock = true;

        // Lava buffer zone — add high cost to blocks adjacent to lava so the
        // pathfinder routes at least 1 block away. Without this, diagonal moves
        // clip the lava hitbox and set the bot on fire.
        const lavaId = mcData.blocksByName['lava']?.id;
        const flowingLavaId = mcData.blocksByName['flowing_lava']?.id;
        if (lavaId !== undefined) {
            const isLava = (id: number): boolean => id === lavaId || id === flowingLavaId;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            defaultMovements.exclusionAreasStep = [(block: any) => {
                const p = block.position;
                if (!p) return 0;
                const offsets = [
                    [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], // diagonals
                    [0, -1, 0], // below — don't walk over lava
                ];
                for (const [dx, dy, dz] of offsets) {
                    const neighbor = bot.blockAt(p.offset(dx, dy, dz));
                    if (neighbor && isLava(neighbor.type)) return 100;
                }
                return 0;
            }];
        }

        // Companion bot exclusion zone — avoid walking into the other bot's position.
        // Uses a closure over companionBot so it works even when set after spawn.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        defaultMovements.exclusionAreasStep.push((block: any) => {
            if (!companionBot) return 0;
            const p = block.position;
            if (!p) return 0;
            const cp = companionBot.entity?.position;
            if (!cp) return 0;
            const dx = Math.abs(p.x - Math.floor(cp.x));
            const dz = Math.abs(p.z - Math.floor(cp.z));
            // Blocks within 1 block of the companion get heavy cost penalty
            if (dx <= 1 && dz <= 1) return 80;
            return 0;
        });

        bot.pathfinder.setMovements(defaultMovements);

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
                            if (now - lastNaNWarnTime > 10_000) {
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

        // Auto-open doors: when bot is near a closed door while pathfinding,
        // pause, look at the door, open it, and walk straight through.
        // Track recently opened doors to avoid re-toggling (open→close→open spam).
        let lastDoorOpen = 0;
        let doorWalkingThrough = false;
        const recentlyOpened = new Map<string, number>(); // "x,z" → timestamp

        bot.on('physicsTick', () => {
            const now = performance.now();
            if (doorWalkingThrough) return; // already handling a door
            if (now - lastDoorOpen < 1000) return; // global cooldown
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
                        if (lastOpen && now - lastOpen < 3000) continue;

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
                                }, 800);
                            })
                            .catch((err) => {
                                console.warn(`[MC] Door activation failed at ${key}:`, err);
                                doorWalkingThrough = false;
                            });

                        // Clean up old entries
                        for (const [k, t] of recentlyOpened) {
                            if (now - t > 10000) recentlyOpened.delete(k);
                        }
                        return;
                    }
                }
            }
        });

        // === Auto-swim (stay afloat) ===
        // When the bot is in water, hold jump to swim upward and stay at the surface.
        // Without this, the bot sinks and drowns if it enters water while idle.
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

        // === Narrow passage fix ===
        // Root cause: the pathfinder's physics simulation (canStraightLine) predicts
        // the bot CAN reach the next node (returns true → forward=true), but the
        // actual physics engine can't move the bot because its hitbox clips a wall
        // by ~0.02 blocks. The bot sits there with forward=true but 0 displacement.
        //
        // Fix: detect forward=true with no movement for 1 second, then continuously
        // snap the position to block center on every tick. This prevents the pathfinder
        // from drifting the bot off-center between ticks.

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
            if (moved > 0.1) {
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

            if (now - stuckSince > 1500) {
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
                    for (let dy = -1; dy <= 2; dy++) {
                        const b = bot.blockAt(pos.offset(0, dy, 0));
                        survey.push(`  self  y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
                    }
                    // Cardinal directions
                    for (const dir of dirs) {
                        for (let dy = -1; dy <= 2; dy++) {
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

        // ---- Tree-spawn fix ----
        // If the bot spawned on top of a tree (standing on leaves or logs),
        // the pathfinder can't find a clean path down and spins in place.
        // Detect this and make the bot jump + move off the tree so gravity
        // pulls it down naturally (no position teleport — server-safe).
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
                }, 1500);
            }
        } catch {
            /* chunk not loaded — skip */
        }

        if (resolveSpawn) {
            resolveSpawn();
            resolveSpawn = null;
            rejectSpawn = null;
        }
    });

    bot.on('death', () => {
        console.log('[MC] Bot died, respawning...');
    });

    bot.on('kicked', (reason) => {
        console.error(`[MC] Kicked: ${reason}`);
    });

    bot.on('error', (err) => {
        console.error('[MC] Error:', err.message);
        if (rejectSpawn) {
            rejectSpawn(err);
            resolveSpawn = null;
            rejectSpawn = null;
        }
    });

    bot.on('end', (reason) => {
        console.log(`[MC] Disconnected: ${reason}`);
    });

    return {
        bot,
        connect(): Promise<void> {
            return new Promise((resolve, reject) => {
                resolveSpawn = resolve;
                rejectSpawn = reject;
            });
        },
        disconnect(): void {
            bot.quit('Companion shutting down');
        },
        setCompanion(companion: mineflayer.Bot | null): void {
            companionBot = companion;
        },
        setSkinUrl(url: string | null): void {
            pendingSkinUrl = url;
            if (url) {
                console.log(`[MC Skin] Skin URL set: ${url.substring(0, 80)}...`);
                // If already spawned and not yet applied, apply immediately
                if (botSpawned && !skinApplied) {
                    skinApplied = true;
                    applySkinCommand(bot, url);
                }
            } else {
                // Reset flag when skin is cleared (session end)
                skinApplied = false;
            }
        },
    };
}

/** Run SkinsRestorer /skin url command after a short delay */
function applySkinCommand(bot: mineflayer.Bot, url: string): void {
    setTimeout(() => {
        const cmd = `/skin url "${url}" classic`;
        console.log(`[MC Skin] Applying via SkinsRestorer: ${cmd}`);
        bot.chat(cmd);
    }, 300);
}
