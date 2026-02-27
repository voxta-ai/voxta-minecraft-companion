import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import type { Entity } from 'prismarine-entity';
import type { ActionInvocationArgument, ScenarioAction } from '../voxta/types.js';
import type { NameRegistry } from '../name-registry';

// ---- Action definitions for Voxta registration ----

export const MINECRAFT_ACTIONS: ScenarioAction[] = [
    {
        name: 'mc_follow_player',
        description: 'Follow a player and stay near them',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'player_name', type: 'String', description: 'Name of the player to follow', required: true },
        ],
    },
    {
        name: 'mc_go_to',
        description: 'Navigate to specific coordinates',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'x', type: 'String', description: 'X coordinate', required: true },
            { name: 'y', type: 'String', description: 'Y coordinate', required: true },
            { name: 'z', type: 'String', description: 'Z coordinate', required: true },
        ],
    },
    {
        name: 'mc_mine_block',
        description: 'Find and mine a specific type of block',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'block_type', type: 'String', description: 'Type of block to mine. Use "wood" or "log" for any nearby tree, or a specific block like oak_log, stone, iron_ore', required: true },
            { name: 'count', type: 'String', description: 'Number of blocks to mine', required: false },
        ],
    },
    {
        name: 'mc_attack',
        description: 'Attack the nearest entity of a given type',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'entity_name', type: 'String', description: 'Name of entity to attack (e.g. zombie, skeleton, spider)', required: true },
        ],
    },
    {
        name: 'mc_look_at',
        description: 'Turn to look at a player',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'player_name', type: 'String', description: 'Name of the player to look at', required: true },
        ],
    },
    {
        name: 'mc_stop',
        description: 'Stop the current action and stand still',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
    },
    {
        name: 'mc_equip',
        description: 'Equip an item from inventory',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Name of the item to equip (e.g. iron_axe, diamond_pickaxe)', required: true },
        ],
    },
    {
        name: 'mc_give_item',
        description: 'Give/toss items to a nearby player',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Name of the item to give', required: true },
            { name: 'player_name', type: 'String', description: 'Name of the player to give items to', required: true },
            { name: 'count', type: 'String', description: 'Number of items to give', required: false },
        ],
    },
    {
        name: 'mc_collect_items',
        description: 'Pick up nearby dropped items from the ground',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
    },
    {
        name: 'mc_eat',
        description: 'Eat food from inventory to restore hunger. Will eat the best food available.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'food_name', type: 'String', description: 'Specific food to eat (optional, will pick best available if not specified)', required: false },
        ],
    },
    {
        name: 'mc_none',
        description: 'ONLY use when just talking and absolutely no game action is needed. Do NOT use if the player asked you to do something.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
    },
    {
        name: 'mc_sleep',
        description: 'Find a nearby bed and sleep in it. Only works at night.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
    },
    {
        name: 'mc_wake',
        description: 'Wake up and get out of bed.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
    },
    {
        name: 'mc_cook',
        description: 'Cook raw food in a nearby furnace. Needs fuel (wood/coal) in inventory.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Raw food to cook (optional, will cook whatever is available)', required: false },
        ],
    },
    {
        name: 'mc_craft',
        description: 'Craft an item using materials in inventory. Needs a crafting table nearby for tools/weapons.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Item to craft (e.g. wooden_sword, stone_pickaxe, oak_planks, sticks, crafting_table, furnace)', required: true },
            { name: 'count', type: 'String', description: 'How many to craft (default: 1)', required: false },
        ],
    },
];

// ---- Tool requirements ----

type ToolCategory = 'axe' | 'pickaxe' | 'shovel' | 'none';

/** Maps block names to the tool required to mine them */
const TOOL_REQUIREMENTS: Record<string, ToolCategory> = {
    // Wood → axe
    oak_log: 'axe', birch_log: 'axe', spruce_log: 'axe', jungle_log: 'axe',
    acacia_log: 'axe', dark_oak_log: 'axe', mangrove_log: 'axe', cherry_log: 'axe',
    oak_planks: 'axe', birch_planks: 'axe', spruce_planks: 'axe', jungle_planks: 'axe',
    // Stone/Ores → pickaxe
    stone: 'pickaxe', cobblestone: 'pickaxe', deepslate: 'pickaxe',
    iron_ore: 'pickaxe', gold_ore: 'pickaxe', diamond_ore: 'pickaxe',
    coal_ore: 'pickaxe', copper_ore: 'pickaxe', lapis_ore: 'pickaxe',
    redstone_ore: 'pickaxe', emerald_ore: 'pickaxe', nether_quartz_ore: 'pickaxe',
    netherrack: 'pickaxe', obsidian: 'pickaxe', andesite: 'pickaxe',
    diorite: 'pickaxe', granite: 'pickaxe',
    // Dirt/Sand → no tool required
    dirt: 'none', sand: 'none', gravel: 'none', clay: 'none',
    grass_block: 'none',
};

