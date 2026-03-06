import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entity } from 'prismarine-entity';
import type { ActionInvocationArgument } from '../voxta/types.js';
import type { NameRegistry } from '../name-registry';
import type { ToolCategory } from './action-definitions';
import {
    MINECRAFT_ACTIONS,
    TOOL_REQUIREMENTS,
    TOOL_TIERS,
    FOOD_ITEMS,
    COOKABLE_ITEMS,
    FUEL_ITEMS,
    BED_BLOCKS,
    CRAFT_ALIASES,
} from './action-definitions';

// Re-export so existing consumers keep working
export { MINECRAFT_ACTIONS };

// ---- Tool helpers ----

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

/** Find the best weapon in inventory: swords first, then axes, then other tools as fallback */
function getBestWeapon(bot: Bot): { item: unknown; name: string } | null {
    const items = bot.inventory.items();
    // Priority: swords (best damage) → axes → pickaxes → shovels
    for (const weaponType of ['sword', 'axe', 'pickaxe', 'shovel']) {
        for (const tier of TOOL_TIERS) {
            const weaponName = `${tier}_${weaponType}`;
            const found = items.find((item) => item.name === weaponName);
            if (found) return { item: found, name: weaponName };
        }
    }
    return null;
}

// ---- Argument helpers ----

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

// ---- Armor slot detection ----

/** Determine the correct equipment slot for an item */
function getEquipSlot(itemName: string): 'head' | 'torso' | 'legs' | 'feet' | 'hand' {
    if (itemName.includes('helmet') || itemName.includes('cap')) return 'head';
    if (itemName.includes('chestplate') || itemName.includes('tunic')) return 'torso';
    if (itemName.includes('leggings') || itemName.includes('pants')) return 'legs';
    if (itemName.includes('boots')) return 'feet';
    return 'hand';
}

// ---- Action execution ----

// Shared cancellation signal for long-running actions
let actionAbort = new AbortController();

// Tracks whether a physical action is running (mining, following, etc.)
let actionBusy = false;
export function isActionBusy(): boolean { return actionBusy; }

// Suppress pickup notes during inventory management (equip/unequip in crafting)
let suppressPickups = false;
export function isPickupSuppressed(): boolean { return suppressPickups; }

// Human-readable description of what the bot is currently doing
let currentActivity: string | null = null;
export function getCurrentActivity(): string | null { return currentActivity; }
export function setCurrentActivity(activity: string | null): void { currentActivity = activity; }

// Current combat target — used to prevent duplicate mc_attack from cancelling
// an ongoing fight (e.g. auto-defense + AI action both targeting the same mob)
let currentCombatTarget: string | null = null;
export function getCurrentCombatTarget(): string | null { return currentCombatTarget; }

// Fishing progress callback — called per catch so bot-engine can send voice chance notifications
let onFishCaught: ((itemName: string, count: number) => void) | null = null;
export function setFishCaughtCallback(cb: ((itemName: string, count: number) => void) | null): void {
    onFishCaught = cb;
}

// Saved home/bed position — persisted to a JSON file keyed by server address
let homePosition: { x: number; y: number; z: number } | null = null;
let homeServerKey: string | null = null;
export function getHomePosition(): { x: number; y: number; z: number } | null { return homePosition; }

const HOME_FILE = join(process.cwd(), 'bot-home.json');

interface HomeData {
    [serverKey: string]: { x: number; y: number; z: number };
}

function loadHomeData(): HomeData {
    try {
        return JSON.parse(readFileSync(HOME_FILE, 'utf-8')) as HomeData;
    } catch {
        return {};
    }
}

