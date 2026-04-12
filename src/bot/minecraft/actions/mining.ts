import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { ToolCategory } from '../game-data';
import { getToolCategory, getBestTool, getToolIfStrongEnough } from './action-helpers.js';
import { getActionAbort, setSuppressPickups } from './action-state.js';
import { collectItems } from './movement.js';
import { getErrorMessage } from '../utils';

// ---- Minimal type for minecraft-data (loaded dynamically at runtime) ----

interface McBlockData {
    blocksByName: Record<string, { id: number; name: string } | undefined>;
    blocks: Record<number, { name?: string } | undefined>;
}

// ---- Block alias tables ----

const LOG_ALIASES = ['wood', 'log', 'tree', 'trees', 'any'];
const ALL_LOGS = [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
];

const MUSHROOM_ALIASES = ['mushroom', 'mushrooms'];
const ALL_MUSHROOMS = ['brown_mushroom', 'red_mushroom'];

const STONE_ALIASES = ['cobblestone', 'stone', 'cobble'];
const ALL_STONE = ['stone', 'cobblestone'];

const FLOWER_ALIASES = ['flower', 'flowers'];
const ALL_FLOWERS = [
    'poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet',
    'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
    'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
];

const BLOCK_ALIASES: Record<string, string> = {
    red_mushroom_block: 'red_mushroom',
    brown_mushroom_block: 'brown_mushroom',
    dirt: 'dirt',
    sand: 'sand',
    sugarcane: 'sugar_cane',
    sugar_cane: 'sugar_cane',
    cactus: 'cactus',
    bamboo: 'bamboo',
    melon: 'melon',
    pumpkin: 'pumpkin',
    kelp: 'kelp',
    vine: 'vine',
    vines: 'vine',
    tallgrass: 'tall_grass',
    tall_grass: 'tall_grass',
    grass: 'short_grass',
    cobblestone: 'cobblestone',  // handled by STONE_ALIASES above, kept as fallback
    stone: 'stone',              // handled by STONE_ALIASES above, kept as fallback
    clay: 'clay',
    gravel: 'gravel',
    // Crops and berries
    sweet_berries: 'sweet_berry_bush',
    sweet_berry: 'sweet_berry_bush',
    berries: 'sweet_berry_bush',
    berry: 'sweet_berry_bush',
    berry_bush: 'sweet_berry_bush',
    carrots: 'carrots',
    carrot: 'carrots',
    potatoes: 'potatoes',
    potato: 'potatoes',
    beetroots: 'beetroots',
    beetroot: 'beetroots',
};

const ITEM_HINTS: Record<string, string> = {
    string: 'String is not a block. Kill spiders to get string, or mine cobwebs with a sword.',
    stick: 'Sticks are not a block. Craft sticks from wooden planks (mc_craft item_name=stick).',
    sticks: 'Sticks are not a block. Craft sticks from wooden planks (mc_craft item_name=stick).',
    plank: 'Use mc_craft to make planks from logs (mc_craft item_name=oak_planks).',
    planks: 'Use mc_craft to make planks from logs (mc_craft item_name=oak_planks).',
    leather: 'Leather is not a block. Kill cows to get leather.',
    feather: 'Feathers are not blocks. Kill chickens to get feathers.',
    feathers: 'Feathers are not blocks. Kill chickens to get feathers.',
    bone: 'Bones are not blocks. Kill skeletons to get bones.',
    bones: 'Bones are not blocks. Kill skeletons to get bones.',
    gunpowder: 'Gunpowder is not a block. Kill creepers to get gunpowder.',
    ender_pearl: 'Ender pearls are not blocks. Kill endermen to get ender pearls.',
    blaze_rod: 'Blaze rods are not blocks. Kill blazes in the Nether to get blaze rods.',
    iron_ingot: 'Iron ingots are not blocks. Mine iron_ore and smelt it in a furnace.',
    gold_ingot: 'Gold ingots are not blocks. Mine gold_ore and smelt it in a furnace.',
    diamond: 'Diamonds are not blocks. Mine diamond_ore with an iron pickaxe or better.',
    coal: 'Coal is not a block. Mine coal_ore to get coal.',
    flint: 'Flint is not a block. Mine gravel — it has a chance to drop flint.',
    ink_sac: 'Ink sacs are not blocks. Kill squids to get ink sacs.',
    slime_ball: 'Slime balls are not blocks. Kill slimes to get slime balls.',
    spider_eye: 'Spider eyes are not blocks. Kill spiders to get spider eyes.',
    rotten_flesh: 'Rotten flesh is not a block. Kill zombies to get rotten flesh.',
    wool: 'Use mc_mine_block with the block name "white_wool" or kill sheep.',
    paper: 'Paper is not a block. Craft paper from sugar cane (mc_craft item_name=paper).',
};