const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

function getToolCategory(blockName: string): ToolCategory {
    return TOOL_REQUIREMENTS[blockName] ?? 'none';
}

function getBestTool(bot: Bot, category: ToolCategory): { item: unknown; name: string } | null {
    if (category === 'none') return null;

    const items = bot.inventory.items();
    for (const tier of TOOL_TIERS) {
        const toolName = `${tier}_${category}`;
        const found = items.find((item) => item.name === toolName);
        if (found) return { item: found, name: toolName };
    }
    return null;
}

// ---- Action execution ----

/** Strip type annotations, leading '=' and surrounding quotes from argument values.
 *  Handles LLM quirks like: '="Lapiro"', 'string = "oak_log"', 'string="oak_log', '"value"' */
function cleanArgValue(raw: string): string {
    let val = raw.trim();
    // If the value contains '=', take everything after the last '='
    // This handles patterns like 'string = "oak_log"' or 'string="oak_log'
    const eqIdx = val.lastIndexOf('=');
    if (eqIdx >= 0) {
        val = val.slice(eqIdx + 1).trim();
    }
    // Strip leading and trailing quotes (handles both balanced and unbalanced)
    while (val.startsWith('"') || val.startsWith("'")) val = val.slice(1);
    while (val.endsWith('"') || val.endsWith("'")) val = val.slice(0, -1);
    return val.trim();
}

function getArg(args: ActionInvocationArgument[] | undefined, name: string): string | undefined {
    const raw = args?.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
    return raw ? cleanArgValue(raw) : undefined;
}

function findPlayerEntity(bot: Bot, playerName: string, names: NameRegistry): Entity | undefined {
    // Resolve Voxta name → MC username
    const mcName = names.resolveToMc(playerName);

    return Object.values(bot.entities).find(
        (e) => e.type === 'player' &&
            e !== bot.entity &&
            e.username?.toLowerCase() === mcName.toLowerCase()
    );
}

// Shared cancellation signal for long-running actions
let actionAbort = new AbortController();