function saveHomeData(data: HomeData): void {
    try {
        mkdirSync(join(HOME_FILE, '..'), { recursive: true });
        writeFileSync(HOME_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.error('[MC Action] Failed to save home data:', err);
    }
}

/** Call after bot connects to load any saved home position for this server */
export function initHomePosition(host: string, port: number): void {
    homeServerKey = `${host}:${port}`;
    const data = loadHomeData();
    const saved = data[homeServerKey];
    if (saved) {
        homePosition = saved;
        console.log(`[MC Action] Loaded home position for ${homeServerKey}: ${saved.x}, ${saved.y}, ${saved.z}`);
    } else {
        homePosition = null;
        console.log(`[MC Action] No saved home position for ${homeServerKey}`);
    }
}

export async function executeAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> {
    // Look up action metadata to decide behavior
    const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);

    // If we're already fighting this exact target (e.g. auto-defense), skip entirely
    // — don't abort the ongoing fight just to restart the same attack.
    if (actionName === 'mc_attack') {
        const attackTarget = (getArg(args, 'entity_name') ?? 'enemy').toLowerCase();
        if (currentCombatTarget && currentCombatTarget === attackTarget) {
            return `Already fighting ${attackTarget}`;
        }
    }

    if (actionDef?.isPhysical) {
        // Cancel any running action before starting a new one
        actionAbort.abort();
        actionAbort = new AbortController();
        try { bot.stopDigging(); } catch { /* may not be digging */ }
        // Retract fishing rod if actively fishing
        if (currentActivity === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
            bot.activateItem();
        }
    }

    // Track busy state for physical actions (except stop which clears it)
    const shouldTrackBusy = actionDef?.isPhysical && actionName !== 'mc_stop';
    if (shouldTrackBusy) actionBusy = true;

    try {
        switch (actionName) {
            case 'mc_follow_player': {
                const followTarget = getArg(args, 'player_name') ?? 'player';
                currentActivity = `following ${followTarget}`;
                return await followPlayer(bot, getArg(args, 'player_name'), names);
            }

            case 'mc_go_to': {
                const gx = getArg(args, 'x'), gy = getArg(args, 'y'), gz = getArg(args, 'z');
                currentActivity = `navigating to ${gx ?? '?'},${gy ?? '?'},${gz ?? '?'}`;
                return await goTo(bot, gx, gy, gz);
            }

            case 'mc_go_home':
                currentActivity = 'heading home';
                return await goHome(bot);

            case 'mc_mine_block': {
                const blockArg = getArg(args, 'block_type') ?? 'blocks';
                currentActivity = `mining ${blockArg}`;
                return await mineBlock(bot, getArg(args, 'block_type'), getArg(args, 'count'));
            }

            case 'mc_attack': {
                const attackTarget = getArg(args, 'entity_name') ?? 'enemy';
                currentActivity = `fighting ${attackTarget}`;
                return await attackEntity(bot, getArg(args, 'entity_name'), names);
            }


            case 'mc_look_at':
                return await lookAtPlayer(bot, getArg(args, 'player_name'), names);

            case 'mc_stop':
                // mc_stop is not isPhysical (so it doesn't trigger the generic abort above),
                // but it MUST abort any running action's signal explicitly
                actionAbort.abort();
                actionAbort = new AbortController();
                bot.pathfinder.stop();
                try { bot.stopDigging(); } catch { /* may not be digging */ }
                try { bot.deactivateItem(); } catch { /* may not be using an item */ }
                // Retract fishing rod if actively fishing (check BEFORE clearing activity)
                if (currentActivity === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
                    bot.activateItem();
                }
                currentActivity = null;
                return 'Stopped current action';

            case 'mc_equip':
                return await equipItem(bot, getArg(args, 'item_name'));

            case 'mc_give_item':
                return await giveItem(bot, getArg(args, 'item_name'), getArg(args, 'player_name'), getArg(args, 'count'), names);

            case 'mc_collect_items':
                currentActivity = 'collecting nearby items';
                return await collectItems(bot);

            case 'mc_eat':
                currentActivity = 'eating';
                return await eatFood(bot, getArg(args, 'food_name'));

            case 'mc_none':
                return ''; // No-op — AI acknowledged, nothing to do

            case 'mc_sleep':
                currentActivity = 'going to sleep';
                return await sleepInBed(bot);

            case 'mc_wake':
                if (bot.isSleeping) {
                    bot.wake();
                    return 'Woke up and got out of bed';
                }
                return 'Not currently sleeping';

            case 'mc_set_home':
                currentActivity = 'setting home';
                return await setHome(bot);

            case 'mc_cook':
                currentActivity = 'cooking';
                return await cookFood(bot, getArg(args, 'item_name'));

            case 'mc_craft': {
                const craftTarget = getArg(args, 'item_name') ?? 'item';
                currentActivity = `crafting ${craftTarget}`;
                return await craftItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
            }

            case 'mc_place_block': {
                const blockTarget = getArg(args, 'block_name') ?? 'block';
                currentActivity = `placing ${blockTarget}`;
                return await placeBlock(bot, getArg(args, 'block_name'));
            }

            case 'mc_store_item':
                currentActivity = 'storing items in chest';
                return await storeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_take_item':
                currentActivity = 'taking items from chest';
                return await takeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_inspect':
                return await inspectContainer(bot, getArg(args, 'target'));

            case 'mc_toss':
                return await tossItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_fish':
                currentActivity = 'fishing';
                return await fishAction(bot, getArg(args, 'count'));

            case 'mc_use_item':
                return await useHeldItem(bot, getArg(args, 'item_name'));

            default:
                return `Unknown action: ${actionName}`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Error executing ${actionName}:`, message);
        return `Failed to execute ${actionName}: ${message}`;
    } finally {
        if (shouldTrackBusy) {
            actionBusy = false;
            // Only clear activity for non-quick actions (they run to completion).
            // Quick actions (follow, look_at) persist after returning — their
            // activity is cleared when a new action starts or mc_stop is called.
            if (!actionDef?.isQuick) {
                currentActivity = null;
            }
        }
    }
}

// ---- Individual action implementations ----

async function followPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Re-equip previous item BEFORE setting goal (equip can interrupt pathfinder)
    const heldItem = bot.heldItem;
    if (heldItem) {
        try {
            await bot.equip(heldItem.type, 'hand');
        } catch {
            // Best effort — item might have been consumed
        }
    }

    // Flush any pending pathfinder stop — pathfinder.stop() sets an internal
    // "stopPathing" flag. If we call setGoal() while that flag is true, resetPath()
    // sees it and immediately nullifies our new goal. Setting null first clears it.
    bot.pathfinder.setGoal(null);

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true); // dynamic = true → keeps following
    console.log(`[MC Action] Follow goal set for ${displayName}, goal active: ${!!bot.pathfinder.goal}`);

    return `Following ${displayName}`;
}

/**
 * Resume following a player after auto-defense WITHOUT going through executeAction.
 * executeAction's physical action handling (actionAbort.abort(), actionBusy) interferes
 * with the pathfinder after combat. This function directly sets the goal.
 */
export function resumeFollowPlayer(bot: Bot, playerName: string, names: NameRegistry): string {
    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Flush pending stop flag (see comment in followPlayer above)
    bot.pathfinder.setGoal(null);

    const goal = new goals.GoalFollow(player, 3);
    bot.pathfinder.setGoal(goal, true);
    console.log(`[MC Action] Resume follow goal set for ${displayName}, goal active: ${!!bot.pathfinder.goal}`);

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
    await bot.pathfinder.goto(goal);
    return `Arrived at ${x}, ${y}, ${z}`;
}

async function goHome(bot: Bot): Promise<string> {
    if (!homePosition) return 'No home bed set yet. I need to sleep in a bed first to remember where home is.';

    const dx = bot.entity.position.x - homePosition.x;
    const dy = bot.entity.position.y - homePosition.y;
    const dz = bot.entity.position.z - homePosition.z;
    const distance = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
    console.log(`[MC Action] Going home to bed at ${homePosition.x}, ${homePosition.y}, ${homePosition.z} (${distance} blocks away)`);

    const goal = new goals.GoalNear(homePosition.x, homePosition.y, homePosition.z, 2);
    await bot.pathfinder.goto(goal);
    return `Arrived home at ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`;
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

        // Try exact match first
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
        // (e.g. axe for wood, shovel for dirt)
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
    // item names, but some have different drops (e.g. stone → cobblestone)
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

    const signal = actionAbort.signal;

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
            // If we were cancelled by a new action, exit cleanly without
            // touching pathfinder (the new action owns it now)
            if (signal.aborted) break;
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[MC Action] Skipping block at ${posKey}: ${message}`);
            failedPositions.add(posKey);
        }
    }

    // Wait briefly for any remaining items to be auto-collected
    await new Promise((r) => setTimeout(r, 1000));

    // If aborted (e.g. mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (dug === 0) return `Failed to collect any ${displayName} (stuck or unreachable)`;
    const status = dug >= maxCount ? 'goal reached' : 'no more nearby';
    return `Collected ${dug} ${displayName} (${status})`;
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

    // Auto-equip best weapon before fighting
    const weapon = getBestWeapon(bot);
    if (weapon) {
        try {
            await bot.equip(weapon.item as number, 'hand');
            console.log(`[MC Action] Equipped ${weapon.name} for combat`);
        } catch {
            // Best effort — continue fighting regardless
        }
    }

    // Auto-equip shield in off-hand if available
    let hasShield = false;
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (shield) {
        try {
            await bot.equip(shield, 'off-hand');
            hasShield = true;
            console.log('[MC Action] Equipped shield for combat');
        } catch {
            // Best effort
        }
    }

    // Track combat target to prevent duplicate attacks from cancelling this fight
    const normalizedTarget = (entityName ?? 'unknown').toLowerCase();
    currentCombatTarget = normalizedTarget;

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
                if (currentCombatTarget === normalizedTarget) currentCombatTarget = null;
                // Don't call pathfinder.stop() — the new action owns it now
                resolve(`Stopped attacking ${displayName}`);
                return;
            }

            // Check if target is dead (entity removed from world)
            if (!bot.entities[target.id]) {
                clearInterval(attackLoop);
                currentCombatTarget = null;
                bot.pathfinder.stop();
                resolve(`Killed ${displayName}`);
                return;
            }

            // Timeout — stop chasing
            if (Date.now() - startTime > TIMEOUT_MS) {
                clearInterval(attackLoop);
                currentCombatTarget = null;
                bot.pathfinder.stop();
                resolve(`Stopped attacking ${displayName} (timeout)`);
                return;
            }

            // Attack if in range
            const dist = target.position.distanceTo(bot.entity.position);
            if (dist < 3.5) {
                // Lower shield briefly to attack
                if (hasShield) bot.deactivateItem();
                bot.attack(target);
                // Raise shield again after swing
                if (hasShield) {
                    setTimeout(() => { bot.activateItem(true); }, 100);
                }
            } else if (hasShield) {
                // Keep shield raised while approaching
                bot.activateItem(true);
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

    // Check item exists before walking
    const checkItem = bot.inventory.items().find((i) => i.name === itemName);
    if (!checkItem) return `No ${itemName} in inventory`;

    const count = countStr ? Math.min(parseInt(countStr, 10), checkItem.count) : checkItem.count;

    // Walk to the player first (use GoalNear so we stop when close)
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(player.position.x, player.position.y, player.position.z, 2),
        );
    } catch {
        // Best effort approach
    }

    // Re-find item fresh — inventory may have changed during walk
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return `No ${itemName} in inventory (lost while walking)`;

    const actualCount = Math.min(count, item.count);

    try {
        // Look at the player so items are tossed toward them
        await bot.lookAt(player.position.offset(0, 1, 0));
        await bot.toss(item.type, null, actualCount);
        return `Gave ${actualCount} ${itemName} to ${displayName}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to give ${itemName}: ${message}`;
    }
}

