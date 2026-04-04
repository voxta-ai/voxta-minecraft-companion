import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { CompanionConfig } from '../config.js';

export interface MinecraftBot {
    bot: mineflayer.Bot;
    connect(): Promise<void>;
    disconnect(): void;
}

export function createMinecraftBot(config: CompanionConfig): MinecraftBot {
    let resolveSpawn: (() => void) | null = null;
    let rejectSpawn: ((err: Error) => void) | null = null;

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

        bot.pathfinder.setMovements(defaultMovements);

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

        bot.on('physicsTick', () => {
            const isMoving = bot.pathfinder.isMoving();
            const forwardOn = bot.getControlState('forward');
            const pos = bot.entity.position;

            if (!isMoving || !forwardOn) {
                stuckSince = null;
                lastMovePos = pos.clone();
                return;
            }

            const moved = pos.distanceTo(lastMovePos);
            if (moved > 0.1) {
                stuckSince = null;
                lastMovePos = pos.clone();
                return;
            }

            const now = performance.now();
            if (stuckSince === null) {
                stuckSince = now;
                return;
            }

            if (now - stuckSince > 1500) {
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
                stuckSince = null;
                lastMovePos = pos.clone();
            }
        });

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
    };
}
