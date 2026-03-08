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
        description:
            'Follow a player and stay near them. The bot walks behind the specified player. player_name must be the OTHER player (the human), never the {{ char }} itself.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'player_name',
                type: 'String',
                description: 'Name of the human player to follow (NOT the bot name)',
                required: true,
            },
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
        description:
            'Go back home to the shelter/base where the bed is. Use when told to return home, go to base, go to shelter, or head back.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'movement',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_go_to_entity',
        description:
            'Walk to a nearby mob, animal, or creature. Use when told to go to, approach, or get closer to an entity.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'entity_name',
                type: 'String',
                description: 'Name of the entity to approach (e.g. pig, cow, sheep, villager, zombie)',
                required: true,
            },
        ],
        category: 'movement',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_mine_block',
        description:
            'Find and collect/harvest a specific type of block, plant, or resource. Works for ores, wood, flowers, crops, mushrooms, sweet berries (sweet_berry_bush), sugarcane (sugar_cane), and any other block or plant.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'block_type',
                type: 'String',
                description:
                    'Type of block to collect/harvest. Use "wood" or "log" for trees. Examples: oak_log, stone, iron_ore, cornflower, poppy, dandelion, wheat, sweet_berry_bush, sugar_cane',
                required: true,
            },
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
            {
                name: 'entity_name',
                type: 'String',
                description: 'Name of entity to attack (e.g. zombie, skeleton, spider)',
                required: true,
            },
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
            {
                name: 'item_name',
                type: 'String',
                description: 'Name of the item to equip (e.g. iron_axe, diamond_pickaxe)',
                required: true,
            },
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
            {
                name: 'food_name',
                type: 'String',
                description: 'Specific food to eat (optional, will pick best available if not specified)',
                required: false,
            },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_none',
        description:
            'ONLY use when just talking and absolutely no game action is needed. Do NOT use if the player asked you to do something.',
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
        name: 'mc_set_home',
        description:
            'Set a nearby bed as home/respawn point. Works at any time of day — does NOT require sleeping. Use when told to mark this as home, set home here, or remember this place.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_cook',
        description:
            'Cook raw food or smelt ores in a nearby furnace. Needs fuel (wood/coal) in inventory. Works for raw meat, ores (iron, gold, copper), sand, clay, and more.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'item_name',
                type: 'String',
                description: 'Raw food to cook (optional, will cook whatever is available)',
                required: false,
            },
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
            {
                name: 'item_name',
                type: 'String',
                description:
                    'Item to craft (e.g. wooden_sword, stone_pickaxe, oak_planks, sticks, crafting_table, furnace)',
                required: true,
            },
            { name: 'count', type: 'String', description: 'How many to craft (default: 1)', required: false },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_place_block',
        description:
            'Place a block from inventory at a nearby location. Automatically equips the block if not already held.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'block_name',
                type: 'String',
                description: 'Block to place (e.g. crafting_table, furnace, torch, chest)',
                required: true,
            },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_store_item',
        description:
            'Store/deposit items from inventory into a nearby chest. Use when asked to put items away, store items, or fill a chest.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'item_name',
                type: 'String',
                description:
                    'Name of the item to store (e.g. cobblestone, iron_ingot, diamond). Use "all" to store everything.',
                required: true,
            },
            {
                name: 'count',
                type: 'String',
                description: 'How many to store (default: all of that item)',
                required: false,
            },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_take_item',
        description:
            'Take/withdraw items from a nearby chest into inventory. Use when asked to get items from a chest, grab supplies, or retrieve something.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'item_name',
                type: 'String',
                description: 'Name of the item to take from the chest (e.g. cobblestone, iron_ingot, diamond)',
                required: true,
            },
            {
                name: 'count',
                type: 'String',
                description: 'How many to take (default: all available)',
                required: false,
            },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_inspect',
        description:
            'Inspect the contents of a nearby container (chest, furnace, barrel) or own inventory. Returns a list of all items inside.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'target',
                type: 'String',
                description: 'What to inspect: "chest", "furnace", "barrel", or "inventory" for own items',
                required: true,
            },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: false,
    },
    {
        name: 'mc_toss',
        description:
            'Toss/drop items from inventory onto the ground. Use when told to throw away, discard, or drop items. Useful to free up inventory space.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'item_name',
                type: 'String',
                description:
                    'Name of the item to toss (e.g. cobblestone, dirt, rotten_flesh). Use "all" to drop everything.',
                required: true,
            },
            {
                name: 'count',
                type: 'String',
                description: 'How many to drop (default: all of that item)',
                required: false,
            },
        ],
        category: 'interaction',
        isQuick: false,
        isPhysical: false,
    },
    {
        name: 'mc_fish',
        description:
            'Fish with a fishing rod. Must have a fishing rod in inventory and be near water. Will cast and wait for fish to bite.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'count',
                type: 'String',
                description: 'How many fish to catch before stopping (default: 5)',
                required: false,
            },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_use_item',
        description:
            'Use/activate an item (right-click). Works for potions, buckets, bonemeal, ender pearls, and other usable items. Do NOT use for fishing rods — use mc_fish instead.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'item_name',
                type: 'String',
                description:
                    'Item to use (e.g. potion, water_bucket, bone_meal, ender_pearl). Will auto-equip if not already held.',
                required: true,
            },
        ],
        category: 'interaction',
        isQuick: true,
        isPhysical: false,
    },
];