async function storeItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    // Find nearby chest
    const chestBlock = bot.findBlock({
        matching: (block) => block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel',
        maxDistance: 32,
    });
    if (!chestBlock) return 'No chest found nearby';

    // Walk to the chest
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the chest';
    }

    try {
        const container = await bot.openContainer(chestBlock);
        let stored = 0;

        if (itemName.toLowerCase() === 'all') {
            // Store everything in inventory
            const items = bot.inventory.items();
            for (const item of items) {
                try {
                    await container.deposit(item.type, null, item.count);
                    stored += item.count;
                } catch {
                    // Chest might be full
                    break;
                }
            }
            container.close();
            if (stored === 0) return 'Could not store any items (chest may be full)';
            return `Stored ${stored} items in the chest`;
        } else {
            // Store specific item
            const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
            if (!item) {
                container.close();
                return `No ${itemName} in inventory`;
            }
            const count = countStr ? Math.min(parseInt(countStr, 10), item.count) : item.count;
            await container.deposit(item.type, null, count);
            container.close();
            return `Stored ${count} ${item.name.replace(/_/g, ' ')} in the chest`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to store items: ${message}`;
    }
}

async function takeItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    // Find nearby chest
    const chestBlock = bot.findBlock({
        matching: (block) => block.name === 'chest' || block.name === 'trapped_chest' || block.name === 'barrel',
        maxDistance: 32,
    });
    if (!chestBlock) return 'No chest found nearby';

    // Walk to the chest
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the chest';
    }

    try {
        const container = await bot.openContainer(chestBlock);

        // Find the item in the chest's slots
        const chestItems = container.containerItems();
        const item = chestItems.find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
        if (!item) {
            container.close();
            return `No ${itemName} found in the chest`;
        }

        const count = countStr ? Math.min(parseInt(countStr, 10), item.count) : item.count;
        await container.withdraw(item.type, null, count);
        container.close();
        return `Took ${count} ${item.name.replace(/_/g, ' ')} from the chest`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to take items: ${message}`;
    }
}