// Block names that drop different items when mined
const BLOCK_DROP_NAMES: Record<string, string> = {
    stone: 'cobblestone',
    grass_block: 'dirt',
    coal_ore: 'coal',
    deepslate_coal_ore: 'coal',
    diamond_ore: 'diamond',
    deepslate_diamond_ore: 'diamond',
    emerald_ore: 'emerald',
    deepslate_emerald_ore: 'emerald',
    lapis_ore: 'lapis_lazuli',
    deepslate_lapis_ore: 'lapis_lazuli',
    redstone_ore: 'redstone',
    deepslate_redstone_ore: 'redstone',
    nether_quartz_ore: 'quartz',
    // Crops: block names are plural, item names are singular
    carrots: 'carrot',
    potatoes: 'potato',
    beetroots: 'beetroot',
    sweet_berry_bush: 'sweet_berries',
};

// ---- Block type resolution ----

interface BlockResolution {
    blockIds: number[];
    displayName: string;
}

function resolveBlockIds(mcData: McBlockData, names: string[]): number[] {
    return names
        .map((name) => mcData.blocksByName[name])
        .filter((b): b is { id: number; name: string } => b !== undefined)
        .map((b) => b.id);
}

/** Resolve user-facing block names (aliases, fuzzy matching) to Minecraft block IDs */
function resolveBlockType(mcData: McBlockData, blockType: string): BlockResolution | string {
    const lower = blockType.toLowerCase();

    if (LOG_ALIASES.includes(lower)) {
        const blockIds = resolveBlockIds(mcData, ALL_LOGS);
        if (blockIds.length === 0) return 'Cannot find any wood block types in this Minecraft version';
        return { blockIds, displayName: 'wood' };
    }
    if (MUSHROOM_ALIASES.includes(lower)) {
        const blockIds = resolveBlockIds(mcData, ALL_MUSHROOMS);
        if (blockIds.length === 0) return 'Cannot find any mushroom types in this Minecraft version';
        return { blockIds, displayName: 'mushroom' };
    }
    if (FLOWER_ALIASES.includes(lower)) {
        const blockIds = resolveBlockIds(mcData, ALL_FLOWERS);
        if (blockIds.length === 0) return 'Cannot find any flower types in this Minecraft version';
        return { blockIds, displayName: 'flower' };
    }
    if (STONE_ALIASES.includes(lower)) {
        const blockIds = resolveBlockIds(mcData, ALL_STONE);
        if (blockIds.length === 0) return 'Cannot find stone block types in this Minecraft version';
        return { blockIds, displayName: 'stone' };
    }

    // Try alias mapping first (AI often sends simplified names)
    const resolvedType = BLOCK_ALIASES[lower] ?? blockType;

    // Try the exact match first
    let blockInfo = mcData.blocksByName[resolvedType];
    // Fuzzy match: try common suffixes if exact fails
    if (!blockInfo) {
        const suffixes = ['_block', '_ore', '_log', '_planks', '_slab', '_stairs'];
        for (const suffix of suffixes) {
            blockInfo = mcData.blocksByName[resolvedType + suffix];
            if (blockInfo) break;
        }
    }
    if (!blockInfo) {
        const hint = ITEM_HINTS[lower];
        if (hint) return hint;
        return `Unknown block type: ${blockType}. This might be an item, not a block — only blocks placed in the world can be mined.`;
    }

    const blockIds = [blockInfo.id];

    // Also include deepslate ore variant (e.g. coal_ore -> deepslate_coal_ore)
    if (blockInfo.name.endsWith('_ore') && !blockInfo.name.startsWith('deepslate_')) {
        const deepslateVariant = mcData.blocksByName[`deepslate_${blockInfo.name}`];
        if (deepslateVariant) {
            blockIds.push(deepslateVariant.id);
        }
    }

    return { blockIds, displayName: blockType };
}

