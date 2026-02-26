import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';

export interface WorldState {
    position: { x: number; y: number; z: number };
    health: number;
    food: number;
    experience: { level: number; points: number };
    biome: string;
    dimension: string;
    timeOfDay: number;
    isDay: boolean;
    isRaining: boolean;
    heldItem: string | null;
    armor: string[]; // Equipped armor pieces
    nearbyPlayers: NearbyEntity[];
    nearbyMobs: NearbyEntity[];
    inventorySummary: string[];
    shelter: string;
}

export interface NearbyEntity {
    name: string;
    type: string;
    distance: number;
    position: { x: number; y: number; z: number };
}

export function readWorldState(bot: Bot, entityRange: number): WorldState {
    const pos = bot.entity.position;

    // Nearby entities
    const nearbyPlayers: NearbyEntity[] = [];
    const nearbyMobs: NearbyEntity[] = [];

    for (const entity of Object.values(bot.entities)) {
        if (entity === bot.entity) continue;
        const dist = entity.position.distanceTo(pos);
        if (dist > entityRange) continue;

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
        } else if (entity.type === 'mob' || entity.type === 'hostile') {
            // Skip mobs that are more than 5 blocks above/below (likely underground or on different level)
            const yDiff = Math.abs(entity.position.y - pos.y);
            if (yDiff <= 5) {
                nearbyMobs.push(entry);
            }
        }
    }

    // Sort by distance
    nearbyPlayers.sort((a, b) => a.distance - b.distance);
    nearbyMobs.sort((a, b) => a.distance - b.distance);

    // Inventory summary
    const inventorySummary: string[] = [];
    for (const item of bot.inventory.items()) {
        inventorySummary.push(`${item.name} x${item.count}`);
    }

    // Biome
    let biome = 'unknown';
    try {
        const block = bot.blockAt(pos);
        if (block) {
            biome = block.biome?.name ?? 'unknown';
        }
    } catch {
        // biome read can fail before chunks load
    }

    // Shelter detection
    const HOME_BLOCKS = [
        'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
        'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
        'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed',
        'furnace', 'chest', 'crafting_table', 'barrel', 'smoker', 'blast_furnace',
        'torch', 'wall_torch', 'lantern', 'soul_lantern',
    ];
    let hasRoof = false;
    try {
        for (let dy = 1; dy <= 6; dy++) {
            const above = bot.blockAt(pos.offset(0, dy, 0));
            if (above && above.name !== 'air' && above.name !== 'cave_air') {
                hasRoof = true;
                break;
            }
        }
    } catch { /* chunk not loaded */ }

    const nearbyHomeBlocks: string[] = [];
    try {
        const searchRadius = 8;
        for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
            for (let dy = -2; dy <= 3; dy++) {
                for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (block && HOME_BLOCKS.includes(block.name)) {
                        const label = block.name.replace(/_/g, ' ');
                        if (!nearbyHomeBlocks.includes(label)) {
                            nearbyHomeBlocks.push(label);
                        }
                    }
                }
            }
        }
    } catch { /* chunk not loaded */ }

    let shelter = 'outdoors';
    if (hasRoof && nearbyHomeBlocks.length > 0) {
        shelter = `indoors, inside shelter (${nearbyHomeBlocks.join(', ')} nearby)`;
    } else if (hasRoof) {
        shelter = 'indoors (roof overhead)';
    } else if (nearbyHomeBlocks.length > 0) {
        shelter = `near shelter (${nearbyHomeBlocks.join(', ')} nearby)`;
    }

    return {
        position: {
            x: Math.round(pos.x),
            y: Math.round(pos.y),
            z: Math.round(pos.z),
        },
        health: Math.round(bot.health * 10) / 10,
        food: bot.food,
        experience: {
            level: bot.experience.level,
            points: bot.experience.points,
        },
        biome,
        dimension: bot.game.dimension,
        timeOfDay: bot.time.timeOfDay,
        isDay: bot.time.isDay,
        isRaining: bot.isRaining,
        heldItem: bot.heldItem?.name ?? null,
        armor: [
            bot.inventory.slots[5]?.name,  // head
            bot.inventory.slots[6]?.name,  // chest
            bot.inventory.slots[7]?.name,  // legs
            bot.inventory.slots[8]?.name,  // feet
        ].filter((name): name is string => !!name),
        nearbyPlayers,
        nearbyMobs,
        inventorySummary,
        shelter,
    };
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

export function buildContextStrings(
    state: WorldState,
    names: NameRegistry,
    characterName: string | null,
): string[] {
    const lines: string[] = [];
    const who = characterName ?? 'Bot';
    const timeStr = ticksToTime(state.timeOfDay);

    lines.push(
        `${who}'s position: ${state.position.x}, ${state.position.y}, ${state.position.z} | ` +
        `Biome: ${state.biome} | Dimension: ${state.dimension}`
    );

    lines.push(
        `Health: ${state.health}/20 | Food: ${state.food}/20 | ` +
        `Level: ${state.experience.level} | Time: ${state.isDay ? 'Day' : 'Night'} (${timeStr}) | ` +
        `Weather: ${state.isRaining ? 'Raining' : 'Clear'} | ` +
        `Location: ${state.shelter}`
    );

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

    if (state.heldItem) {
        lines.push(`Holding: ${state.heldItem}`);
    }

    if (state.armor.length > 0) {
        lines.push(`Armor: ${state.armor.map((a) => a.replace(/_/g, ' ')).join(', ')}`);
    } else {
        lines.push('Armor: none');
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
    }

    if (state.inventorySummary.length > 0) {
        lines.push(`Inventory: ${state.inventorySummary.join(', ')}`);
    } else {
        lines.push('Inventory: empty');
    }

    return lines;
}