async function inspectContainer(bot: Bot, target: string | undefined): Promise<string> {
    if (!target) return 'No target specified. Use "chest", "furnace", "barrel", or "inventory"';

    const t = target.toLowerCase();

    // Inspect own inventory
    if (t === 'inventory' || t === 'self' || t === 'me') {
        const items = bot.inventory.items();
        if (items.length === 0) return 'Inventory is empty';
        const list = items.map((i) => `${i.count}x ${i.name.replace(/_/g, ' ')}`).join(', ');
        return `Inventory contains: ${list}`;
    }

    // Determine which block type to look for
    const blockMatchers: Record<string, (name: string) => boolean> = {
        chest: (name) => name === 'chest' || name === 'trapped_chest',
        furnace: (name) => name === 'furnace' || name === 'smoker' || name === 'blast_furnace',
        barrel: (name) => name === 'barrel',
        crafting_table: (name) => name === 'crafting_table',
    };

    const matcher = blockMatchers[t];
    if (!matcher) {
        // Try to match any container
        const allMatcher = (name: string): boolean =>
            name === 'chest' || name === 'trapped_chest' || name === 'barrel'
            || name === 'furnace' || name === 'smoker' || name === 'blast_furnace'
            || name === 'crafting_table';
        return await doInspect(bot, allMatcher, target);
    }

    // Crafting table is not a container — just confirm it exists
    if (t === 'crafting_table') {
        const block = bot.findBlock({
            matching: (b) => b.name === 'crafting_table',
            maxDistance: 32,
        });
        if (!block) return 'No crafting table found nearby';
        const dist = Math.round(block.position.distanceTo(bot.entity.position));
        return `Crafting table found ${dist} blocks away (crafting tables don't store items)`;
    }

    return await doInspect(bot, matcher, t);
}

