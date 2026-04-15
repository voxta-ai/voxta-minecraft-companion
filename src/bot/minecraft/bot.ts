import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements } = pathfinderPkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { CompanionConfig } from '../config.js';
import { DOOR_BLOCKS } from './game-data';
import { setupNaNGuards, setupDoorAutomation, setupAutoSwim, setupNonFullBlockGroundFix, setupStuckDetection, setupShelterProtection, handleTreeSpawn } from './bot-spawn-handlers';

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

    let subsystemsRegistered = false;

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


        // Collect door block IDs and patch the registry so open door states
        // have empty collision shapes. This fixes BOTH pathfinder AND physics
        // at the source — no per-block monkey-patching needed.
        const doorNames = DOOR_BLOCKS;
        const doorIds = new Set<number>();
        let patchedStates = 0;
        for (const name of doorNames) {
            const block = mcData.blocksByName[name];
            if (!block) continue;
            doorIds.add(block.id);
            defaultMovements.blocksCantBreak.add(block.id);

            // Patch ALL door stateShapes to empty collision.
            // The bot's block state cache is often stale on Paper — it reports
            // open=false for doors that are actually open. By clearing ALL states
            // (not just open=true), the physics engine won't block the bot at
            // doors regardless of cached state. The pathfinder already treats
            // doors as passable (getBlock override), and the auto-door handler
            // + narrow-passage recovery handle actually-closed doors.
            if (block.stateShapes) {
                for (let i = 0; i < block.stateShapes.length; i++) {
                    block.stateShapes[i] = [];
                    patchedStates++;
                }
            }
        }

        // Also patch physics collision shapes for doors
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bcsForDoors = (mcData as any).blockCollisionShapes;
        if (bcsForDoors && bcsForDoors.blocks && bcsForDoors.shapes) {
            for (const name of doorNames) {
                const shapeRef = bcsForDoors.blocks[name];
                if (shapeRef !== undefined) {
                    if (Array.isArray(shapeRef)) {
                        for (const idx of shapeRef) {
                            bcsForDoors.shapes[String(idx)] = [];
                        }
                    } else {
                        bcsForDoors.shapes[String(shapeRef)] = [];
                    }
                }
            }
        }
        console.log(`[MC] Registered ${doorIds.size} door types, patched ${patchedStates} door collision states (all passable)`);

        // Patch non-full-height blocks (dirt_path, farmland = 15/16) to full
        // collision height. Without this, the 1/16-block step between these
        // blocks and adjacent full blocks causes the bot to clip at narrow
        // entrances (e.g. shelter doorframes with shoveled ground).
        //
        // Two registries must be patched:
        //  1. block.stateShapes — used by mineflayer-pathfinder for path planning
        //  2. mcData.blockCollisionShapes — used by prismarine-physics for collision
        const NON_FULL_BLOCKS = ['dirt_path', 'farmland'];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bcs = (mcData as any).blockCollisionShapes;
        const fullBlockShape = [[0, 0, 0, 1, 1, 1]];

        for (const name of NON_FULL_BLOCKS) {
            const block = mcData.blocksByName[name];
            if (!block) continue;

            // Patch stateShapes (pathfinder)
            if (block.stateShapes) {
                for (let i = 0; i < block.stateShapes.length; i++) {
                    block.stateShapes[i] = fullBlockShape;
                }
                console.log(`[MC] Patched ${name} stateShapes to full height (${block.stateShapes.length} states)`);
            }

            // Patch blockCollisionShapes (physics engine)
            if (bcs && bcs.blocks && bcs.shapes) {
                const shapeRef = bcs.blocks[name];
                if (shapeRef !== undefined) {
                    // shapeRef can be a number (single state) or array (multi-state)
                    if (Array.isArray(shapeRef)) {
                        // Multi-state: each entry is a shape index
                        for (const idx of shapeRef) {
                            bcs.shapes[String(idx)] = fullBlockShape;
                        }
                        console.log(`[MC] Patched ${name} physics collision (${shapeRef.length} state shapes)`);
                    } else {
                        // Single state: one shape index
                        bcs.shapes[String(shapeRef)] = fullBlockShape;
                        console.log(`[MC] Patched ${name} physics collision (shape index ${shapeRef})`);
                    }
                } else {
                    console.warn(`[MC] WARNING: ${name} not found in blockCollisionShapes.blocks`);
                }
            } else {
                console.warn(`[MC] WARNING: blockCollisionShapes not available — ${name} collision NOT patched`);
            }
        }

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
            defaultMovements.exclusionAreasStep.push((block: any) => {
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
            });
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

        // Register spawn-time subsystems (each is self-contained).
        // Guard: only register once — the 'spawn' event fires on every respawn
        // (death, SkinsRestorer skin apply, dimension change). Without this guard,
        // each respawn adds DUPLICATE physicsTick handlers that fight each other.
        if (!subsystemsRegistered) {
            subsystemsRegistered = true;
            setupNaNGuards(bot);
            setupDoorAutomation(bot, doorIds);
            setupAutoSwim(bot);
            setupNonFullBlockGroundFix(bot);
            setupStuckDetection(bot, doorIds);
            setupShelterProtection(bot, doorIds);
        }
        handleTreeSpawn(bot);

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
