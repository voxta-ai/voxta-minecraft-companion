import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import { BED_BLOCKS } from './game-data';
import { getCurrentActivity, getBotMode, getHomePosition } from './actions';

export interface WorldState {
    position: { x: number; y: number; z: number };
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
    heldItem: string | null;
    armor: string[]; // Equipped armor pieces
    nearbyPlayers: NearbyEntity[];
    nearbyMobs: NearbyEntity[];
    inventorySummary: string[];
    nearbyBlocks: string[];
    shelter: string;
    currentActivity: string | null;
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
    const positionValid = Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);

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
            if (yDiff >= -2 && yDiff <= 10) {
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
    let biomeTemperature = 0.5; // default to temperate
    try {
        const block = bot.blockAt(pos);
        if (block?.biome) {
            const b = block.biome as { id?: number; displayName?: string; name?: string; temperature?: number };
            biomeTemperature = b.temperature ?? 0.5;
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
    let roofBlockName = '';
    try {
        for (let dy = 1; dy <= 6; dy++) {
            const above = bot.blockAt(pos.offset(0, dy, 0));
            if (above && above.name !== 'air' && above.name !== 'cave_air') {
                hasRoof = true;
                roofBlockName = above.name;
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
        const searchRadius = 8;
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
            for (let dy = -2; dy <= 3; dy++) {
                for (let dz = -searchRadius; dz <= searchRadius; dz++) {
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
        const oreRadius = 16;
        for (let dx = -oreRadius; dx <= oreRadius; dx++) {
            for (let dy = -3; dy <= 3; dy++) {
                for (let dz = -oreRadius; dz <= oreRadius; dz++) {
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
    const isCave = hasRoof && solidWallCount > 0 && (caveBlockCount / solidWallCount) > 0.6;

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
    const vehicle = (bot as unknown as { vehicle: Entity | null }).vehicle ?? null;
    const riding = vehicle ? (vehicle.displayName ?? vehicle.name ?? 'something') : null;

    // Movement state — physical body status
    let movement = 'standing';
    const ent = bot.entity as Entity & { isInWater?: boolean; isInLava?: boolean };
    if (riding) {
        movement = `riding a ${riding}`;
    } else if (bot.isSleeping) {
        movement = 'sleeping';
    } else if (ent.isInLava) {
        movement = 'in lava';
    } else if (ent.isInWater) {
        movement = 'swimming';
    } else if (!bot.entity.onGround && bot.entity.velocity.y < -0.1) {
        movement = 'falling';
    } else if (!bot.entity.onGround && bot.entity.velocity.y > 0.1) {
        movement = 'jumping';
    } else {
        const vel = bot.entity.velocity;
        const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
        if (speed > 0.15) {
            movement = 'sprinting';
        } else if (speed > 0.05) {
            movement = 'walking';
        }
    }

    return {
        position: {
            x: positionValid ? Math.round(pos.x) : 0,
            y: positionValid ? Math.round(pos.y) : 0,
            z: positionValid ? Math.round(pos.z) : 0,
        },
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
        currentActivity: getCurrentActivity(),
        movement,
        oxygenLevel: bot.oxygenLevel ?? 20,
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
    if (!raw) return [];

    // effects may be an array or an object keyed by effect ID
    const effects: Array<{ id: number; amplifier: number; duration: number }> = Array.isArray(raw) ? raw : Object.values(raw);
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

/** Convert Minecraft ticks (0-24000) to human-readable time like "7:30 AM" */
function ticksToTime(ticks: number): string {
    // MC tick 0 = 6:00 AM, tick 6000 = noon, tick 12000 = 6:00 PM, tick 18000 = midnight
    const mcMinutes = (ticks / 1000) * 60; // each 1000 ticks = 1 hour
    const totalMinutes = Math.floor(mcMinutes) + 360; // offset: tick 0 = 6:00 AM (360 min)
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

    lines.push(
        `${who}'s position: ${state.position.x}, ${state.position.y}, ${state.position.z} | ` +
            `Game Mode: ${state.gameMode} | Biome: ${state.biome} | Dimension: ${state.dimension}`,
    );

    lines.push(
        `${who}'s Health: ${state.health}/20 | ${who}'s Food: ${state.food}/20 | ` +
            `Level: ${state.experience.level} | Time: ${state.isDay ? 'Day' : 'Night'} (${timeStr}) | ` +
            `Weather: ${state.isRaining ? (state.biomeTemperature < 0.15 ? 'Snowing' : 'Raining') : 'Clear'} | ` +
            `Location: ${state.shelter}`,
    );

    // Current activity (task-level)
    const activity = state.currentActivity ?? 'idle';
    lines.push(`${who}'s current activity: ${activity}`);

    // Behavior mode
    const mode = getBotMode();
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
    const home = getHomePosition();
    if (home) {
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
        warnings.push(`CRITICAL: Very low health (${state.health}/20)! In danger of dying.`);
    } else if (state.health <= 10) {
        warnings.push(`WARNING: Low health (${state.health}/20). Eating food helps regenerate health.`);
    } else if (state.health < 20 && state.food >= 18) {
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
            .slice(0, 10)
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
    const eyePos = bot.entity.position.offset(0, bot.entity.height * 0.85, 0);
    const targetPos = target.position.offset(0, (target.height ?? 1) * 0.5, 0);
    const dx = targetPos.x - eyePos.x;
    const dy = targetPos.y - eyePos.y;
    const dz = targetPos.z - eyePos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1) return true; // Too close to have a wall between

    const steps = Math.ceil(dist / 0.5);
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
