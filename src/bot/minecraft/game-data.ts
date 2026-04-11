// ---- Minecraft game data lookup tables ----
//
// Static data about Minecraft items, blocks, and recipes.
// Separated from action-definitions so game data can grow
// independently of the Voxta action registration system.

// ---- Tool requirements ----

export type ToolCategory = 'axe' | 'pickaxe' | 'shovel' | 'none';

/** Maps block names to the tool required to mine them */
export const TOOL_REQUIREMENTS: Record<string, ToolCategory> = {
    // Wood → axe preferred but NOT required (can be mined by hand)
    // Stone/Ores → pickaxe REQUIRED (no drops without it)
    stone: 'pickaxe',
    cobblestone: 'pickaxe',
    deepslate: 'pickaxe',
    iron_ore: 'pickaxe',
    gold_ore: 'pickaxe',
    diamond_ore: 'pickaxe',
    coal_ore: 'pickaxe',
    copper_ore: 'pickaxe',
    lapis_ore: 'pickaxe',
    redstone_ore: 'pickaxe',
    emerald_ore: 'pickaxe',
    nether_quartz_ore: 'pickaxe',
    netherrack: 'pickaxe',
    obsidian: 'pickaxe',
    andesite: 'pickaxe',
    diorite: 'pickaxe',
    granite: 'pickaxe',
    // Dirt/Sand/Wood → no tool required
    dirt: 'none',
    sand: 'none',
    gravel: 'none',
    clay: 'none',
    grass_block: 'none',
};

export const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/**
 * Minimum tool tier required for a block to actually drop items.
 * If the bot's best pickaxe is below this tier, mining is pointless.
 * Blocks not listed here can be mined with any tier of the required tool.
 */
export const TOOL_MIN_TIER: Record<string, string> = {
    // Stone tier minimum (wooden pickaxe won't drop these)
    iron_ore: 'stone',
    deepslate_iron_ore: 'stone',
    copper_ore: 'stone',
    deepslate_copper_ore: 'stone',
    lapis_ore: 'stone',
    deepslate_lapis_ore: 'stone',
    // Iron tier minimum
    gold_ore: 'iron',
    deepslate_gold_ore: 'iron',
    diamond_ore: 'iron',
    deepslate_diamond_ore: 'iron',
    emerald_ore: 'iron',
    deepslate_emerald_ore: 'iron',
    redstone_ore: 'iron',
    deepslate_redstone_ore: 'iron',
    // Diamond tier minimum
    obsidian: 'diamond',
    ancient_debris: 'diamond',
};

// ---- Food & Cooking data ----

/** Food items sorted by hunger restoration (the best first) */
export const FOOD_ITEMS: Record<string, number> = {
    golden_carrot: 6,
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_mutton: 6,
    cooked_salmon: 6,
    cooked_chicken: 6,
    cooked_rabbit: 5,
    cooked_cod: 5,
    bread: 5,
    baked_potato: 5,
    beetroot_soup: 6,
    mushroom_stew: 6,
    rabbit_stew: 10,
    suspicious_stew: 6,
    pumpkin_pie: 8,
    cake: 2,
    apple: 4,
    melon_slice: 2,
    sweet_berries: 2,
    glow_berries: 2,
    carrot: 3,
    potato: 1,
    beetroot: 1,
    dried_kelp: 1,
    cookie: 2,
    beef: 3,
    porkchop: 3,
    mutton: 2,
    chicken: 2,
    rabbit: 3,
    cod: 2,
    salmon: 2,
    tropical_fish: 1,
    rotten_flesh: -1, // last resort — 80% chance of Hunger debuff
    spider_eye: -2, // last resort — gives Poison debuff
};

/** Ranged weapon items */
export const RANGED_WEAPONS = ['bow', 'crossbow'];

/** Arrow items that serve as ranged ammunition */
export const ARROW_ITEMS = ['arrow', 'spectral_arrow', 'tipped_arrow'];

/** Raw items that can be smelted in a furnace */
export const COOKABLE_ITEMS: Record<string, string> = {
    // Food
    beef: 'cooked_beef',
    porkchop: 'cooked_porkchop',
    chicken: 'cooked_chicken',
    mutton: 'cooked_mutton',
    rabbit: 'cooked_rabbit',
    cod: 'cooked_cod',
    salmon: 'cooked_salmon',
    potato: 'baked_potato',
    kelp: 'dried_kelp',
    // Ores & raw metals
    raw_iron: 'iron_ingot',
    raw_gold: 'gold_ingot',
    raw_copper: 'copper_ingot',
    iron_ore: 'iron_ingot',
    gold_ore: 'gold_ingot',
    copper_ore: 'copper_ingot',
    // Other smeltables
    sand: 'glass',
    cobblestone: 'stone',
    clay_ball: 'brick',
    netherrack: 'nether_brick',
    wet_sponge: 'sponge',
    cactus: 'green_dye',
    ancient_debris: 'netherite_scrap',
};

