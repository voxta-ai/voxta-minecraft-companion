import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import { BED_BLOCKS } from './game-data';
import { getCurrentActivity, getBotMode, getHomePosition } from './actions/action-state.js';
import { getVehicle, isInWater, isInLava } from './mineflayer-types';
import { isPositionFinite, normalizeEffects } from './utils';

// ---- Perception constants ----
const MOB_DETECTION_Y_MIN = -2;       // Below bot for mob scanning
const MOB_DETECTION_Y_MAX = 10;       // Above bot — flying mobs (phantoms)
const DEFAULT_BIOME_TEMP = 0.5;       // Temperate fallback
const NOTABLE_BLOCKS_RADIUS = 8;      // Scan radius for utility blocks
const NOTABLE_BLOCKS_Y_MIN = -2;
const NOTABLE_BLOCKS_Y_MAX = 3;
const ORE_SCAN_RADIUS = 16;           // Wider radius for resource awareness
const ORE_SCAN_Y_MIN = -3;
const ORE_SCAN_Y_MAX = 3;
const ROOF_CHECK_MAX_Y = 6;           // How high to look for a roof above bot
const CAVE_BLOCK_RATIO_THRESHOLD = 0.6; // Fraction of natural stone to count as cave
const SNOW_TEMP_THRESHOLD = 0.15;     // Below this biome temp → "Snowing" instead of "Raining"
const EYE_HEIGHT_RATIO = 0.85;        // Bot eye position as fraction of entity height
const ENTITY_CENTER_RATIO = 0.5;      // Target center for LOS checks
const MIN_LOS_DISTANCE = 1;           // Below this, LOS is always true
const LOS_STEP_SIZE = 0.5;            // Ray-cast increment in blocks
const MC_MAX_HEALTH = 20;             // Minecraft max health/food
const MOVEMENT_SPRINT_THRESHOLD = 0.15;
const MOVEMENT_WALK_THRESHOLD = 0.05;
const FALL_VELOCITY_THRESHOLD = -0.1;
const JUMP_VELOCITY_THRESHOLD = 0.1;
const NEARBY_MOBS_DISPLAY_LIMIT = 10;
const TICKS_PER_MC_HOUR = 1000;       // Each 1000 ticks = 1 in-game hour
const MC_TIME_OFFSET_MINUTES = 360;   // tick 0 = 6:00 AM = 360 minutes

export interface WorldState {
    position: { x: number; y: number; z: number } | null;
    health: number;
    food: number;
    experience: { level: number; points: number };
    gameMode: string;
    biome: string;
    biomeTemperature: number;
    dimension: string;
    timeOfDay: number;
    isDay: boolean;
    isRaining: boolean;
    isThundering: boolean;
    heldItem: string | null;
    armor: string[]; // Equipped armor pieces
    nearbyPlayers: NearbyEntity[];
    nearbyMobs: NearbyEntity[];
    inventorySummary: string[];
    nearbyBlocks: string[];
    shelter: string;
    currentActivity: string | null;
    botMode: string;
    homePosition: { x: number; y: number; z: number } | null;
    movement: string;
    oxygenLevel: number;
    isSleeping: boolean;
    activeEffects: string[]; // e.g. ["Poison II (0:15)", "Slowness (1:30)"]
    riding: string | null; // Name of entity being ridden, or null
}

export interface NearbyEntity {
    name: string;
    type: string;
    distance: number;
    position: { x: number; y: number; z: number };
}