export async function executeAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> {
    try {
        switch (actionName) {
            case 'mc_follow_player':
                return await followPlayer(bot, getArg(args, 'player_name'), names);

            case 'mc_go_to':
                return await goTo(
                    bot,
                    getArg(args, 'x'),
                    getArg(args, 'y'),
                    getArg(args, 'z'),
                );

            case 'mc_mine_block':
                return await mineBlock(
                    bot,
                    getArg(args, 'block_type'),
                    getArg(args, 'count'),
                );

            case 'mc_attack':
                return await attackEntity(bot, getArg(args, 'entity_name'), names);


            case 'mc_look_at':
                return await lookAtPlayer(bot, getArg(args, 'player_name'), names);

            case 'mc_stop':
                actionAbort.abort();
                actionAbort = new AbortController();
                bot.pathfinder.stop();
                bot.stopDigging();
                return 'Stopped current action';

            case 'mc_equip':
                return await equipItem(bot, getArg(args, 'item_name'));

            case 'mc_give_item':
                return await giveItem(bot, getArg(args, 'item_name'), getArg(args, 'player_name'), getArg(args, 'count'), names);

            case 'mc_collect_items':
                return await collectItems(bot);

            case 'mc_eat':
                return await eatFood(bot, getArg(args, 'food_name'));

            case 'mc_none':
                return ''; // No-op — AI acknowledged, nothing to do

            case 'mc_sleep':
                return await sleepInBed(bot);

            case 'mc_wake':
                if (bot.isSleeping) {
                    bot.wake();
                    return 'Woke up and got out of bed';
                }
                return 'Not currently sleeping';

            case 'mc_cook':
                return await cookFood(bot, getArg(args, 'item_name'));

            case 'mc_craft':
                return await craftItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            default:
                return `Unknown action: ${actionName}`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Error executing ${actionName}:`, message);
        return `Failed to execute ${actionName}: ${message}`;
    }
}

// ---- Armor slot detection ----

/** Determine the correct equipment slot for an item */
function getEquipSlot(itemName: string): 'head' | 'torso' | 'legs' | 'feet' | 'hand' {
    if (itemName.includes('helmet') || itemName.includes('cap')) return 'head';
    if (itemName.includes('chestplate') || itemName.includes('tunic')) return 'torso';
    if (itemName.includes('leggings') || itemName.includes('pants')) return 'legs';
    if (itemName.includes('boots')) return 'feet';
    return 'hand';
}

async function equipItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const item = bot.inventory.items().find(
        (i) => i.name.toLowerCase().includes(itemName.toLowerCase()),
    );
    if (!item) return `No ${itemName} found in inventory`;

    const slot = getEquipSlot(item.name);
    try {
        await bot.equip(item.type, slot);
        const slotLabel = slot === 'hand' ? 'hand' : `${slot} armor slot`;
        return `Equipped ${item.displayName ?? item.name} in ${slotLabel}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to equip ${item.name}: ${message}`;
    }
}

// ---- Individual action implementations ----

async function followPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Remember current hand item before pathfinder changes it
    const heldItem = bot.heldItem;

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true); // dynamic = true → keeps following

    // Re-equip previous item (pathfinder tends to switch held item)
    if (heldItem) {
        try {
            await bot.equip(heldItem.type, 'hand');
        } catch {
            // Best effort — item might have been consumed
        }
    }

    return `Following ${displayName}`;
}

async function goTo(
    bot: Bot,
    xStr: string | undefined,
    yStr: string | undefined,
    zStr: string | undefined,
): Promise<string> {
    if (!xStr || !yStr || !zStr) return 'Missing coordinates';

    const x = parseFloat(xStr);
    const y = parseFloat(yStr);
    const z = parseFloat(zStr);

    if (isNaN(x) || isNaN(y) || isNaN(z)) return 'Invalid coordinates';

    const goal = new goals.GoalBlock(x, y, z);
    bot.pathfinder.setGoal(goal);
    return `Navigating to ${x}, ${y}, ${z}`;
}

async function mineBlock(
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
        // Try exact match first
        let blockInfo = mcData.blocksByName[blockType];
        // Fuzzy match: try common suffixes if exact fails
        if (!blockInfo) {
            const suffixes = ['_block', '_ore', '_log', '_planks', '_slab', '_stairs'];
            for (const suffix of suffixes) {
                blockInfo = mcData.blocksByName[blockType + suffix];
                if (blockInfo) break;
            }
        }
        if (!blockInfo) return `Unknown block type: ${blockType}`;
        blockIds = [blockInfo.id];
        displayName = blockType;
    }

    // Check tool requirements
    const toolCategory = getToolCategory(blockType);
    if (toolCategory !== 'none') {
        const tool = getBestTool(bot, toolCategory);
        if (!tool) {
            return `Cannot mine ${blockType}: no ${toolCategory} in inventory. Need a ${toolCategory} to mine this block.`;
        }
        // Auto-equip the best tool
        try {
            await bot.equip(tool.item as number, 'hand');
            console.log(`[MC Action] Equipped ${tool.name}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[MC Action] Failed to equip ${tool.name}:`, msg);
        }
    }

    const count = countStr ? parseInt(countStr, 10) : 5;
    const maxCount = Math.min(count, 16);
    let mined = 0;
    let attempts = 0;
    const MAX_ATTEMPTS = maxCount + 5;
    const failedPositions = new Set<string>();

    console.log(`[MC Action] Mining up to ${maxCount} ${displayName} blocks...`);

    const signal = actionAbort.signal;

    while (mined < maxCount && attempts < MAX_ATTEMPTS) {
        if (signal.aborted) break;
        attempts++;

        // Find blocks within reach (max 2 blocks above bot — no pillaring needed)
        const candidates = bot.findBlocks({
            matching: blockIds,
            maxDistance: 32,
            count: 20,
        });

        // Filter: reachable height + not already failed
        const botY = bot.entity.position.y;
        const reachable = candidates
            .filter((pos) => {
                const key = `${pos.x},${pos.y},${pos.z}`;
                return pos.y - botY <= 2 && !failedPositions.has(key);
            })
            .sort((a, b) => {
                const distA = bot.entity.position.distanceTo(a);
                const distB = bot.entity.position.distanceTo(b);
                return distA - distB;
            });

        if (reachable.length === 0) {
            if (mined === 0) return `Cannot find any reachable ${displayName} nearby`;
            break;
        }

        const blockPos = reachable[0];
        const posKey = `${blockPos.x},${blockPos.y},${blockPos.z}`;
        const block = bot.blockAt(blockPos);
        if (!block) { failedPositions.add(posKey); continue; }

        try {
            // Use GoalNear to get within 2 blocks, then dig
            const pathPromise = bot.pathfinder.goto(
                new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
            );
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 15000),
            );
            await Promise.race([pathPromise, timeout]);
            if (signal.aborted) break;
            await bot.dig(block);
            mined++;
            console.log(`[MC Action] Mined ${block.name} (${mined}/${maxCount})`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[MC Action] Skipping block at ${posKey}: ${message}`);
            bot.pathfinder.stop();
            failedPositions.add(posKey);
        }
    }

    if (mined === 0) return `Failed to mine any ${displayName} (stuck or unreachable)`;
    return `Mined ${mined} ${displayName} block${mined > 1 ? 's' : ''}`;
}

