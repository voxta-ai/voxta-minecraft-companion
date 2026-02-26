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
        name: 'mc_say',
        description: 'Say a message in Minecraft chat',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'message', type: 'String', description: 'Message to say in game chat', required: true },
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

            case 'mc_say': {
                const message = getArg(args, 'message');
                if (message) {
                    bot.chat(message);
                    return `Said: "${message}"`;
                }
                return 'No message provided';
            }

            case 'mc_look_at':
                return await lookAtPlayer(bot, getArg(args, 'player_name'), names);

            case 'mc_stop':
                bot.pathfinder.stop();
                return 'Stopped current action';

            case 'mc_equip':
                return await equipItem(bot, getArg(args, 'item_name'));

            case 'mc_give_item':
                return await giveItem(bot, getArg(args, 'item_name'), getArg(args, 'player_name'), getArg(args, 'count'), names);

            case 'mc_collect_items':
                return await collectItems(bot);

            default:
                return `Unknown action: ${actionName}`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Error executing ${actionName}:`, message);
        return `Failed to execute ${actionName}: ${message}`;
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
        const blockInfo = mcData.blocksByName[blockType];
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

    console.log(`[MC Action] Mining up to ${maxCount} ${blockType} blocks...`);

    for (let i = 0; i < maxCount; i++) {
        const block = bot.findBlock({
            matching: blockIds,
            maxDistance: 64,
        });

        if (!block) {
            if (mined === 0) return `Cannot find any ${displayName} nearby`;
            break;
        }

        try {
            await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
            await bot.dig(block);
            mined++;
            console.log(`[MC Action] Mined ${block.name} (${mined}/${maxCount})`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[MC Action] Mining failed:`, message);
            if (mined === 0) return `Failed to mine ${displayName}: ${message}`;
            break;
        }
    }

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

    // Move toward and attack
    const goal = new goals.GoalFollow(target, 2);
    bot.pathfinder.setGoal(goal, true);

    // Wait to get in range then attack
    const waitForRange = (): Promise<void> => {
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                if (target.position.distanceTo(bot.entity.position) < 3.5) {
                    clearInterval(interval);
                    resolve();
                }
            }, 200);

            // Timeout after 10 seconds
            setTimeout(() => {
                clearInterval(interval);
                resolve();
            }, 10000);
        });
    };

    await waitForRange();
    bot.attack(target);
    const displayName = names.resolveToVoxta(names.resolveToMc(entityName));
    return `Attacking ${displayName}`;
}

async function lookAtPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    await bot.lookAt(player.position.offset(0, 1.6, 0));
    return `Looking at ${displayName}`;
}

async function equipItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return `No ${itemName} in inventory`;

    try {
        await bot.equip(item, 'hand');
        return `Equipped ${itemName}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to equip ${itemName}: ${message}`;
    }
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