export function readWorldState(bot: Bot, entityRange: number): WorldState {
    const pos = bot.entity.position;

    // Guard: bot position can go NaN after combat/respawn — skip entity
    // scanning entirely so NaN doesn't propagate to distances and context.
    const positionValid = isPositionFinite(pos);

    // Nearby entities
    const nearbyPlayers: NearbyEntity[] = [];
    const nearbyMobs: NearbyEntity[] = [];

    if (positionValid) {
    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        const dist = entity.position.distanceTo(pos);
        if (!Number.isFinite(dist) || dist > entityRange) continue;

        const entry: NearbyEntity = {
            name: entity.username ?? entity.displayName ?? entity.name ?? 'unknown',
            type: entity.type ?? 'unknown',
            distance: Math.round(dist * 10) / 10,
            position: {
                x: Math.round(entity.position.x),
                y: Math.round(entity.position.y),
                z: Math.round(entity.position.z),
            },
        };

        if (entity.type === 'player') {
            nearbyPlayers.push(entry);
        } else if (
            entity.type !== 'orb' &&
            entity.type !== 'projectile' &&
            entity.type !== 'object' &&
            entity.type !== 'global'
        ) {
            // Include all living entities (mob, hostile, animal, passive, other, etc.)
            // Skip dropped items — they show as "Item" but aren't mobs
            const eName = entry.name.toLowerCase();
            if (eName === 'item' || eName === 'unknown') continue;
            // Asymmetric Y: 10 above (flying mobs) but only 2 below (avoid sensing underground caves)
            const yDiff = entity.position.y - pos.y;
            if (yDiff >= MOB_DETECTION_Y_MIN && yDiff <= MOB_DETECTION_Y_MAX) {
                nearbyMobs.push(entry);
            }
        }
    }
    } // end positionValid guard

    // Sort by distance
    nearbyPlayers.sort((a, b) => a.distance - b.distance);
    nearbyMobs.sort((a, b) => a.distance - b.distance);

    // Inventory summary
    const inventorySummary: string[] = [];
    for (const item of bot.inventory.items()) {
        inventorySummary.push(`${item.displayName ?? item.name} x${item.count}`);
    }

    // Biome — prismarine-biome often returns an empty name, so fall back to ID lookup
    let biome = 'unknown';
    let biomeTemperature = DEFAULT_BIOME_TEMP; // default to temperate
    try {
        const block = bot.blockAt(pos);
        if (block?.biome) {
            const b = block.biome as { id?: number; displayName?: string; name?: string; temperature?: number };
            biomeTemperature = b.temperature ?? DEFAULT_BIOME_TEMP;
            let raw = b.displayName || b.name || '';
            // If the name is empty, but we have an ID, look it up via minecraft-data
            if (!raw && b.id != null) {
                const mcData = require('minecraft-data')(bot.version);
                const biomeData = mcData.biomes?.[b.id] ?? mcData.biomesByName?.[b.id];
                raw = biomeData?.displayName || biomeData?.name || '';
                if (biomeData?.temperature != null) biomeTemperature = biomeData.temperature;
            }
            biome = raw.replace(/^minecraft:/, '').replace(/_/g, ' ') || 'unknown';
        }
    } catch {
        // biome read can fail before chunks load
    }

    // Notable block detection — blocks that indicate structures and provide utility
    const NOTABLE_BLOCKS: Record<string, string> = {
        // Beds (from a shared BED_BLOCKS list)
        ...Object.fromEntries(BED_BLOCKS.map((b) => [b, 'bed'])),
        // Crafting & Smelting
        crafting_table: 'crafting table',
        furnace: 'furnace',
        blast_furnace: 'blast furnace',
        smoker: 'smoker',
        campfire: 'campfire',
        soul_campfire: 'soul campfire',
        // Storage
        chest: 'chest',
        trapped_chest: 'trapped chest',
        barrel: 'barrel',
        ender_chest: 'ender chest',
        shulker_box: 'shulker box',
        // Enchanting & Brewing
        enchanting_table: 'enchanting table',
        brewing_stand: 'brewing stand',
        anvil: 'anvil',
        chipped_anvil: 'anvil',
        damaged_anvil: 'anvil',
        grindstone: 'grindstone',
        smithing_table: 'smithing table',
        loom: 'loom',
        cartography_table: 'cartography table',
        stonecutter: 'stonecutter',
        // Lighting
        torch: 'torch',
        wall_torch: 'torch',
        lantern: 'lantern',
        soul_lantern: 'soul lantern',
        // Redstone
        note_block: 'note block',
        jukebox: 'jukebox',
        // Farming
        composter: 'composter',
        beehive: 'beehive',
        bee_nest: 'bee nest',
        // Decoration
        flower_pot: 'flower pot',
        bookshelf: 'bookshelf',
    };

    // Ore blocks — scanned at a wider radius (16) for resource awareness
    const ORE_BLOCKS: Record<string, string> = {
        coal_ore: 'coal ore',
        deepslate_coal_ore: 'coal ore',
        iron_ore: 'iron ore',
        deepslate_iron_ore: 'iron ore',
        gold_ore: 'gold ore',
        deepslate_gold_ore: 'gold ore',
        diamond_ore: 'diamond ore',
        deepslate_diamond_ore: 'diamond ore',
        emerald_ore: 'emerald ore',
        deepslate_emerald_ore: 'emerald ore',
        lapis_ore: 'lapis ore',
        deepslate_lapis_ore: 'lapis ore',
        redstone_ore: 'redstone ore',
        deepslate_redstone_ore: 'redstone ore',
        copper_ore: 'copper ore',
        deepslate_copper_ore: 'copper ore',
        nether_quartz_ore: 'nether quartz ore',
        nether_gold_ore: 'nether gold ore',
        ancient_debris: 'ancient debris',
    };

    let hasRoof = false;
    try {
        for (let dy = 1; dy <= ROOF_CHECK_MAX_Y; dy++) {
            const above = bot.blockAt(pos.offset(0, dy, 0));
            if (above && above.name !== 'air' && above.name !== 'cave_air') {
                hasRoof = true;
                break;
            }
        }
    } catch {
        /* chunk not loaded */
    }

    // Natural cave/underground blocks — used to detect if the bot is in a cave
    const CAVE_BLOCKS = new Set([
        'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff',
        'calcite', 'dripstone_block', 'pointed_dripstone', 'moss_block',
        'clay', 'gravel', 'dirt', 'coarse_dirt', 'rooted_dirt',
        'smooth_basalt', 'basalt', 'blackstone', 'netherrack', 'soul_sand', 'soul_soil',
        'cobbled_deepslate', 'infested_stone', 'infested_deepslate',
    ]);

    // Scan for notable blocks within a radius
    const blockCounts = new Map<string, number>();
    const shelterBlockLabels: string[] = [];
    let caveBlockCount = 0;
    let solidWallCount = 0;
    try {
        for (let dx = -NOTABLE_BLOCKS_RADIUS; dx <= NOTABLE_BLOCKS_RADIUS; dx++) {
            for (let dy = NOTABLE_BLOCKS_Y_MIN; dy <= NOTABLE_BLOCKS_Y_MAX; dy++) {
                for (let dz = -NOTABLE_BLOCKS_RADIUS; dz <= NOTABLE_BLOCKS_RADIUS; dz++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block) continue;

                    // Count cave-like blocks for environment detection
                    if (block.boundingBox === 'block') {
                        solidWallCount++;
                        if (CAVE_BLOCKS.has(block.name)) caveBlockCount++;
                    }

                    const label = NOTABLE_BLOCKS[block.name];
                    if (!label) continue;
                    blockCounts.set(label, (blockCounts.get(label) ?? 0) + 1);
                    if (!shelterBlockLabels.includes(label)) {
                        shelterBlockLabels.push(label);
                    }
                }
            }
        }
    } catch {
        /* chunk not loaded */
    }

    // Scan for ore blocks at a wider radius — ores on surfaces are resource opportunities
    const oreCounts = new Map<string, number>();
    try {
        for (let dx = -ORE_SCAN_RADIUS; dx <= ORE_SCAN_RADIUS; dx++) {
            for (let dy = ORE_SCAN_Y_MIN; dy <= ORE_SCAN_Y_MAX; dy++) {
                for (let dz = -ORE_SCAN_RADIUS; dz <= ORE_SCAN_RADIUS; dz++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block) continue;
                    const oreLabel = ORE_BLOCKS[block.name];
                    if (oreLabel) {
                        oreCounts.set(oreLabel, (oreCounts.get(oreLabel) ?? 0) + 1);
                    }
                }
            }
        }
    } catch {
        /* chunk not loaded */
    }

    // Merge ore counts into block counts for the summary
    for (const [label, count] of oreCounts) {
        blockCounts.set(label, (blockCounts.get(label) ?? 0) + count);
    }

    // Build nearby blocks summary (skip torches — too noisy)
    const nearbyBlocks = Array.from(blockCounts.entries())
        .filter(([label]) => label !== 'torch')
        .map(([label, count]) => (count > 1 ? `${label} x${count}` : label));

    // Determine if we're in a cave: roof is present AND most surrounding solid
    // blocks are natural stone/deepslate rather than player-placed materials
    const isCave = hasRoof && solidWallCount > 0 && (caveBlockCount / solidWallCount) > CAVE_BLOCK_RATIO_THRESHOLD;

    let shelter = 'outdoors';
    if (hasRoof && isCave && shelterBlockLabels.length > 0) {
        shelter = `underground cave (${shelterBlockLabels.join(', ')} nearby)`;
    } else if (hasRoof && isCave) {
        shelter = 'underground cave';
    } else if (hasRoof && shelterBlockLabels.length > 0) {
        shelter = `indoors, inside shelter (${shelterBlockLabels.join(', ')} nearby)`;
    } else if (hasRoof) {
        shelter = 'indoors (roof overhead)';
    } else if (shelterBlockLabels.length > 0) {
        shelter = `near shelter (${shelterBlockLabels.join(', ')} nearby)`;
    }

    // Riding state — bot.vehicle exists at runtime but is missing from TS types
    const vehicle = getVehicle(bot);
    const riding = vehicle ? (vehicle.displayName ?? vehicle.name ?? 'something') : null;

    // Movement state — physical body status
    let movement = 'standing';
    if (riding) {
        movement = `riding a ${riding}`;
    } else if (bot.isSleeping) {
        movement = 'sleeping';
    } else if (isInLava(bot.entity)) {
        movement = 'in lava';
    } else if (isInWater(bot.entity)) {
        movement = 'swimming';
    } else if (!bot.entity.onGround && bot.entity.velocity.y < FALL_VELOCITY_THRESHOLD) {
        movement = 'falling';
    } else if (!bot.entity.onGround && bot.entity.velocity.y > JUMP_VELOCITY_THRESHOLD) {
        movement = 'jumping';
    } else {
        const vel = bot.entity.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        if (speed > MOVEMENT_SPRINT_THRESHOLD) {
            movement = 'sprinting';
        } else if (speed > MOVEMENT_WALK_THRESHOLD) {
            movement = 'walking';
        }
    }

    return {
        position: positionValid
            ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
            : null,
        health: Math.round(bot.health * 10) / 10,
        food: bot.food,
        experience: {
            level: bot.experience.level,
            points: bot.experience.points,
        },
        gameMode: bot.game.gameMode,
        biome,
        biomeTemperature,
        dimension: bot.game.dimension,
        timeOfDay: bot.time.timeOfDay,
        isDay: bot.time.isDay,
        isRaining: bot.isRaining,
        isThundering: bot.thunderState > 0,
        heldItem: bot.heldItem?.name ?? null,
        armor: [
            bot.inventory.slots[5]?.name, // head
            bot.inventory.slots[6]?.name, // chest
            bot.inventory.slots[7]?.name, // legs
            bot.inventory.slots[8]?.name, // feet
        ].filter((name): name is string => !!name),
        nearbyPlayers,
        nearbyMobs,
        inventorySummary,
        nearbyBlocks,
        shelter,
        currentActivity: getCurrentActivity(bot),
        botMode: getBotMode(bot),
        homePosition: getHomePosition(bot),
        movement,
        oxygenLevel: bot.oxygenLevel ?? MC_MAX_HEALTH,
        isSleeping: bot.isSleeping,
        activeEffects: readActiveEffects(bot),
        riding,
    };
}