async function attackEntity(bot: Bot, entityName: string | undefined, names: NameRegistry): Promise<string> {
    if (!entityName) return 'No entity name provided';

    // Resolve name through registry (handles both Voxta→MC and already-MC names)
    const mcName = names.resolveToMc(entityName);

    const target = bot.nearestEntity(
        (e) => e !== bot.entity && (
            e.username?.toLowerCase() === mcName.toLowerCase() ||
            e.name?.toLowerCase() === mcName.toLowerCase() ||
            e.displayName?.toLowerCase() === mcName.toLowerCase() ||
            e.username?.toLowerCase() === entityName.toLowerCase() ||
            e.name?.toLowerCase() === entityName.toLowerCase() ||
            e.displayName?.toLowerCase() === entityName.toLowerCase()
        )
    );

    if (!target) return `Cannot find ${names.resolveToVoxta(names.resolveToMc(entityName))} nearby`;

    const displayName = names.resolveToVoxta(names.resolveToMc(entityName));

    // Follow and attack until dead
    const goal = new goals.GoalFollow(target, 2);
    bot.pathfinder.setGoal(goal, true);

    const startTime = Date.now();
    const TIMEOUT_MS = 30000; // 30 seconds max combat

    return new Promise<string>((resolve) => {
        const signal = actionAbort.signal;
        const attackLoop = setInterval(() => {
            // Check if cancelled
            if (signal.aborted) {
                clearInterval(attackLoop);
                bot.pathfinder.stop();
                resolve(`Stopped attacking ${displayName}`);
                return;
            }

            // Check if target is dead (entity removed from world)
            if (!bot.entities[target.id]) {
                clearInterval(attackLoop);
                bot.pathfinder.stop();
                resolve(`Killed ${displayName}`);
                return;
            }

            // Timeout — stop chasing
            if (Date.now() - startTime > TIMEOUT_MS) {
                clearInterval(attackLoop);
                bot.pathfinder.stop();
                resolve(`Stopped attacking ${displayName} (timeout)`);
                return;
            }

            // Attack if in range
            const dist = target.position.distanceTo(bot.entity.position);
            if (dist < 3.5) {
                bot.attack(target);
            }
        }, 500); // MC attack cooldown is ~500ms
    });
}

async function lookAtPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Initial look
    await bot.lookAt(player.position.offset(0, 1.6, 0));

    // Continuously track the player until another action cancels us
    const signal = actionAbort.signal;
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

    return `Tracking ${displayName}`;
}


async function giveItem(
    bot: Bot,
    itemName: string | undefined,
    playerName: string | undefined,
    countStr: string | undefined,
    names: NameRegistry,
): Promise<string> {
    if (!itemName) return 'No item name provided';
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return `No ${itemName} in inventory`;

    const count = countStr ? Math.min(parseInt(countStr, 10), item.count) : item.count;

    // Walk to the player first
    try {
        await bot.pathfinder.goto(new goals.GoalFollow(player, 2));
    } catch {
        // Best effort approach
    }

    try {
        await bot.toss(item.type, null, count);
        return `Gave ${count} ${itemName} to ${displayName}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to give ${itemName}: ${message}`;
    }
}

