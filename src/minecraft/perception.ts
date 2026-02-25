import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';

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
    nearbyPlayers: NearbyEntity[];
    nearbyMobs: NearbyEntity[];
    inventorySummary: string[];
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
            nearbyMobs.push(entry);
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
        nearbyPlayers,
        nearbyMobs,
        inventorySummary,
    };
}

export function buildContextStrings(state: WorldState): string[] {
    const lines: string[] = [];

    lines.push(
        `Bot position: ${state.position.x}, ${state.position.y}, ${state.position.z} | ` +
        `Biome: ${state.biome} | Dimension: ${state.dimension}`
    );

    lines.push(
        `Health: ${state.health}/20 | Food: ${state.food}/20 | ` +
        `Level: ${state.experience.level} | Time: ${state.isDay ? 'Day' : 'Night'} (${state.timeOfDay}) | ` +
        `Weather: ${state.isRaining ? 'Raining' : 'Clear'}`
    );

    if (state.heldItem) {
        lines.push(`Holding: ${state.heldItem}`);
    }

    if (state.nearbyPlayers.length > 0) {
        const playerList = state.nearbyPlayers
            .map((p) => `${p.name} (${p.distance}m away at ${p.position.x},${p.position.y},${p.position.z})`)
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
