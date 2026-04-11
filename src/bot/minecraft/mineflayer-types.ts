/**
 * Extended type declarations for Mineflayer properties that exist at runtime
 * but are missing from the official TypeScript definitions.
 *
 * Instead of scattering `(bot as unknown as { vehicle: ... }).vehicle` casts
 * throughout the codebase, import these typed accessors. If Mineflayer ever
 * adds these to their official types, we can remove this file and update
 * the call sites.
 */
import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { Client } from 'minecraft-protocol';

// ---- Extended Bot properties ----

/** The entity the bot is currently riding, or null */
export function getVehicle(bot: Bot): (Entity & VehicleEntity) | null {
    return (bot as unknown as BotExtended).vehicle ?? null;
}

/** Manually set/clear bot.vehicle — needed for mineflayer's stale state workaround */
export function setVehicle(bot: Bot, vehicle: Entity | null): void {
    (bot as unknown as BotExtended).vehicle = vehicle as (Entity & VehicleEntity) | null;
}

/** The low-level minecraft-protocol client for sending raw packets */
export function getClient(bot: Bot): Client {
    return (bot as unknown as BotExtended)._client;
}

/** Custom follow distance property (set by us for dual-bot spacing) */
export function getFollowDistance(bot: Bot): number {
    return (bot as unknown as BotExtended).followDistance ?? 3;
}

/** Set custom follow distance for dual-bot spacing */
export function setFollowDistance(bot: Bot, distance: number): void {
    (bot as unknown as BotExtended).followDistance = distance;
}

/** The minecraft-data registry attached to the bot instance */
export function getRegistry(bot: Bot): Record<string, unknown> {
    return (bot as unknown as BotExtended).registry;
}

// ---- Extended Entity properties ----

/** Get the vehicle an entity (player/mob) is riding */
export function getEntityVehicle(entity: Entity): (Entity & VehicleEntity) | null {
    return (entity as unknown as EntityExtended).vehicle ?? null;
}

/** Set an entity's vehicle (used for stale state workaround on dismount) */
export function setEntityVehicle(entity: Entity, vehicle: Entity | null): void {
    (entity as unknown as EntityExtended).vehicle = vehicle as (Entity & VehicleEntity) | null;
}

/** Check if an entity is in water */
export function isInWater(entity: Entity): boolean {
    return (entity as unknown as EntityExtended).isInWater ?? false;
}

/** Check if an entity is in lava */
export function isInLava(entity: Entity): boolean {
    return (entity as unknown as EntityExtended).isInLava ?? false;
}

/** Get the entity's kind classification (e.g., "Hostile mobs") — used by some MC versions */
export function getEntityKind(entity: Entity): string | undefined {
    return (entity as unknown as EntityExtended).kind;
}

/** Get passenger entity IDs for a vehicle entity */
export function getPassengers(entity: Entity): { id: number }[] {
    return (entity as unknown as EntityExtended).passengers ?? [];
}

// ---- Internal type definitions (not exported — use the accessors above) ----

interface VehicleEntity {
    position: { x: number; y: number; z: number; distanceTo: (pos: { x: number; y: number; z: number }) => number };
    displayName?: string;
    name?: string;
    id: number;
    attributes?: Record<string, { value: number }>;
}

interface BotExtended {
    vehicle: (Entity & VehicleEntity) | null;
    _client: Client;
    followDistance?: number;
    registry: Record<string, unknown>;
}

interface EntityExtended {
    vehicle: (Entity & VehicleEntity) | null;
    isInWater?: boolean;
    isInLava?: boolean;
    kind?: string;
    passengers?: { id: number }[];
}