/** Map of Minecraft effect IDs to human-readable names */
const EFFECT_NAMES: Record<number, string> = {
    1: 'Speed', 2: 'Slowness', 3: 'Haste', 4: 'Mining Fatigue',
    5: 'Strength', 6: 'Instant Health', 7: 'Instant Damage',
    8: 'Jump Boost', 9: 'Nausea', 10: 'Regeneration',
    11: 'Resistance', 12: 'Fire Resistance', 13: 'Water Breathing',
    14: 'Invisibility', 15: 'Blindness', 16: 'Night Vision',
    17: 'Hunger', 18: 'Weakness', 19: 'Poison', 20: 'Wither',
    21: 'Health Boost', 22: 'Absorption', 23: 'Saturation',
    24: 'Glowing', 25: 'Levitation', 26: 'Luck', 27: 'Bad Luck',
    28: 'Slow Falling', 29: 'Conduit Power', 30: 'Dolphins Grace',
    31: 'Bad Omen', 32: 'Hero of the Village', 33: 'Darkness',
};

/** Read active potion/status effects from the bot entity */
function readActiveEffects(bot: Bot): string[] {
    const raw = bot.entity.effects;
    const effects = normalizeEffects(raw) as Array<{ id: number; amplifier: number; duration: number }>;
    if (effects.length === 0) return [];

    return effects.map((e) => {
        const name = EFFECT_NAMES[e.id] ?? `Effect #${e.id}`;
        const level = e.amplifier > 0 ? ` ${toRoman(e.amplifier + 1)}` : '';
        const secs = Math.max(0, Math.floor(e.duration / 20)); // ticks → seconds
        const mins = Math.floor(secs / 60);
        const remaining = secs % 60;
        const time = `${mins}:${String(remaining).padStart(2, '0')}`;
        return `${name}${level} (${time})`;
    });
}