async function doInspect(bot: Bot, matcher: (name: string) => boolean, label: string): Promise<string> {
    const block = bot.findBlock({
        matching: (b) => matcher(b.name),
        maxDistance: 32,
    });
    if (!block) return `No ${label} found nearby`;

    // Walk to it
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2),
        );
    } catch {
        return `Cannot reach the ${label}`;
    }

    // Furnace has special slots
    if (block.name === 'furnace' || block.name === 'smoker' || block.name === 'blast_furnace') {
        try {
            const furnace = await bot.openFurnace(block);
            const parts: string[] = [];
            const input = furnace.inputItem();
            const fuel = furnace.fuelItem();
            const output = furnace.outputItem();
            if (input) parts.push(`Input: ${input.count}x ${input.name.replace(/_/g, ' ')}`);
            if (fuel) parts.push(`Fuel: ${fuel.count}x ${fuel.name.replace(/_/g, ' ')}`);
            if (output) parts.push(`Output: ${output.count}x ${output.name.replace(/_/g, ' ')}`);
            furnace.close();
            if (parts.length === 0) return `The ${block.name.replace(/_/g, ' ')} is empty`;
            return `${block.name.replace(/_/g, ' ')} contains: ${parts.join(', ')}`;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to inspect ${label}: ${message}`;
        }
    }

    // Regular container (chest, barrel)
    try {
        const container = await bot.openContainer(block);
        const items = container.containerItems();
        container.close();
        if (items.length === 0) return `The ${label} is empty`;
        const list = items.map((i) => `${i.count}x ${i.name.replace(/_/g, ' ')}`).join(', ');
        return `${label} contains: ${list}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to inspect ${label}: ${message}`;
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

async function eatFood(bot: Bot, foodName: string | undefined): Promise<string> {
    const items = bot.inventory.items();

    let foodItem;
    if (foodName) {
        // Eat specific food — match against both internal name and display name
        const normalized = foodName.toLowerCase().replace(/\s+/g, '_');
        foodItem = items.find((i) =>
            i.name.toLowerCase() === normalized ||
            (i.displayName && i.displayName.toLowerCase() === foodName.toLowerCase())
        );
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

/** Shared helper: save bed position as home (memory + disk) */
function saveHome(bedBlock: { position: { x: number; y: number; z: number } }): void {
    homePosition = { x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z };
    if (homeServerKey) {
        const data = loadHomeData();
        data[homeServerKey] = homePosition;
        saveHomeData(data);
    }
    console.log(`[MC Action] Home position saved: ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`);
}

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
        saveHome(bedBlock);
        return 'Went to sleep in bed (home set)';
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Can't sleep but can still set spawn point by tapping the bed
        if (message.includes('not night') || message.includes('occupied') || message.includes('monsters')) {
            try {
                await bot.activateBlock(bedBlock);
                saveHome(bedBlock);
            } catch {
                // activateBlock can fail if too far — home not set
            }
        }

        if (message.includes('not night')) return 'Cannot sleep during the day, but home has been set to this bed';
        if (message.includes('occupied')) return 'Cannot sleep, the bed is occupied (home set to this bed)';
        if (message.includes('monsters')) return 'Cannot sleep, there are monsters nearby (home set to this bed)';
        return `Cannot sleep: ${message}`;
    }
}

async function setHome(bot: Bot): Promise<string> {
    // Find nearest bed
    const bedBlock = bot.findBlock({
        matching: (block) => BED_BLOCKS.includes(block.name),
        maxDistance: 32,
    });

    if (!bedBlock) return 'No bed found nearby to set as home';

    // Walk to the bed
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the bed';
    }

    // Tap the bed to set spawn point (works any time of day)
    try {
        await bot.activateBlock(bedBlock);
        saveHome(bedBlock);
        return `Home set to bed at ${bedBlock.position.x}, ${bedBlock.position.y}, ${bedBlock.position.z}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to set home: ${message}`;
    }
}

// ---- Cooking ----

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
        // Unequip held item so it moves back into inventory slots
        // (furnace putFuel/putInput only search slots 3-39, not the hand)
        try { await bot.unequip('hand'); } catch { /* nothing equipped */ }

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
        await new Promise((resolve) => setTimeout(resolve, cookTimeMs + 2000));

        // Take all output — keep grabbing until empty
        let totalTaken = 0;
        for (let i = 0; i < cookCount + 1; i++) {
            const output = furnace.outputItem();
            if (!output) break;
            await furnace.takeOutput();
            totalTaken += output.count;
            // Brief pause between takes
            await new Promise((r) => setTimeout(r, 200));
        }

        furnace.close();

        const cookedName = COOKABLE_ITEMS[rawItem.name] ?? 'cooked food';
        if (totalTaken === 0) return `Put ${cookCount} ${rawItem.name} in furnace but nothing cooked yet`;
        return `Cooked ${totalTaken} ${cookedName.replace(/_/g, ' ')}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to cook: ${message}`;
    }
}

// ---- Crafting ----

type McDataItems = Record<string, { id: number; displayName: string; name: string } | undefined>;
type McDataItemsById = Record<number, { id: number; displayName: string; name: string } | undefined>;

/** Get the display name for an item ID, falling back to the raw ID */
function getItemDisplayName(mcData: { items: McDataItemsById }, itemId: number): string {
    const info = mcData.items[itemId];
    return info?.displayName ?? `item#${itemId}`;
}

/** Count how many of a specific item ID the bot has in inventory */
function countItemInInventory(bot: Bot, itemId: number): number {
    return bot.inventory.items()
        .filter((i) => i.type === itemId)
        .reduce((sum, i) => sum + i.count, 0);
}

interface CraftResult {
    success: boolean;
    crafted: number;
    steps: string[];
    missing: string[];
}

/**
 * Recursively craft an item and its prerequisites.
 * Uses BFS-style dependency resolution: if ingredient X is missing,
 * try to craft X first from whatever raw materials are available.
 */
async function autoCraftWithPrereqs(
    bot: Bot,
    mcData: { items: McDataItemsById; itemsByName: McDataItems },
    itemId: number,
    count: number,
    craftingTable: ReturnType<Bot['findBlock']>,
    depth: number = 0,
): Promise<CraftResult> {
    const displayName = getItemDisplayName(mcData, itemId);

    // Safety: prevent infinite recursion
    if (depth > 5) {
        return { success: false, crafted: 0, steps: [], missing: [`${displayName} (too many nested dependencies)`] };
    }

    // For prerequisites only: skip crafting if we already have enough
    // (Top-level craft: user wants N MORE, not "ensure I have N")
    const alreadyHave = countItemInInventory(bot, itemId);
    if (depth > 0 && alreadyHave >= count) {
        return { success: true, crafted: 0, steps: [], missing: [] };
    }
    const stillNeed = depth > 0 ? count - alreadyHave : count;

    // Try direct craft first (bot has all materials)
    let recipes = bot.recipesFor(itemId, null, 1, craftingTable);
    if (recipes.length > 0) {
        try {
            const before = countItemInInventory(bot, itemId);
            await bot.craft(recipes[0], stillNeed, craftingTable ?? undefined);
            const gained = countItemInInventory(bot, itemId) - before;
            return { success: true, crafted: gained, steps: [`${gained} ${displayName}`], missing: [] };
        } catch {
            // Fall through to try auto-prereqs
        }
    }

    // Can't craft directly — get ALL recipes (regardless of inventory)
    const allRecipes = bot.recipesAll(itemId, null, craftingTable);
    if (allRecipes.length === 0) {
        // No recipe exists — this is a raw material (logs, ores, etc.)
        return { success: false, crafted: 0, steps: [], missing: [`${stillNeed} ${displayName} (no recipe, must be gathered)`] };
    }

    // Score each recipe variant by how many ingredients we already have,
    // so we prefer oak_planks when we have oak_log over cherry_planks when we don't have cherry_log
    const scored = allRecipes.map((recipe) => {
        let score = 0;
        for (const delta of recipe.delta) {
            if (delta.count < 0) {
                score += countItemInInventory(bot, delta.id);
            }
        }
        return { recipe, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // Try each recipe variant until one succeeds
    let lastMissing: string[] = [];
    for (const { recipe } of scored) {
        const ingredients: { id: number; countPerCraft: number }[] = [];
        for (const delta of recipe.delta) {
            if (delta.count < 0) {
                ingredients.push({ id: delta.id, countPerCraft: Math.abs(delta.count) });
            }
        }

        // Figure out how many times we need to run this recipe
        const resultPerCraft = recipe.result?.count ?? 1;
        const craftRuns = Math.ceil(stillNeed / resultPerCraft);

        // Recursively ensure we have enough of each ingredient
        const allSteps: string[] = [];
        const allMissing: string[] = [];
        let prereqFailed = false;
        for (const ingredient of ingredients) {
            const totalNeeded = ingredient.countPerCraft * craftRuns;
            const have = countItemInInventory(bot, ingredient.id);
            if (have < totalNeeded) {
                const prereqResult = await autoCraftWithPrereqs(
                    bot, mcData, ingredient.id, totalNeeded, craftingTable, depth + 1,
                );
                allSteps.push(...prereqResult.steps);
                allMissing.push(...prereqResult.missing);
                if (!prereqResult.success) {
                    prereqFailed = true;
                    break;
                }
            }
        }

        if (prereqFailed) {
            lastMissing = allMissing;
            continue; // Try next recipe variant
        }

        // All prerequisites resolved — retry the craft
        recipes = bot.recipesFor(itemId, null, 1, craftingTable);
        if (recipes.length > 0) {
            try {
                const before = countItemInInventory(bot, itemId);
                await bot.craft(recipes[0], craftRuns, craftingTable ?? undefined);
                const gained = countItemInInventory(bot, itemId) - before;
                allSteps.push(`${gained} ${displayName}`);
                return { success: true, crafted: gained, steps: allSteps, missing: [] };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return { success: false, crafted: 0, steps: allSteps, missing: [`${displayName}: ${message}`] };
            }
        }

        // Collect what's still missing for this variant
        const missingDetails: string[] = [];
        for (const ingredient of ingredients) {
            const totalNeeded = ingredient.countPerCraft * craftRuns;
            const have = countItemInInventory(bot, ingredient.id);
            if (have < totalNeeded) {
                const name = getItemDisplayName(mcData, ingredient.id);
                missingDetails.push(`${totalNeeded - have} ${name}`);
            }
        }
        lastMissing = missingDetails;
    }

    // No recipe variant worked
    return {
        success: false,
        crafted: 0,
        steps: [],
        missing: lastMissing.length > 0
            ? lastMissing
            : [`${displayName} (unknown reason)`],
    };
}

async function craftItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const mcData = require('minecraft-data')(bot.version) as {
        itemsByName: McDataItems;
        items: McDataItemsById;
    };
    const count = countStr ? parseInt(countStr, 10) : 1;

    // Resolve name
    const resolved = CRAFT_ALIASES[itemName.toLowerCase()] ?? itemName.toLowerCase().replace(/ /g, '_');
    const itemInfo = mcData.itemsByName[resolved];
    if (!itemInfo) return `Unknown item: ${itemName}`;

    // Suppress pickup notes for the entire crafting process
    // (equip/unequip/craft all trigger inventory slot changes)
    suppressPickups = true;

    // Move held item to inventory so recipesFor can find it as a material
    const heldItemName = bot.heldItem?.name ?? null;
    if (heldItemName) {
        await bot.unequip('hand');
    }

    const countBefore = countItemInInventory(bot, itemInfo.id);

    // Find crafting table if needed (try without first)
    let craftingTable: ReturnType<Bot['findBlock']> = null;
    let recipes = bot.recipesFor(itemInfo.id, null, 1, null);

    if (recipes.length === 0) {
        // Need to check with a crafting table
        craftingTable = bot.findBlock({
            matching: (block) => block.name === 'crafting_table',
            maxDistance: 32,
        });

        if (craftingTable) {
            try {
                await bot.pathfinder.goto(
                    new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2),
                );
            } catch {
                cleanup(bot, heldItemName);
                return 'Cannot reach the crafting table';
            }
        }
    }

    // Auto-craft with prerequisite resolution
    const result = await autoCraftWithPrereqs(bot, mcData, itemInfo.id, count, craftingTable);

    let message: string;
    if (result.success) {
        const totalGained = countItemInInventory(bot, itemInfo.id) - countBefore;
        // Show what was auto-crafted along the way
        if (result.steps.length > 1) {
            // Multiple steps = auto-crafted prerequisites
            const prereqSteps = result.steps.slice(0, -1).join(', ');
            message = `Crafted ${totalGained} ${itemInfo.displayName} (auto-crafted: ${prereqSteps})`;
        } else {
            message = `Crafted ${totalGained} ${itemInfo.displayName}`;
        }
    } else if (result.missing.length > 0) {
        // Check if the missing items are raw materials with known gathering hints
        const RAW_MATERIAL_HINTS: Record<string, string> = {
            string: 'Kill spiders to get string, or mine cobwebs with a sword.',
            leather: 'Kill cows to get leather.',
            feather: 'Kill chickens to get feathers.',
            bone: 'Kill skeletons to get bones.',
            gunpowder: 'Kill creepers to get gunpowder.',
            ender_pearl: 'Kill endermen to get ender pearls.',
            blaze_rod: 'Kill blazes in the Nether.',
            slime_ball: 'Kill slimes to get slime balls.',
            spider_eye: 'Kill spiders to get spider eyes.',
            ink_sac: 'Kill squids to get ink sacs.',
            flint: 'Mine gravel — it has a chance to drop flint.',
            diamond: 'Mine diamond_ore with an iron pickaxe or better.',
            coal: 'Mine coal_ore to get coal.',
            iron_ingot: 'Mine iron_ore and smelt it in a furnace.',
            gold_ingot: 'Mine gold_ore and smelt it in a furnace.',
            rotten_flesh: 'Kill zombies to get rotten flesh.',
        };
        // If a missing item matches a raw material hint, use that instead
        const missingHints = result.missing.map((m) => {
            // Extract item name from "N ItemName (no recipe, must be gathered)"
            const match = m.match(/^\d+\s+(.+?)\s*\(no recipe/);
            if (match) {
                const rawName = match[1].toLowerCase().replace(/ /g, '_');
                const hint = RAW_MATERIAL_HINTS[rawName];
                if (hint) return hint;
            }
            return m;
        });
        message = `Cannot craft ${itemInfo.displayName}: ${missingHints.join('; ')}`;
    } else {
        message = `Cannot craft ${itemInfo.displayName}: missing materials`;
    }

    cleanup(bot, heldItemName);
    return message;
}

/** Re-equip held item and clear suppression */
async function cleanup(bot: Bot, heldItemName: string | null): Promise<void> {
    if (heldItemName) {
        const reequip = bot.inventory.items().find((i) => i.name === heldItemName);
        if (reequip) await bot.equip(reequip, 'hand');
    }
    // Delay clearing so async slot events from equip/unequip are caught
    setTimeout(() => { suppressPickups = false; }, 200);
}

// ---- Toss/Drop Items ----

async function tossItem(bot: Bot, itemName: string | undefined, countStr: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const resolved = itemName.toLowerCase().replace(/ /g, '_');

    // Handle "all" — drop entire inventory
    if (resolved === 'all') {
        const items = bot.inventory.items();
        if (items.length === 0) return 'Inventory is already empty';

        let totalDropped = 0;
        for (const item of items) {
            await bot.tossStack(item);
            totalDropped += item.count;
        }
        return `Dropped ${totalDropped} items (entire inventory)`;
    }

    // Find matching items in inventory
    const matching = bot.inventory.items().filter((i) => i.name === resolved);
    if (matching.length === 0) return `No ${itemName} in inventory`;

    const totalHave = matching.reduce((sum, i) => sum + i.count, 0);
    const toDrop = countStr ? Math.min(parseInt(countStr, 10), totalHave) : totalHave;

    if (isNaN(toDrop) || toDrop <= 0) return `Invalid count: ${countStr}`;

    // Use bot.toss() which accepts itemType, metadata, count
    await bot.toss(matching[0].type, null, toDrop);

    const displayName = matching[0].displayName ?? itemName;
    return `Dropped ${toDrop} ${displayName}`;
}

// ---- Use Held Item ----

async function useHeldItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const resolved = itemName.toLowerCase().replace(/ /g, '_');

    // Redirect fishing rod to the proper fishing action (cast + wait + reel in)
    if (resolved === 'fishing_rod') {
        return fishAction(bot, '1');
    }

    // Find the item in inventory
    const item = bot.inventory.items().find((i) => i.name === resolved || i.displayName?.toLowerCase() === itemName.toLowerCase());
    if (!item) return `No ${itemName} in inventory`;

    // Auto-equip if not already held
    if (bot.heldItem?.name !== item.name) {
        try {
            await bot.equip(item, 'hand');
        } catch {
            return `Failed to equip ${item.displayName ?? itemName}`;
        }
    }

    const name = item.displayName ?? item.name;

    // Activate the item (right-click)
    bot.activateItem();
    return `Used ${name}`;
}

// ---- Fishing ----

async function fishAction(bot: Bot, countStr: string | undefined): Promise<string> {
    // Find and equip a fishing rod
    const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
    if (!rod) return 'No fishing rod in inventory';

    try {
        await bot.equip(rod, 'hand');
    } catch {
        return 'Failed to equip fishing rod';
    }

    const targetCount = countStr ? parseInt(countStr, 10) : 5;
    if (isNaN(targetCount) || targetCount <= 0) return 'Invalid count';

    const signal = actionAbort.signal;
    const caught = new Map<string, number>(); // displayName → count
    let totalCaught = 0;

    const CAST_TIMEOUT_MS = 30_000; // 30s max wait per cast

    for (let i = 0; i < targetCount; i++) {
        if (signal.aborted) break;

        console.log(`[Fish] Cast ${i + 1}/${targetCount} — snapshotting inventory`);

        // Snapshot inventory before cast
        const beforeItems = new Map<string, number>();
        for (const item of bot.inventory.items()) {
            beforeItems.set(item.name, (beforeItems.get(item.name) ?? 0) + item.count);
        }

        const castTime = Date.now();

        // Use Mineflayer's bot.fish() (particle-based bite detection) with a timeout
        // bot.fish() handles: cast → detect bite via world_particles → reel in
        // But it can hang forever if particle detection fails, so we race it with a timeout
        let catchResult: 'caught' | 'timeout' | 'aborted';
        try {
            console.log(`[Fish] Calling bot.fish() (timeout: ${CAST_TIMEOUT_MS / 1000}s)...`);
            await Promise.race([
                bot.fish(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), CAST_TIMEOUT_MS),
                ),
                new Promise<never>((_, reject) => {
                    if (signal.aborted) reject(new Error('aborted'));
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
            ]);
            const elapsed = ((Date.now() - castTime) / 1000).toFixed(1);
            console.log(`[Fish] bot.fish() completed — caught after ${elapsed}s`);
            catchResult = 'caught';
        } catch (err) {
            const elapsed = ((Date.now() - castTime) / 1000).toFixed(1);
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`[Fish] bot.fish() failed after ${elapsed}s — ${msg}`);
            if (msg === 'aborted' || signal.aborted) {
                catchResult = 'aborted';
            } else if (msg === 'timeout') {
                catchResult = 'timeout';
                // Reel in the rod since bot.fish() was interrupted
                console.log(`[Fish] Reeling in after timeout (activateItem)...`);
                bot.activateItem();
                await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
                // Other errors (e.g. "Fishing cancelled", no water nearby)
                catchResult = 'timeout';
            }
        }

        if (catchResult === 'aborted') break;
        if (catchResult === 'timeout') {
            console.log(`[Fish] Timeout — recast next loop`);
            continue;
        }

        // Wait for item to appear in inventory
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Detect what was gained
        let gainedAny = false;
        for (const item of bot.inventory.items()) {
            const prevCount = beforeItems.get(item.name) ?? 0;
            const currentCount = bot.inventory.items()
                .filter((i) => i.name === item.name)
                .reduce((sum, i) => sum + i.count, 0);
            const gained = currentCount - prevCount;
            if (gained > 0) {
                const display = item.displayName ?? item.name;
                console.log(`[Fish] Gained: ${gained}x ${display}`);
                caught.set(display, (caught.get(display) ?? 0) + gained);
                totalCaught += gained;
                gainedAny = true;
                // Notify per-catch so the voice chance system can react
                onFishCaught?.(display, gained);
            }
            beforeItems.set(item.name, currentCount);
        }
        if (!gainedAny) {
            console.log(`[Fish] bot.fish() resolved but no new items in inventory`);
        }
    }

    // If aborted (e.g. mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (totalCaught === 0) return 'Didn\'t catch anything — make sure I\'m facing open water';

    const parts: string[] = [];
    for (const [name, count] of caught) {
        parts.push(`${count} ${name}`);
    }
    return `Caught ${totalCaught} items: ${parts.join(', ')}`;
}

// ---- Block Placement ----

async function placeBlock(bot: Bot, blockName: string | undefined): Promise<string> {
    if (!blockName) return 'No block name provided';

    const resolved = blockName.toLowerCase().replace(/ /g, '_');

    // Find the block in inventory
    const item = bot.inventory.items().find(
        (i) => i.name.toLowerCase().includes(resolved),
    );
    // Also check held item
    const heldItem = bot.heldItem;
    const isHeld = heldItem && heldItem.name.toLowerCase().includes(resolved);

    if (!item && !isHeld) return `No ${blockName} found in inventory`;

    const displayName = item?.displayName ?? heldItem?.displayName ?? blockName;

    // Save currently held item to re-equip after
    const previousHeld = (!isHeld && heldItem) ? heldItem.name : null;

    // Equip the block if not already held
    suppressPickups = true;
    if (!isHeld && item) {
        await bot.equip(item, 'hand');
    }

    // Find a reference block to place against (block at bot's feet level)
    const pos = bot.entity.position;
    const refBlock = bot.blockAt(pos.offset(0, -1, 0));
    if (!refBlock || refBlock.name === 'air' || refBlock.name === 'cave_air') {
        suppressPickups = false;
        return `Cannot place ${displayName}: no solid ground nearby`;
    }

    // Try to place the block on top of the reference block
    try {
        const faceVector = new (require('vec3').Vec3)(0, 1, 0); // top face
        await bot.placeBlock(refBlock, faceVector);
        // Re-equip previous item
        if (previousHeld) {
            const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
            if (reequip) await bot.equip(reequip, 'hand');
        }
        setTimeout(() => { suppressPickups = false; }, 200);
        return `Placed ${displayName}`;
    } catch (err) {
        // If placing at feet fails, try in front of the bot
        try {
            const yaw = bot.entity.yaw;
            const dx = -Math.sin(yaw);
            const dz = -Math.cos(yaw);
            const frontRef = bot.blockAt(pos.offset(Math.round(dx), -1, Math.round(dz)));
            if (frontRef && frontRef.name !== 'air') {
                const faceVector = new (require('vec3').Vec3)(0, 1, 0);
                await bot.placeBlock(frontRef, faceVector);
                if (previousHeld) {
                    const reequip = bot.inventory.items().find((i) => i.name === previousHeld);
                    if (reequip) await bot.equip(reequip, 'hand');
                }
                setTimeout(() => { suppressPickups = false; }, 200);
                return `Placed ${displayName}`;
            }
        } catch { /* fallback failed */ }
        setTimeout(() => { suppressPickups = false; }, 200);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to place ${displayName}: ${message}`;
    }
}

async function equipItem(bot: Bot, itemName: string | undefined): Promise<string> {
    if (!itemName) return 'No item name provided';

    const item = bot.inventory.items().find(
        (i) => i.name.toLowerCase().includes(itemName.toLowerCase()),
    );
    if (!item) return `No ${itemName} found in inventory`;

    const slot = getEquipSlot(item.name);
    try {
        suppressPickups = true;
        await bot.equip(item.type, slot);
        setTimeout(() => { suppressPickups = false; }, 200);
        const slotLabel = slot === 'hand' ? 'hand' : `${slot} armor slot`;
        return `Equipped ${item.displayName ?? item.name} in ${slotLabel}`;
    } catch (err) {
        setTimeout(() => { suppressPickups = false; }, 200);
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to equip ${item.name}: ${message}`;
    }
}