/** Items that work as furnace fuel, sorted by burn time (the best first) */
export const FUEL_ITEMS = [
    'coal',
    'charcoal',
    'coal_block',
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'mangrove_log',
    'cherry_log',
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'mangrove_planks',
    'cherry_planks',
    'stick',
];

// ---- Bed & Sleep data ----

export const BED_BLOCKS = [
    'white_bed',
    'orange_bed',
    'magenta_bed',
    'light_blue_bed',
    'yellow_bed',
    'lime_bed',
    'pink_bed',
    'gray_bed',
    'light_gray_bed',
    'cyan_bed',
    'purple_bed',
    'blue_bed',
    'brown_bed',
    'green_bed',
    'red_bed',
    'black_bed',
];

// ---- Crafting data ----

/** Common name aliases to real item names */
export const CRAFT_ALIASES: Record<string, string> = {
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
};

/** Common AI-inferred names mapped to Minecraft internal names */
export const ITEM_ALIASES: Record<string, string> = {
    // Fish — AI often says 'raw_fish' or 'raw_salmon' instead of 'cod'/'salmon'
    raw_fish: 'cod',
    raw_cod: 'cod',
    raw_salmon: 'salmon',
    cooked_fish: 'cooked_cod',
    fish: 'cod',
    // Meat — AI may add 'raw_' prefix to meat
    raw_beef: 'beef',
    raw_pork: 'porkchop',
    raw_porkchop: 'porkchop',
    raw_chicken: 'chicken',
    raw_mutton: 'mutton',
    raw_rabbit: 'rabbit',
    // Common renames
    steak: 'cooked_beef',
    cooked_steak: 'cooked_beef',
    cooked_pork: 'cooked_porkchop',
    wooden_plank: 'oak_planks',
    wooden_planks: 'oak_planks',
    plank: 'oak_planks',
    log: 'oak_log',
    wood: 'oak_log',
};

// ---- Combat & health ----

/** Below this HP threshold (3 hearts = 6 HP), the bot kites instead of fighting */
export const LOW_HEALTH_THRESHOLD = 6;

/** Ranged mobs that shoot projectiles — used for kiting/zigzag approach */
export const RANGED_MOBS = new Set([
    'witch', 'skeleton', 'stray', 'pillager', 'blaze',
    'ghast', 'shulker', 'drowned', 'evoker', 'illusioner',
]);

// ---- Entity classifications ----

/** Door block names for pathfinder passthrough */
export const DOOR_BLOCKS = [
    'oak_door', 'spruce_door', 'birch_door', 'jungle_door',
    'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door',
    'crimson_door', 'warped_door',
];

/** Entity names that can be mounted/ridden */
export const RIDEABLE_ENTITIES = new Set([
    'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse',
    'pig', 'strider', 'camel', 'llama', 'trader_llama',
    'boat', 'oak_boat', 'spruce_boat', 'birch_boat', 'jungle_boat',
    'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'bamboo_raft',
    'minecart',
]);

/**
 * Mobs classified as hostile but only attack when provoked.
 * Full set — used for proximity defense exclusion in events.ts.
 */
export const NEUTRAL_HOSTILE_MOBS = new Set([
    'enderman', 'piglin', 'zombified_piglin', 'spider', 'cave_spider',
    'iron_golem', 'wolf', 'bee', 'llama', 'polar_bear', 'dolphin',
    'panda', 'goat', 'trader_llama',
]);

/**
 * Subset of neutral-hostile mobs to skip in aggro/guard mode scanning.
 * These mobs are technically hostile but only attack under certain conditions
 * (night, provocation) — auto-targeting them starts unnecessary fights.
 */
export const AGGRO_SKIP_MOBS = ['enderman', 'spider', 'cave_spider', 'zombified_piglin'];

/** Farm animals targeted by hunt mode */
export const HUNTABLE_ANIMALS = ['pig', 'cow', 'mooshroom', 'sheep', 'chicken', 'rabbit'];

/**
 * Mobs that split into smaller versions on death (slime → babies, magma_cube → babies).
 * Used for post-kill cooldowns to avoid chasing tiny split babies.
 */
export const SPLIT_MOBS = ['slime', 'magma_cube'];

// ---- Entity name aliases ----

/** Common AI-inferred entity names mapped to Minecraft internal names */
export const ENTITY_ALIASES: Record<string, string> = {
    bull: 'cow',
    cattle: 'cow',
    mooshroom: 'mooshroom',
    horse: 'horse',
    puppy: 'wolf',
    dog: 'wolf',
    kitty: 'cat',
    kitten: 'cat',
    ocelot: 'ocelot',
    bunny: 'rabbit',
    zombie_pigman: 'zombified_piglin',
    pigman: 'zombified_piglin',
    iron_golem: 'iron_golem',
    snow_golem: 'snow_golem',
    snowman: 'snow_golem',
    ender_dragon: 'ender_dragon',
    dragon: 'ender_dragon',
    wither_skeleton: 'wither_skeleton',
    cave_spider: 'cave_spider',
    magma_cube: 'magma_cube',
    slime: 'slime',
    polar_bear: 'polar_bear',
    bear: 'polar_bear',
};