async function collectItems(bot: Bot): Promise<string> {
    const items = Object.values(bot.entities).filter(
        (e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 32
    );

    if (items.length === 0) return 'No dropped items nearby';

    let collected = 0;
    for (const item of items.slice(0, 5)) {
        try {
            await bot.pathfinder.goto(new goals.GoalBlock(
                Math.floor(item.position.x),
                Math.floor(item.position.y),
                Math.floor(item.position.z),
            ));
            collected++;
        } catch {
            // Item may have despawned
        }
    }

    return `Collected ${collected} dropped item${collected !== 1 ? 's' : ''}`;
}

// Food items sorted by hunger restoration (best first)
const FOOD_ITEMS: Record<string, number> = {
    golden_carrot: 6, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6,
    cooked_salmon: 6, cooked_chicken: 6, cooked_rabbit: 5, cooked_cod: 5,
    bread: 5, baked_potato: 5, beetroot_soup: 6, mushroom_stew: 6,
    rabbit_stew: 10, suspicious_stew: 6, pumpkin_pie: 8, cake: 2,
    apple: 4, melon_slice: 2, sweet_berries: 2, glow_berries: 2,
    carrot: 3, potato: 1, beetroot: 1, dried_kelp: 1, cookie: 2,
    beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3,
    cod: 2, salmon: 2, tropical_fish: 1,
    rotten_flesh: 4, spider_eye: 2, // edible but risky
};

async function eatFood(bot: Bot, foodName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    let foodItem;
    if (foodName) {
        // Eat specific food
        foodItem = items.find((i) => i.name === foodName);
        if (!foodItem) return `No ${foodName} in inventory`;
    } else {
        // Find best food in inventory
        const foodItems = items
            .filter((i) => i.name in FOOD_ITEMS)
            .sort((a, b) => (FOOD_ITEMS[b.name] ?? 0) - (FOOD_ITEMS[a.name] ?? 0));
        foodItem = foodItems[0];
        if (!foodItem) return 'No food in inventory';
    }

    try {
        await bot.equip(foodItem.type, 'hand');
        await bot.consume();
        return `Ate ${foodItem.displayName ?? foodItem.name} (hunger restored)`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to eat ${foodItem.name}: ${message}`;
    }
}

const BED_BLOCKS = [
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
    'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
    'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
];

async function sleepInBed(bot: Bot): Promise<string> {
    // Find nearest bed
    const bedBlock = bot.findBlock({
        matching: (block) => BED_BLOCKS.includes(block.name),
        maxDistance: 32,
    });

    if (!bedBlock) return 'No bed found nearby';

    // Walk to the bed
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the bed';
    }

    // Try to sleep
    try {
        await bot.sleep(bedBlock);
        return 'Went to sleep in bed';
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not night')) return 'Cannot sleep, it is not night time yet';
        if (message.includes('occupied')) return 'Cannot sleep, the bed is occupied';
        if (message.includes('monsters')) return 'Cannot sleep, there are monsters nearby';
        return `Cannot sleep: ${message}`;
    }
}

// ---- Cooking ----

/** Raw items that can be smelted in a furnace */
const COOKABLE_ITEMS: Record<string, string> = {
    beef: 'cooked_beef',
    porkchop: 'cooked_porkchop',
    chicken: 'cooked_chicken',
    mutton: 'cooked_mutton',
    rabbit: 'cooked_rabbit',
    cod: 'cooked_cod',
    salmon: 'cooked_salmon',
    potato: 'baked_potato',
    kelp: 'dried_kelp',
};

/** Items that work as furnace fuel, sorted by burn time (best first) */
const FUEL_ITEMS = [
    'coal', 'charcoal', 'coal_block',
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log',
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'stick',
];

async function cookFood(bot: Bot, itemName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    // Find cookable item
    let rawItem;
    if (itemName) {
        rawItem = items.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()) && i.name in COOKABLE_ITEMS);
        if (!rawItem) {
            // Maybe they gave us the exact name
            rawItem = items.find((i) => i.name in COOKABLE_ITEMS && i.name.includes(itemName.toLowerCase()));
        }
        if (!rawItem) return `No cookable ${itemName} in inventory`;
    } else {
        rawItem = items.find((i) => i.name in COOKABLE_ITEMS);
        if (!rawItem) return 'No raw food to cook in inventory';
    }

    // Find fuel
    const fuelItem = items.find((i) => FUEL_ITEMS.includes(i.name));
    if (!fuelItem) return 'No fuel in inventory (need coal, wood, or planks)';

    // Find nearby furnace
    const furnaceBlock = bot.findBlock({
        matching: (block) => block.name === 'furnace' || block.name === 'smoker' || block.name === 'blast_furnace',
        maxDistance: 32,
    });
    if (!furnaceBlock) return 'No furnace found nearby';

    // Walk to furnace
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the furnace';
    }

    // Open furnace and cook
    try {
        const furnace = await bot.openFurnace(furnaceBlock);
        const cookCount = Math.min(rawItem.count, 8); // Cook up to 8 at a time

        // Take any existing output first
        if (furnace.outputItem()) {
            await furnace.takeOutput();
        }

        // Only add fuel if the fuel slot is empty
        if (!furnace.fuelItem()) {
            await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, cookCount));
        }
        // Put raw food in
        await furnace.putInput(rawItem.type, null, cookCount);

        console.log(`[MC Action] Cooking ${cookCount} ${rawItem.name}...`);

        // Wait for cooking (10 seconds per item in furnace, 5 in smoker)
        const isSmoker = furnaceBlock.name === 'smoker';
        const cookTimeMs = (isSmoker ? 5000 : 10000) * cookCount;
        await new Promise((resolve) => setTimeout(resolve, cookTimeMs + 1000));

        // Take output
        const output = furnace.outputItem();
        if (output) {
            await furnace.takeOutput();
        }

        furnace.close();

        const cookedName = COOKABLE_ITEMS[rawItem.name] ?? 'cooked food';
        return `Cooked ${cookCount} ${cookedName.replace(/_/g, ' ')}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to cook: ${message}`;
    }
}

// ---- Crafting ----

/** Common name aliases to real item names */
const CRAFT_ALIASES: Record<string, string> = {
    planks: 'oak_planks',
    sticks: 'stick',
    stick: 'stick',
    'wooden sword': 'wooden_sword',
    'wooden axe': 'wooden_axe',
    'wooden pickaxe': 'wooden_pickaxe',
    'wooden shovel': 'wooden_shovel',
    'stone sword': 'stone_sword',
    'stone axe': 'stone_axe',
    'stone pickaxe': 'stone_pickaxe',
    'stone shovel': 'stone_shovel',
    'iron sword': 'iron_sword',
    'iron axe': 'iron_axe',
    'iron pickaxe': 'iron_pickaxe',
    'iron shovel': 'iron_shovel',
    'crafting table': 'crafting_table',
    workbench: 'crafting_table',
    chest: 'chest',
    furnace: 'furnace',
    torch: 'torch',
    torches: 'torch',
    shield: 'shield',
    bucket: 'bucket',
    bowl: 'bowl',
    bread: 'bread',
    boat: 'oak_boat',
};

async function craftItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const mcData = require('minecraft-data')(bot.version);
    const count = countStr ? parseInt(countStr, 10) : 1;

    // Resolve name
    const resolved = CRAFT_ALIASES[itemName.toLowerCase()] ?? itemName.toLowerCase().replace(/ /g, '_');
    const itemInfo = mcData.itemsByName[resolved] as { id: number; displayName: string; name: string } | undefined;
    if (!itemInfo) return `Unknown item: ${itemName}`;

    // Try crafting without a table first (2x2 recipes like planks, sticks)
    let recipes = bot.recipesFor(itemInfo.id, null, 1, null);

    if (recipes.length === 0) {
        // Need a crafting table — find one nearby
        const craftingTable = bot.findBlock({
            matching: (block) => block.name === 'crafting_table',
            maxDistance: 32,
        });

        if (!craftingTable) {
            return `Cannot craft ${itemInfo.displayName}: no crafting table nearby and recipe requires one`;
        }

        // Walk to crafting table
        try {
            await bot.pathfinder.goto(
                new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2),
            );
        } catch {
            return 'Cannot reach the crafting table';
        }

        recipes = bot.recipesFor(itemInfo.id, null, 1, craftingTable);
        if (recipes.length === 0) {
            return `Cannot craft ${itemInfo.displayName}: missing materials`;
        }

        // Craft with table
        try {
            await bot.craft(recipes[0], count, craftingTable);
            return `Crafted ${count} ${itemInfo.displayName}`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to craft ${itemInfo.displayName}: ${message}`;
        }
    }

    // Craft without table (2x2)
    try {
        await bot.craft(recipes[0], count);
        return `Crafted ${count} ${itemInfo.displayName}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to craft ${itemInfo.displayName}: ${message}`;
    }
}
