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
        version: config.mc.version,
        hideErrors: false,
    });

    // Load pathfinder plugin
    bot.loadPlugin(pathfinder);

    bot.on('login', () => {
        console.log(`[MC] Logged in as ${bot.username}`);
    });

    bot.on('spawn', () => {
        console.log(`[MC] Spawned at ${bot.entity.position}`);

        // Configure pathfinder default movements
        const mcData = require('minecraft-data')(bot.version);
        const defaultMovements = new Movements(bot);
        defaultMovements.canDig = true;
        defaultMovements.allow1by1towers = true;
        defaultMovements.canOpenDoors = false; // broken for 2-block doors

        // Collect door block IDs
        const doorNames = [
            'oak_door', 'spruce_door', 'birch_door', 'jungle_door',
            'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door',
            'crimson_door', 'warped_door',
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

        // Auto-open doors: when bot is within 1 block of a closed door, open it
        let lastDoorOpen = 0;
        bot.on('physicsTick', () => {
            const now = performance.now();
            if (now - lastDoorOpen < 200) return; // cooldown

            const pos = bot.entity.position;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    for (let dy = 0; dy <= 1; dy++) {
                        const block = bot.blockAt(pos.offset(dx, dy, dz));
                        if (block && doorIds.has(block.type) && block.boundingBox === 'block') {
                            // Door is closed — open it
                            lastDoorOpen = now;
                            bot.activateBlock(block).catch(() => { });
                            return;
                        }
                    }
                }
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
