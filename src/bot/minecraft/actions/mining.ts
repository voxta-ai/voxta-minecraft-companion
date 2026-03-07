import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { ToolCategory } from '../game-data';
import { getToolCategory, getBestTool } from './action-helpers.js';
import { getActionAbort } from './action-state.js';

export async function mineBlock(
    bot: Bot,
    blockType: string | undefined,
    countStr: string | undefined,
): Promise<string> {
    if (!blockType) return 'No block type provided';

    const mcData = require('minecraft-data')(bot.version);

    // Aliases: "wood", "log", "tree" → find any nearby log type
    const LOG_ALIASES = ['wood', 'log', 'tree', 'trees', 'any'];
    const ALL_LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];

    let blockIds: number[];
    let displayName: string;

    if (LOG_ALIASES.includes(blockType.toLowerCase())) {
        // Match any log type
        blockIds = ALL_LOGS
            .map((name) => mcData.blocksByName[name] as { id: number } | undefined)
            .filter((b): b is { id: number } => b !== undefined)
            .map((b) => b.id);
        displayName = 'wood';
        if (blockIds.length === 0) return 'Cannot find any wood block types in this Minecraft version';
    } else {
        // Try alias mapping first (AI often sends simplified names)
        const BLOCK_ALIASES: Record<string, string> = {
            mushroom: 'brown_mushroom',
            mushrooms: 'brown_mushroom',
            red_mushroom_block: 'red_mushroom',
            brown_mushroom_block: 'brown_mushroom',
            flower: 'poppy',
            flowers: 'poppy',
            dirt: 'dirt',
            sand: 'sand',
        };
        const resolvedType = BLOCK_ALIASES[blockType.toLowerCase()] ?? blockType;

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
            // Helpful hints for common items that aren't blocks
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
            const hint = ITEM_HINTS[blockType.toLowerCase()];
            if (hint) return hint;
            return `Unknown block type: ${blockType}. This may be an item, not a block. Only blocks in the world can be mined.`;
        }
        blockIds = [blockInfo.id];
        displayName = blockType;

        // Also include deepslate ore variant (e.g. coal_ore → deepslate_coal_ore)
        const matchedName = (blockInfo as { name: string }).name;
        if (matchedName.endsWith('_ore') && !matchedName.startsWith('deepslate_')) {
            const deepslateVariant = mcData.blocksByName[`deepslate_${matchedName}`];
            if (deepslateVariant) {
                blockIds.push(deepslateVariant.id);
            }
        }
    }

    // Check tool requirements (use resolved block name, not raw input)
    const resolvedName = (mcData.blocks[blockIds[0]] as { name?: string })?.name ?? blockType;
    const toolCategory = getToolCategory(resolvedName);
    if (toolCategory !== 'none') {
        const tool = getBestTool(bot, toolCategory);
        if (!tool) {
            return `Cannot mine ${blockType}: no ${toolCategory} in inventory. Need a ${toolCategory} to mine this block.`;
        }
        // Auto-equip the required tool
        try {
            await bot.equip(tool.item as number, 'hand');
            console.log(`[MC Action] Equipped ${tool.name}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MC Action] Failed to equip ${tool.name}:`, msg);
        }
    } else {
        // No tool required — but try to equip a preferred tool for speed
        // (e.g., axe for wood, shovel for dirt)
        const preferred = resolvedName.includes('log') || resolvedName.includes('planks') ? 'axe'
            : resolvedName.includes('dirt') || resolvedName.includes('sand') || resolvedName.includes('gravel') ? 'shovel'
                : null;
        if (preferred) {
            const tool = getBestTool(bot, preferred as ToolCategory);
            if (tool) {
                try {
                    await bot.equip(tool.item as number, 'hand');
                    console.log(`[MC Action] Equipped preferred tool ${tool.name}`);
                } catch { /* not critical — mine with whatever is in hand */ }
            }
        }
    }

    const count = countStr ? parseInt(countStr, 10) : 5;
    const maxCount = Math.min(count, 32);
    let dug = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = maxCount + 10;
    const failedPositions = new Set<string>();

    // Build item name set for inventory matching — block names usually match
    // item names, but some have different drops (e.g., stone → cobblestone)
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
    const itemNames = new Set<string>();
    for (const id of blockIds) {
        const blockInfo = mcData.blocks[id] as { name?: string } | undefined;
        if (blockInfo?.name) {
            itemNames.add(blockInfo.name);
            // Also add the known drop name if different
            if (BLOCK_DROP_NAMES[blockInfo.name]) {
                itemNames.add(BLOCK_DROP_NAMES[blockInfo.name]);
            }
        }
    }

    // Snapshot inventory before mining so we count actual items gained
    const countInventory = (): number => {
        return bot.inventory.items()
            .filter((item) => itemNames.has(item.name))
            .reduce((sum, item) => sum + item.count, 0);
    };
    const startCount = countInventory();

    console.log(`[MC Action] Collecting up to ${maxCount} ${displayName}...`);

    const signal = getActionAbort().signal;

    while (attempts < MAX_ATTEMPTS) {
        // Check if we've dug enough blocks
        if (dug >= maxCount) break;
        if (signal.aborted) break;
        attempts++;

        // Find blocks nearby
        const candidates = bot.findBlocks({
            matching: blockIds,
            maxDistance: 64,
            count: 32,
        });

        // Trees (logs): 6 above, 3 below (handles terrain where base is lower).
        // Other blocks: max 2 above, max 1 below (avoid digging straight down).
        const botY = bot.entity.position.y;
        const botX = Math.floor(bot.entity.position.x);
        const botZ = Math.floor(bot.entity.position.z);
        const isTreeBlock = resolvedName.includes('log');
        const maxAbove = isTreeBlock ? 6 : 2;
        const maxBelow = isTreeBlock ? 3 : 1;
        const reachable = candidates
            .filter((pos) => {
                const key = `${pos.x},${pos.y},${pos.z}`;
                const dy = pos.y - botY;
                if (dy > maxAbove || dy < -maxBelow) return false;
                if (failedPositions.has(key)) return false;
                // Don't mine directly below feet (safety: lava, void, etc.)
                if (dy < 0 && pos.x === botX && pos.z === botZ) return false;
                return true;
            })
            .sort((a, b) => {
                if (isTreeBlock) {
                    const hDistA = Math.sqrt((a.x - bot.entity.position.x) ** 2 + (a.z - bot.entity.position.z) ** 2);
                    const hDistB = Math.sqrt((b.x - bot.entity.position.x) ** 2 + (b.z - bot.entity.position.z) ** 2);
                    const sameTreeA = hDistA <= 1.5;
                    const sameTreeB = hDistB <= 1.5;
                    if (sameTreeA && !sameTreeB) return -1;
                    if (!sameTreeA && sameTreeB) return 1;
                    if (sameTreeA && sameTreeB) return a.y - b.y;
                    return hDistA - hDistB;
                }
                // Prioritize blocks at/above bot level over below
                const belowA = a.y < botY ? 1 : 0;
                const belowB = b.y < botY ? 1 : 0;
                if (belowA !== belowB) return belowA - belowB;
                const yPenaltyA = Math.abs(a.y - botY) * 16;
                const yPenaltyB = Math.abs(b.y - botY) * 16;
                const distA = bot.entity.position.distanceTo(a) + yPenaltyA;
                const distB = bot.entity.position.distanceTo(b) + yPenaltyB;
                return distA - distB;
            });

        if (reachable.length === 0) {
            console.log(`[MC Action] No reachable ${displayName}: ${candidates.length} candidates found, all filtered (botY=${Math.floor(botY)}, maxAbove=${maxAbove}, maxBelow=${maxBelow}, failed=${failedPositions.size})`);
            if (candidates.length > 0) {
                // Log why the first few were filtered
                const sample = candidates.slice(0, 3);
                for (const pos of sample) {
                    const dy = pos.y - botY;
                    const key = `${pos.x},${pos.y},${pos.z}`;
                    console.log(`[MC Action]   candidate at ${pos.x},${pos.y},${pos.z} dy=${dy.toFixed(1)} failed=${failedPositions.has(key)}`);
                }
            }
            if (dug === 0) return `Cannot find any reachable ${displayName} nearby`;
            break;
        }

        const blockPos = reachable[0];
        const posKey = `${blockPos.x},${blockPos.y},${blockPos.z}`;
        const block = bot.blockAt(blockPos);
        if (!block) { failedPositions.add(posKey); continue; }

        try {
            // Navigate to the block. For trees, stay at ground level and reach up
            // (avoids pathfinder climbing on top of leaves to reach upper logs).
            const goalY = isTreeBlock ? Math.floor(botY) : block.position.y;
            const pathPromise = bot.pathfinder.goto(
                new goals.GoalNear(block.position.x, goalY, block.position.z, 2),
            );
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 15000),
            );
            await Promise.race([pathPromise, timeout]);
            if (signal.aborted) break;

            // Re-equip the correct tool before digging (pathfinder may change held item)
            if (toolCategory !== 'none') {
                const tool = getBestTool(bot, toolCategory);
                if (tool) {
                    try { await bot.equip(tool.item as number, 'hand'); } catch { /* best effort */ }
                }
            }

            await bot.dig(block);
            dug++;

            // Brief pause to let items fall and auto-collect
            await new Promise((r) => setTimeout(r, 300));

            // Walk to nearby dropped items (check near bot AND near block — items
            // from upper tree blocks fall to ground level, far from block position)
            const droppedItem = Object.values(bot.entities).find(
                (e) => e.name === 'item'
                    && (e.position.distanceTo(block.position) < 3
                        || e.position.distanceTo(bot.entity.position) < 4),
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
                    await bot.pathfinder.goto(new goals.GoalBlock(
                        Math.floor(droppedItem.position.x),
                        Math.floor(droppedItem.position.y),
                        Math.floor(droppedItem.position.z),
                    ));
                } catch {
                    // Item may have been auto-collected already
                }
                await collectPromise;
            }

            console.log(`[MC Action] Dug ${block.name} (collected ${countInventory() - startCount}/${maxCount})`);
        } catch (err) {
            // If we were canceled by a new action, exit cleanly without
            // touching pathfinder (the new action owns it now)
            if (signal.aborted) break;
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[MC Action] Skipping block at ${posKey}: ${message}`);
            failedPositions.add(posKey);
        }
    }

    // Wait briefly for any remaining items to be auto-collected
    await new Promise((r) => setTimeout(r, 1000));

    // If aborted (e.g., mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (dug === 0) return `Failed to collect any ${displayName} (stuck or unreachable)`;
    const status = dug >= maxCount ? 'goal reached' : 'no more nearby';
    return `Collected ${dug} ${displayName} (${status})`;
}
