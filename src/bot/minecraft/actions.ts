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
            { name: 'block_type', type: 'String', description: 'Type of block to mine (e.g. oak_log, stone, iron_ore)', required: true },
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
];

// ---- Action execution ----

function getArg(args: ActionInvocationArgument[] | undefined, name: string): string | undefined {
    return args?.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value;
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
                return await attackEntity(bot, getArg(args, 'entity_name'));

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
    if (!player) return `Cannot find player "${playerName}" (mc: "${names.resolveToMc(playerName)}") nearby`;

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true); // dynamic = true → keeps following
    return `Following ${playerName}`;
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
    const blockInfo = mcData.blocksByName[blockType];
    if (!blockInfo) return `Unknown block type: ${blockType}`;

    const count = countStr ? parseInt(countStr, 10) : 1;

    console.log(`[MC Action] Looking for ${blockType} (id=${blockInfo.id}) within 64 blocks...`);

    const block = bot.findBlock({
        matching: blockInfo.id,
        maxDistance: 64,
    });

    if (!block) return `Cannot find any ${blockType} nearby`;

    console.log(`[MC Action] Found ${blockType} at ${block.position}, navigating...`);

    // Navigate to the block and mine it
    try {
        await bot.pathfinder.goto(new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        console.log(`[MC Action] Reached block, digging...`);
        await bot.dig(block);
        console.log(`[MC Action] Successfully mined ${blockType}`);
        return `Mined ${blockType} at ${block.position}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Mining failed:`, message);
        return `Failed to mine ${blockType}: ${message}`;
    }
}

async function attackEntity(bot: Bot, entityName: string | undefined): Promise<string> {
    if (!entityName) return 'No entity name provided';

    const target = bot.nearestEntity(
        (e) => (e.name?.toLowerCase() === entityName.toLowerCase() ||
            e.displayName?.toLowerCase() === entityName.toLowerCase()) &&
            e !== bot.entity
    );

    if (!target) return `Cannot find ${entityName} nearby`;

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
    return `Attacking ${entityName}`;
}

async function lookAtPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    if (!player) return `Cannot find player "${playerName}" (mc: "${names.resolveToMc(playerName)}") nearby`;

    await bot.lookAt(player.position.offset(0, 1.6, 0));
    return `Looking at ${playerName}`;
}
