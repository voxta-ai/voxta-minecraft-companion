import type { ScenarioAction } from '../voxta/types';

// ---- Extended action type with metadata ----

export type ActionCategory = 'movement' | 'combat' | 'survival' | 'interaction' | 'meta';

export interface McAction extends ScenarioAction {
    /** UI grouping for action toggles */
    category: ActionCategory;
    /** Quick actions don't report results back to the AI */
    isQuick: boolean;
    /** Physical actions set the busy flag and cancel previous actions */
    isPhysical: boolean;
}

// ---- Action definitions for Voxta registration ----

export const MINECRAFT_ACTIONS: McAction[] = [
    {
        name: 'mc_follow_player',
        description: 'Follow a player and stay near them',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'player_name', type: 'String', description: 'Name of the player to follow', required: true },
        ],
        category: 'movement',
        isQuick: true,
        isPhysical: true,
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
        category: 'movement',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_go_home',
        description: 'Go back home to the shelter/base where the bed is. Use when told to return home, go to base, go to shelter, or head back.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'movement',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_mine_block',
        description: 'Find and collect a specific type of block, plant, or flower. Works for ores, wood, flowers (cornflower, poppy, dandelion), crops, mushrooms, and any other block.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'block_type', type: 'String', description: 'Type of block to collect. Use "wood" or "log" for trees, or a specific name like oak_log, stone, iron_ore, cornflower, poppy, dandelion, wheat', required: true },
            { name: 'count', type: 'String', description: 'Number of blocks to mine', required: false },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
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
        category: 'combat',
        isQuick: false,
        isPhysical: true,
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
        category: 'movement',
        isQuick: true,
        isPhysical: false,
    },
    {
        name: 'mc_stop',
        description: 'Stop the current action and stand still',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'movement',
        isQuick: true,
        isPhysical: false,
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
        category: 'interaction',
        isQuick: true,
        isPhysical: true,
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
        category: 'interaction',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_collect_items',
        description: 'Pick up nearby dropped items from the ground',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
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
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_none',
        description: 'ONLY use when just talking and absolutely no game action is needed. Do NOT use if the player asked you to do something.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'meta',
        isQuick: true,
        isPhysical: false,
    },
    {
        name: 'mc_sleep',
        description: 'Find a nearby bed and sleep in it. Only works at night.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'survival',
        isQuick: true,
        isPhysical: true,
    },
    {
        name: 'mc_wake',
        description: 'Wake up and get out of bed.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'survival',
        isQuick: true,
        isPhysical: false,
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
        category: 'survival',
        isQuick: false,
        isPhysical: true,
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
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_store_item',
        description: 'Store/deposit items from inventory into a nearby chest. Use when asked to put items away, store items, or fill a chest.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Name of the item to store (e.g. cobblestone, iron_ingot, diamond). Use "all" to store everything.', required: true },
            { name: 'count', type: 'String', description: 'How many to store (default: all of that item)', required: false },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_take_item',
        description: 'Take/withdraw items from a nearby chest into inventory. Use when asked to get items from a chest, grab supplies, or retrieve something.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'item_name', type: 'String', description: 'Name of the item to take from the chest (e.g. cobblestone, iron_ingot, diamond)', required: true },
            { name: 'count', type: 'String', description: 'How many to take (default: all available)', required: false },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_inspect',
        description: 'Inspect the contents of a nearby container (chest, furnace, barrel) or own inventory. Returns a list of all items inside.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            { name: 'target', type: 'String', description: 'What to inspect: "chest", "furnace", "barrel", or "inventory" for own items', required: true },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: false,
    },
];

// ---- Tool requirements ----

export type ToolCategory = 'axe' | 'pickaxe' | 'shovel' | 'none';

/** Maps block names to the tool required to mine them */
export const TOOL_REQUIREMENTS: Record<string, ToolCategory> = {
    // Wood → axe preferred but NOT required (can be mined by hand)
    // Stone/Ores → pickaxe REQUIRED (no drops without it)
    stone: 'pickaxe', cobblestone: 'pickaxe', deepslate: 'pickaxe',
    iron_ore: 'pickaxe', gold_ore: 'pickaxe', diamond_ore: 'pickaxe',
    coal_ore: 'pickaxe', copper_ore: 'pickaxe', lapis_ore: 'pickaxe',
    redstone_ore: 'pickaxe', emerald_ore: 'pickaxe', nether_quartz_ore: 'pickaxe',
    netherrack: 'pickaxe', obsidian: 'pickaxe', andesite: 'pickaxe',
    diorite: 'pickaxe', granite: 'pickaxe',
    // Dirt/Sand/Wood → no tool required
    dirt: 'none', sand: 'none', gravel: 'none', clay: 'none',
    grass_block: 'none',
};

export const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

// ---- Food & Cooking data ----

/** Food items sorted by hunger restoration (best first) */
export const FOOD_ITEMS: Record<string, number> = {
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

/** Raw items that can be smelted in a furnace */
export const COOKABLE_ITEMS: Record<string, string> = {
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
export const FUEL_ITEMS = [
    'coal', 'charcoal', 'coal_block',
    'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log',
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
    'stick',
];

// ---- Bed & Sleep data ----

export const BED_BLOCKS = [
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
    'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
    'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
];

// ---- Crafting data ----

/** Common name aliases to real item names */
export const CRAFT_ALIASES: Record<string, string> = {
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
