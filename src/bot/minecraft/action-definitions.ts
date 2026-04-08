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
            'Go back home to the shelter/base where the bed is. ONLY use when the player EXPLICITLY tells the bot to go home, return to base, or head back to shelter. Do NOT use on your own initiative (e.g. because it is getting dark). Do NOT use for questions about where home is.',
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
            { name: 'count', type: 'String', description: 'Number of blocks to mine (default: 5, max: 32)', required: false },
        ],
        category: 'survival',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_attack',
        description:
            'Attack the nearest entity of a given type. Only use when explicitly told to attack, fight, or kill. Do NOT use for questions about nearby mobs — that info is already in context.',
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
        description:
            'Stop the current action and stand still. WARNING: this also cancels guard, aggro, and hunt modes, returning to passive. Do NOT use if the bot is in guard/aggro/hunt mode and should stay in that mode — use mc_none instead.',
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
        description:
            'Equip an item from inventory into hand or armor slot. Only use when explicitly told to equip, hold, wield, or switch to an item. Do NOT use for questions about having items — inventory is already in context.',
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
        description:
            'Pick up nearby dropped items from the ground. Only use when explicitly told to pick up, collect, or grab items.',
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
        description:
            'Eat food from inventory to restore hunger. Only use when explicitly told to eat, feed, or have a meal. Do NOT use for questions about hunger — hunger level is already visible in context.',
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
            'ONLY use when just talking and absolutely no game action is needed. Also use when the bot is already doing what was asked (e.g. already guarding, already following). Do NOT use if the player asked you to do something new.',
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
        description:
            'Find a nearby bed and sleep in it. Only works at night. Only use when explicitly told to sleep or rest. Do NOT use for questions about time or night — that info is already in context.',
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
            'Cook raw food or smelt ores in a nearby furnace. Needs fuel (wood/coal) in inventory. Works for raw meat, ores (iron, gold, copper), sand, clay, and more. Only use when explicitly told to cook, smelt, or use the furnace.',
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
        name: 'mc_build',
        description:
            'Build a structure using materials from inventory. Built-in: shelter (7x7 hut, ~120 blocks), watchtower (5x5 tall tower with stairs, ~140 blocks), wall (3x3 defensive wall with arrow slit, ~8 blocks). '
            + 'Custom blueprints may also be available from JSON files. '
            + 'Needs building blocks (cobblestone, planks, or dirt) in inventory. '
            + 'Use when told to build, construct, or make a shelter/house/base/hut/cabin/tower/wall or any named structure.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'structure',
                type: 'String',
                description: "Structure to build. Built-in: 'shelter', 'watchtower', 'wall'. Also accepts aliases: house/hut/base/cabin (shelter), tower/lookout (watchtower), fence/barrier (wall). Custom structures may be available by name.",
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
    {
        name: 'mc_set_mode',
        description:
            "Switch the bot's behavior mode. Use 'aggro' when the player wants to fight mobs or kill everything hostile nearby — the bot will proactively attack hostile mobs while following. Use 'hunt' when the player wants to hunt animals for food — the bot will seek and kill farm animals (pigs, cows, sheep, chickens, rabbits, mooshrooms) while following. Use 'guard' when the player wants the bot to stay in an area and patrol/defend it — the bot stops following and patrols within 8 blocks, attacking any hostile that approaches. Use 'passive' to return to normal following (only fights when attacked). Also triggered by mc_stop or mc_follow_player.",
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'mode',
                type: 'String',
                description: "Behavior mode: 'passive' (follow, defend only), 'aggro' (follow + attack all hostiles), 'hunt' (follow + hunt farm animals for food), 'guard' (patrol area + defend)",
                required: true,
            },
        ],
        category: 'meta',
        isQuick: true,
        isPhysical: false,
    },
    {
        name: 'mc_mount',
        description:
            'Mount/ride/sit in a nearby vehicle or animal. Use this to sit in a boat, ride a horse, or get into a minecart. Works for boats, horses (tamed with saddle), donkeys, mules, minecarts, pigs (with saddle), camels, llamas, and striders. When a player asks you to "get in the boat" or "sit in the boat", use this action with entity_name=boat.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [
            {
                name: 'entity_name',
                type: 'String',
                description:
                    'Name of the entity to mount (e.g. horse, boat, minecart, pig, donkey). Leave empty to mount the nearest rideable entity.',
                required: false,
            },
        ],
        category: 'movement',
        isQuick: false,
        isPhysical: true,
    },
    {
        name: 'mc_dismount',
        description: 'Get off/dismount the entity currently being ridden.',
        disabled: false,
        layer: '',
        effect: {},
        arguments: [],
        category: 'movement',
        isQuick: true,
        isPhysical: false,
    },
];