/** Convert number to roman numeral (for effect levels) */
function toRoman(n: number): string {
    if (n <= 1) return '';
    if (n === 2) return 'II';
    if (n === 3) return 'III';
    if (n === 4) return 'IV';
    if (n === 5) return 'V';
    return String(n);
}

/** Map tick ranges to natural time-of-day periods */
function getTimePeriod(ticks: number): string {
    // MC ticks: 0 = 6:00 AM, 6000 = noon, 12000 = 6:00 PM, 18000 = midnight
    if (ticks < 1000) return 'Dawn';           // 6:00 – 7:00 AM
    if (ticks < 5000) return 'Morning';         // 7:00 – 11:00 AM
    if (ticks < 7000) return 'Midday';          // 11:00 AM – 1:00 PM
    if (ticks < 11000) return 'Afternoon';      // 1:00 – 5:00 PM
    if (ticks < 13000) return 'Dusk';           // 5:00 – 7:00 PM
    if (ticks < 17000) return 'Night';          // 7:00 – 11:00 PM
    if (ticks < 19000) return 'Midnight';       // 11:00 PM – 1:00 AM
    return 'Late Night';                        // 1:00 – 6:00 AM
}

/** Build a human-readable weather string from world state */
function getWeatherString(state: WorldState): string {
    if (!state.isRaining) return 'Clear';
    const isSnow = state.biomeTemperature < SNOW_TEMP_THRESHOLD;
    if (state.isThundering) return isSnow ? 'Blizzard' : 'Thunderstorm';
    return isSnow ? 'Snowing' : 'Raining';
}

