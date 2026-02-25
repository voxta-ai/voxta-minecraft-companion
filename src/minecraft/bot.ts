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
        bot.pathfinder.setMovements(defaultMovements);

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