// ---- Tool validation and equipping ----

/** Check tool requirements and equip the best tool. Returns an error message or null on success. */
async function validateAndEquipTool(
    bot: Bot,
    toolCategory: ToolCategory,
    resolvedName: string,
    blockType: string,
): Promise<string | null> {
    if (toolCategory !== 'none') {
        const tool = getToolIfStrongEnough(bot, toolCategory, resolvedName);
        if (!tool) {
            // Check if they have ANY tool of the right type (just too weak)
            const weakTool = getBestTool(bot, toolCategory);
            if (weakTool) {
                return `Cannot mine ${blockType} with a ${weakTool.name} — need a stronger ${toolCategory}`;
            }
            return `Cannot mine ${blockType} without a ${toolCategory}`;
        }
        // Auto-equip the required tool
        try {
            await bot.equip(tool.item as number, 'hand');
            console.log(`[MC Action] Equipped ${tool.name}`);
        } catch (err) {
            const msg = getErrorMessage(err);
            console.error(`[MC Action] Failed to equip ${tool.name}:`, msg);
        }
    } else {
        // No tool required — but try to equip a preferred tool for speed
        // (e.g., axe for wood, shovel for dirt)
        const preferred =
            resolvedName.includes('log') || resolvedName.includes('planks')
                ? 'axe'
                : resolvedName.includes('dirt') || resolvedName.includes('sand') || resolvedName.includes('gravel')
                  ? 'shovel'
                  : null;
        if (preferred) {
            const tool = getBestTool(bot, preferred as ToolCategory);
            if (tool) {
                try {
                    await bot.equip(tool.item as number, 'hand');
                    console.log(`[MC Action] Equipped preferred tool ${tool.name}`);
                } catch {
                    /* not critical — mine with whatever is in hand */
                }
            }
        }
    }
    return null;
}

// ---- Drop name mapping ----

/** Build the set of item names that count as "mined" for inventory tracking */
function buildDropNameSet(mcData: McBlockData, blockIds: number[]): Set<string> {
    const itemNames = new Set<string>();
    for (const id of blockIds) {
        const blockInfo = mcData.blocks[id];
        if (blockInfo?.name) {
            itemNames.add(blockInfo.name);
            if (BLOCK_DROP_NAMES[blockInfo.name]) {
                itemNames.add(BLOCK_DROP_NAMES[blockInfo.name]);
            }
        }
    }
    return itemNames;
}

// ---- Candidate filtering and sorting ----

interface MiningContext {
    isTreeBlock: boolean;
    isStoneBlock: boolean;
    isOreBlock: boolean;
    anchorX: number;
    anchorY: number;
    anchorZ: number;
    failedPositions: Set<string>;
}