/** Convert Minecraft ticks (0-24000) to human-readable time like "7:30 AM" */
function ticksToTime(ticks: number): string {
    // MC tick 0 = 6:00 AM, tick 6000 = noon, tick 12000 = 6:00 PM, tick 18000 = midnight
    const mcMinutes = (ticks / TICKS_PER_MC_HOUR) * 60;
    const totalMinutes = Math.floor(mcMinutes) + MC_TIME_OFFSET_MINUTES;
    const hours24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const period = hours24 >= 12 ? 'PM' : 'AM';
    const hours12 = hours24 % 12 || 12;
    return `${hours12}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function buildContextStrings(state: WorldState, names: NameRegistry, characterName: string | null): string[] {
    const lines: string[] = [];
    const who = characterName ?? 'Bot';
    const timeStr = ticksToTime(state.timeOfDay);

    const posStr = state.position
        ? `${state.position.x}, ${state.position.y}, ${state.position.z}`
        : 'unknown';
    lines.push(
        `${who}'s position: ${posStr} | ` +
            `Game Mode: ${state.gameMode} | Biome: ${state.biome} | Dimension: ${state.dimension}`,
    );

    lines.push(
        `${who}'s Health: ${state.health}/${MC_MAX_HEALTH} | ${who}'s Food: ${state.food}/${MC_MAX_HEALTH} | ` +
            `Level: ${state.experience.level} | Time: ${getTimePeriod(state.timeOfDay)} (${timeStr}) | ` +
            `Weather: ${getWeatherString(state)} | ` +
            `Location: ${state.shelter}`,
    );

    // Current activity (task-level)
    const activity = state.currentActivity ?? 'idle';
    lines.push(`${who}'s current activity: ${activity}`);

    // Behavior mode
    const mode = state.botMode;
    if (mode !== 'passive') {
        let modeDesc: string;
        if (mode === 'aggro') {
            modeDesc = 'AGGRO MODE — actively seeking and attacking hostile mobs while following';
        } else if (mode === 'hunt') {
            modeDesc = 'HUNT MODE — hunting farm animals (pigs, cows, sheep, chickens, rabbits) for food';
        } else {
            modeDesc = 'GUARD MODE — patrolling and defending this area';
        }
        lines.push(`${who}'s behavior mode: ${modeDesc}`);
    }

    // Home status
    const home = state.homePosition;
    if (home && state.position) {
        const dx = state.position.x - home.x;
        const dz = state.position.z - home.z;
        const homeDist = Math.round(Math.sqrt(dx * dx + dz * dz));
        lines.push(`Home bed: set at ${home.x}, ${home.y}, ${home.z} (${homeDist} blocks away)`);
    } else {
        lines.push('Home bed: not set (no bed slept in yet)');
    }

    // Movement (physical state)
    lines.push(`${who}'s movement: ${state.movement}`);

    // Riding status — tell AI explicitly so it knows to use mc_dismount
    if (state.riding) {
        const isBoat = state.riding.toLowerCase().includes('boat');
        if (isBoat) {
            lines.push(`${who} is currently riding a ${state.riding}. ${who} cannot steer boats — only ride as a passenger. Use mc_dismount to get off.`);
        } else {
            lines.push(`${who} is currently riding a ${state.riding}. Use mc_dismount to get off.`);
        }
    }

    // Game mode rules — help AI understand what's possible
    if (state.gameMode === 'creative') {
        lines.push(
            'GAME MODE RULES (Creative): You have unlimited items — do NOT mine, gather, or craft. ' +
                'You are invulnerable. Focus on building, exploring, and conversation.',
        );
    } else if (state.gameMode === 'adventure') {
        lines.push(
            'GAME MODE RULES (Adventure): You cannot break or place blocks. ' +
                'Focus on exploration, combat, and interaction.',
        );
    }

    // Survival status warnings — helps AI understand Minecraft mechanics
    const warnings: string[] = [];
    if (state.food === 0) {
        warnings.push('CRITICAL: Starving! Taking damage from hunger. Must eat food immediately!');
    } else if (state.food <= 6) {
        warnings.push('WARNING: Very hungry, should eat food soon to avoid starvation.');
    } else if (state.food <= 14) {
        warnings.push('Note: Could eat food to restore hunger bar.');
    }

    if (state.health <= 4) {
        warnings.push(`CRITICAL: Very low health (${state.health}/${MC_MAX_HEALTH})! In danger of dying.`);
    } else if (state.health <= 10) {
        warnings.push(`WARNING: Low health (${state.health}/${MC_MAX_HEALTH}). Eating food helps regenerate health.`);
    } else if (state.health < MC_MAX_HEALTH && state.food >= 18) {
        warnings.push('Health regenerating from food.');
    }

    if (warnings.length > 0) {
        lines.push(warnings.join(' | '));
    }

    // Active status effects
    if (state.activeEffects.length > 0) {
        lines.push(`${who}'s active effects: ${state.activeEffects.join(', ')}`);
    }

    if (state.heldItem) {
        lines.push(`${who} is holding: ${state.heldItem}`);
    }

    if (state.armor.length > 0) {
        lines.push(`${who}'s armor: ${state.armor.map((a) => a.replace(/_/g, ' ')).join(', ')}`);
    } else {
        lines.push(`${who}'s armor: none`);
    }

    if (state.nearbyPlayers.length > 0) {
        const playerList = state.nearbyPlayers
            .map((p) => {
                const voxtaName = names.resolveToVoxta(p.name);
                return `${voxtaName} (${p.distance}m away at ${p.position.x},${p.position.y},${p.position.z})`;
            })
            .join(', ');
        lines.push(`Nearby players: ${playerList}`);
    }

    if (state.nearbyMobs.length > 0) {
        const mobList = state.nearbyMobs
            .slice(0, NEARBY_MOBS_DISPLAY_LIMIT)
            .map((m) => `${m.name} (${m.distance}m)`)
            .join(', ');
        lines.push(`Nearby mobs: ${mobList}`);
    } else {
        lines.push('Nearby mobs: none');
    }

    if (state.inventorySummary.length > 0) {
        lines.push(`${who}'s inventory: ${state.inventorySummary.join(', ')}`);
    } else {
        lines.push(`${who}'s inventory: empty`);
    }

    if (state.nearbyBlocks.length > 0) {
        lines.push(`Nearby blocks: ${state.nearbyBlocks.join(', ')}`);
    }

    return lines;
}

/**
 * Simple block raycast to check if there's a clear line of sight between
 * the bot's eye position and the target entity. Steps along the ray in
 * 0.5-block increments and checks for solid (non-transparent) blocks.
 * Returns false if a solid wall is in the way.
 */
export function hasLineOfSight(bot: Bot, target: Entity): boolean {
    const eyePos = bot.entity.position.offset(0, bot.entity.height * EYE_HEIGHT_RATIO, 0);
    const targetPos = target.position.offset(0, (target.height ?? 1) * ENTITY_CENTER_RATIO, 0);
    const dx = targetPos.x - eyePos.x;
    const dy = targetPos.y - eyePos.y;
    const dz = targetPos.z - eyePos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < MIN_LOS_DISTANCE) return true; // Too close to have a wall between

    const steps = Math.ceil(dist / LOS_STEP_SIZE);
    const sx = dx / steps;
    const sy = dy / steps;
    const sz = dz / steps;

    let prevBx = NaN;
    let prevBy = NaN;
    let prevBz = NaN;
    const checkPos = eyePos.clone();

    for (let i = 1; i < steps; i++) {
        const bx = Math.floor(eyePos.x + sx * i);
        const by = Math.floor(eyePos.y + sy * i);
        const bz = Math.floor(eyePos.z + sz * i);

        // Skip if same block as previous step
        if (bx === prevBx && by === prevBy && bz === prevBz) continue;
        prevBx = bx;
        prevBy = by;
        prevBz = bz;

        try {
            checkPos.set(bx, by, bz);
            const block = bot.blockAt(checkPos);
            if (block && block.boundingBox === 'block') return false;
        } catch {
            // Chunk not loaded — assume blocked
            return false;
        }
    }
    return true;
}