/** Horizontal (XZ-plane) distance between two positions */
function horizontalDist(a: Vec3, b: { x: number; z: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/** Filter candidates by reachability and sort by mining priority (trees bottom-up, stone quarry pattern, etc.) */
function filterAndSortCandidates(bot: Bot, candidates: Vec3[], ctx: MiningContext): Vec3[] {
    const botY = bot.entity.position.y;
    const botX = Math.floor(bot.entity.position.x);
    const botZ = Math.floor(bot.entity.position.z);
    const maxAbove = ctx.isTreeBlock ? 6 : 2;
    const maxBelow = ctx.isTreeBlock ? 3 : (ctx.isOreBlock ? 3 : 2);

    // Stone mining: use ANCHORED Y reference, so digging one block and falling
    // doesn't shift the "current level" and cause scattered holes.
    const refY = ctx.isStoneBlock ? ctx.anchorY : botY;
    const stoneMaxHDist = 4;

    return candidates
        .filter((pos) => {
            const key = `${pos.x},${pos.y},${pos.z}`;
            if (ctx.failedPositions.has(key)) return false;

            if (ctx.isStoneBlock) {
                // Only mine blocks within horizontal range of starting position
                const hDist = horizontalDist(pos, { x: ctx.anchorX, z: ctx.anchorZ });
                if (hDist > stoneMaxHDist) return false;
                // Mine stone within a reasonable Y range (surface stone can be
                // 2 blocks below bot when grass/dirt sits on top of it)
                const dy = pos.y - refY;
                if (dy > 2 || dy < -3) return false;
                // Don't mine directly below feet
                if (pos.y < Math.floor(botY) && pos.x === botX && pos.z === botZ) return false;
                return true;
            }

            const dy = pos.y - botY;
            if (dy > maxAbove || dy < -maxBelow) return false;
            // Don't mine directly below feet (safety) — but allow ores
            // since surface-exposed ore at feet level is common and safe
            if (!ctx.isOreBlock && dy < 0 && pos.x === botX && pos.z === botZ) return false;
            return true;
        })
        .sort((a, b) => {
            if (ctx.isTreeBlock) {
                const hDistA = horizontalDist(a, bot.entity.position);
                const hDistB = horizontalDist(b, bot.entity.position);
                const sameTreeA = hDistA <= 1.5;
                const sameTreeB = hDistB <= 1.5;
                if (sameTreeA && !sameTreeB) return -1;
                if (!sameTreeA && sameTreeB) return 1;
                if (sameTreeA && sameTreeB) return a.y - b.y;
                return hDistA - hDistB;
            }
            if (ctx.isStoneBlock) {
                // Quarry pattern: mine blocks at same level first (horizontal
                // distance), then go to the level below.
                const yA = Math.floor(a.y);
                const yB = Math.floor(b.y);
                const refFloorY = Math.floor(refY);
                // Same level as anchor first, then above, then below
                const levelA = yA >= refFloorY ? yA - refFloorY : (refFloorY - yA) + 100;
                const levelB = yB >= refFloorY ? yB - refFloorY : (refFloorY - yB) + 100;
                if (levelA !== levelB) return levelA - levelB;
                // Same level — closest to ANCHOR (ring pattern outward from start).
                // Tiebreaker: closest to bot's CURRENT position, so it doesn't
                // jump across the ring to the opposite side.
                const anchorDistA = horizontalDist(a, { x: ctx.anchorX, z: ctx.anchorZ });
                const anchorDistB = horizontalDist(b, { x: ctx.anchorX, z: ctx.anchorZ });
                const ringDiff = Math.floor(anchorDistA) - Math.floor(anchorDistB);
                if (ringDiff !== 0) return ringDiff;
                // Same ring — pick whichever is closer to the bot right now
                const botDistA = horizontalDist(a, bot.entity.position);
                const botDistB = horizontalDist(b, bot.entity.position);
                return botDistA - botDistB;
            }
            // Default: prioritize blocks at/above bot level over below
            const belowA = a.y < botY ? 1 : 0;
            const belowB = b.y < botY ? 1 : 0;
            if (belowA !== belowB) return belowA - belowB;
            const yPenaltyA = Math.abs(a.y - botY) * 16;
            const yPenaltyB = Math.abs(b.y - botY) * 16;
            const distA = bot.entity.position.distanceTo(a) + yPenaltyA;
            const distB = bot.entity.position.distanceTo(b) + yPenaltyB;
            return distA - distB;
        });
}

// ---- Main mining function ----

export async function mineBlock(
    bot: Bot,
    blockType: string | undefined,
    countStr: string | undefined,
): Promise<string> {
    if (!blockType) return 'No block type provided';
    // AI often sends display names with spaces ("copper ore") — normalize to Minecraft IDs
    blockType = blockType.trim().replace(/\s+/g, '_');

    const mcData: McBlockData = require('minecraft-data')(bot.version);

    // 1. Resolve block type aliases and fuzzy matching
    const resolution = resolveBlockType(mcData, blockType);
    if (typeof resolution === 'string') return resolution;
    const { blockIds, displayName } = resolution;

    // 2. Validate and equip the required tool
    const resolvedName = mcData.blocks[blockIds[0]]?.name ?? blockType;
    const toolCategory = getToolCategory(resolvedName);
    const toolError = await validateAndEquipTool(bot, toolCategory, resolvedName, blockType);
    if (toolError) return toolError;

    // 3. Setup: count, inventory tracking, abort signal
    const count = countStr ? parseInt(countStr, 10) : 5;
    const maxCount = Math.min(count, 32);
    let dug = 0;
    let attempts = 0;
    let consecutivePathFailures = 0;
    const MAX_ATTEMPTS = maxCount + 10;
    const MAX_CONSECUTIVE_PATH_FAILURES = 3;

    const itemNames = buildDropNameSet(mcData, blockIds);
    const countInventory = (): number => {
        return bot.inventory
            .items()
            .filter((item) => itemNames.has(item.name))
            .reduce((sum, item) => sum + item.count, 0);
    };
    const startCount = countInventory();

    console.log(`[MC Action] Collecting up to ${maxCount} ${displayName}...`);

    const signal = getActionAbort(bot).signal;

    // Block type flags and anchor position for candidate filtering
    const ctx: MiningContext = {
        isTreeBlock: resolvedName.includes('log'),
        isStoneBlock: STONE_ALIASES.includes(blockType.toLowerCase()),
        isOreBlock: resolvedName.endsWith('_ore'),
        anchorX: bot.entity.position.x,
        anchorY: bot.entity.position.y,
        anchorZ: bot.entity.position.z,
        failedPositions: new Set(),
    };

    // 4. Mining loop
    // Suppress per-item pickup notes during mining — the final summary is enough
    setSuppressPickups(bot, true);
    try {
    while (attempts < MAX_ATTEMPTS) {
        if (dug >= maxCount) break;
        if (signal.aborted) break;
        attempts++;

        // Find blocks nearby — use tighter radius for stone (stay in one area)
        const searchRadius = ctx.isStoneBlock ? 16 : 64;
        const candidates = bot.findBlocks({
            matching: blockIds,
            maxDistance: searchRadius,
            count: 32,
        });

        const reachable = filterAndSortCandidates(bot, candidates, ctx);

        // Stone mining diagnostics — log every iteration to debug hole pattern
        if (ctx.isStoneBlock && reachable.length > 0) {
            const refFloorY = Math.floor(ctx.anchorY);
            console.log(
                `[MC Mine] anchor=(${Math.floor(ctx.anchorX)},${Math.floor(ctx.anchorY)},${Math.floor(ctx.anchorZ)}) ` +
                `bot=(${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}) ` +
                `candidates=${candidates.length} reachable=${reachable.length}`,
            );
            const top5 = reachable.slice(0, 5);
            for (let i = 0; i < top5.length; i++) {
                const p = top5[i];
                const dy = p.y - refFloorY;
                const hDist = horizontalDist(p, { x: ctx.anchorX, z: ctx.anchorZ }).toFixed(1);
                console.log(`[MC Mine]   #${i}: (${p.x},${p.y},${p.z}) dy=${dy} hDist=${hDist}${i === 0 ? ' <- SELECTED' : ''}`);
            }
        }

        if (reachable.length === 0) {
            const botY = bot.entity.position.y;
            const maxAbove = ctx.isTreeBlock ? 6 : 2;
            const maxBelow = ctx.isTreeBlock ? 3 : (ctx.isOreBlock ? 3 : 2);
            console.log(
                `[MC Action] No reachable ${displayName}: ${candidates.length} candidates found, all filtered (botY=${Math.floor(botY)}, maxAbove=${maxAbove}, maxBelow=${maxBelow}, failed=${ctx.failedPositions.size})`,
            );
            if (candidates.length > 0) {
                const sample = candidates.slice(0, 3);
                for (const pos of sample) {
                    const dy = pos.y - botY;
                    const key = `${pos.x},${pos.y},${pos.z}`;
                    console.log(
                        `[MC Action]   candidate at ${pos.x},${pos.y},${pos.z} dy=${dy.toFixed(1)} failed=${ctx.failedPositions.has(key)}`,
                    );
                }
            }
            if (dug === 0) return `Searched around but couldn't find any reachable ${displayName} nearby`;
            break;
        }

        const blockPos = reachable[0];
        const posKey = `${blockPos.x},${blockPos.y},${blockPos.z}`;
        const block = bot.blockAt(blockPos);
        if (!block) {
            ctx.failedPositions.add(posKey);
            continue;
        }

        try {
            // Navigate to the block. For trees, stay at the starting ground level
            // (avoids pathfinder digging underground or climbing on top of leaves).
            const goalY = ctx.isTreeBlock ? Math.floor(ctx.anchorY) : block.position.y;
            const botPos = bot.entity.position;
            console.log(
                `[MC Mine] Attempt ${attempts}/${MAX_ATTEMPTS}: pathing to ${block.name} at (${blockPos.x},${blockPos.y},${blockPos.z}) ` +
                `goalY=${goalY} bot=(${Math.floor(botPos.x)},${Math.floor(botPos.y)},${Math.floor(botPos.z)}) ` +
                `dug=${dug}/${maxCount} failures=${consecutivePathFailures}`,
            );
            const pathPromise = bot.pathfinder.goto(new goals.GoalNear(block.position.x, goalY, block.position.z, 2));
            const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
            await Promise.race([pathPromise, timeout]);
            if (signal.aborted) break;

            // Re-equip the correct tool before digging (pathfinder may change held item)
            if (toolCategory !== 'none') {
                const tool = getBestTool(bot, toolCategory);
                if (!tool) {
                    // Tool broke mid-mining — stop, bare hands won't drop anything
                    const gained = countInventory() - startCount;
                    return gained > 0
                        ? `Collected ${gained} ${displayName} but the ${toolCategory} broke and there's no replacement`
                        : `The ${toolCategory} broke and there's no replacement — can't mine ${displayName} without one`;
                }
                try {
                    await bot.equip(tool.item as number, 'hand');
                } catch {
                    /* best effort */
                }
            }

            await bot.dig(block);
            dug++;

            // Brief pause to let items fall and auto-collect
            await new Promise((r) => setTimeout(r, 300));

            // For trees, collect dropped items every 5 logs instead of per-block
            if (ctx.isTreeBlock && dug % 5 === 0) {
                await collectItems(bot, null, 10);
            }

            if (!ctx.isTreeBlock) {
                // Walk to nearby dropped items for non-tree blocks
                const droppedItem = Object.values(bot.entities).find(
                    (e) =>
                        e.name === 'item' &&
                        (e.position.distanceTo(block.position) < 3 || e.position.distanceTo(bot.entity.position) < 4),
                );
                if (droppedItem) {
                    // Wait for playerCollect or timeout
                    const collectPromise = new Promise<void>((resolve) => {
                        const onCollect = (collector: { id: number }): void => {
                            if (collector.id === bot.entity.id) {
                                bot.removeListener('playerCollect', onCollect);
                                resolve();
                            }
                        };
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        bot.on('playerCollect', onCollect as any);
                        // Timeout — don't wait forever
                        setTimeout(() => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            bot.removeListener('playerCollect', onCollect as any);
                            resolve();
                        }, 2000);
                    });
                    // Walk to the item drop
                    try {
                        await bot.pathfinder.goto(
                            new goals.GoalBlock(
                                Math.floor(droppedItem.position.x),
                                Math.floor(droppedItem.position.y),
                                Math.floor(droppedItem.position.z),
                            ),
                        );
                    } catch {
                        // Item may have been auto-collected already
                    }
                    await collectPromise;
                }
            }

            console.log(`[MC Action] Dug ${block.name} (collected ${countInventory() - startCount}/${maxCount})`);
            consecutivePathFailures = 0;
        } catch (err) {
            // If we were canceled by a new action, exit cleanly without
            // touching pathfinder (the new action owns it now)
            if (signal.aborted) break;
            const message = getErrorMessage(err);
            console.warn(`[MC Action] Skipping block at ${posKey}: ${message}`);
            ctx.failedPositions.add(posKey);
            consecutivePathFailures++;
            if (consecutivePathFailures >= MAX_CONSECUTIVE_PATH_FAILURES) {
                console.warn(`[MC Action] ${MAX_CONSECUTIVE_PATH_FAILURES} consecutive path failures — aborting mining`);
                break;
            }
        }
    }

    // Collect dropped items after mining
    if (ctx.isTreeBlock && dug > 0 && !signal.aborted) {
        // Trees: logs pile up at the base — sweep them up in one pass
        await collectItems(bot, null, 10);
    } else {
        // Non-trees: wait briefly for straggler items to auto-collect
        await new Promise((r) => setTimeout(r, 2000));
    }

    } finally {
        setSuppressPickups(bot, false);
    }

    // If aborted (e.g., mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (dug === 0) return `Tried to collect ${displayName} but couldn't reach any`;
    const gained = countInventory() - startCount;
    const status = gained >= maxCount ? 'goal reached' : 'no more nearby';
    return `Collected ${gained} ${displayName} (${status})`;
}
