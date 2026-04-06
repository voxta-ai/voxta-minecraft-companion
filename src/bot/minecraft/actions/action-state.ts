import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot } from 'mineflayer';

// ---- Cancellation & busy tracking ----

let actionAbort = new AbortController();
export function getActionAbort(): AbortController {
    return actionAbort;
}
export function resetActionAbort(): AbortController {
    actionAbort.abort();
    actionAbort = new AbortController();
    return actionAbort;
}

// Tracks whether a physical action is running (mining, following, etc.)
let actionBusy = false;
export function isActionBusy(): boolean {
    return actionBusy;
}
export function setActionBusy(busy: boolean): void {
    actionBusy = busy;
}

// Suppress pickup notes during inventory management (equip/unequip in crafting)
let suppressPickups = false;
export function isPickupSuppressed(): boolean {
    return suppressPickups;
}
export function setSuppressPickups(value: boolean): void {
    suppressPickups = value;
}

// Human-readable description of what the bot is currently doing
let currentActivity: string | null = null;
export function getCurrentActivity(): string | null {
    return currentActivity;
}
export function setCurrentActivity(activity: string | null): void {
    currentActivity = activity;
}

// Current combat target — used to prevent duplicate mc_attack from cancelling
// an ongoing fight (e.g., auto-defense + AI action both targeting the same mob)
let currentCombatTarget: string | null = null;
export function getCurrentCombatTarget(): string | null {
    return currentCombatTarget;
}
export function setCurrentCombatTarget(target: string | null): void {
    currentCombatTarget = target;
}

// Auto-defense flag — when true, the event system is handling combat.
// AI-generated combat actions should be silently skipped to avoid spam loops.
let autoDefending = false;
export function isAutoDefending(): boolean {
    return autoDefending;
}
export function setAutoDefending(value: boolean): void {
    autoDefending = value;
}

// ---- Behavior mode ----

export type BotMode = 'passive' | 'aggro' | 'hunt' | 'guard';

let botMode: BotMode = 'passive';
export function getBotMode(): BotMode {
    return botMode;
}
export function setBotMode(mode: BotMode): void {
    botMode = mode;
    console.log(`[Bot] Mode changed to: ${mode}`);
}

// Guard center — the position the bot should patrol around in guard mode
let guardCenter: { x: number; y: number; z: number } | null = null;
export function getGuardCenter(): { x: number; y: number; z: number } | null {
    return guardCenter;
}
export function setGuardCenter(pos: { x: number; y: number; z: number } | null): void {
    guardCenter = pos;
}

// ---- Fishing callback ----

let onFishCaught: ((itemName: string, count: number) => void) | null = null;
export function getOnFishCaught(): ((itemName: string, count: number) => void) | null {
    return onFishCaught;
}
export function setFishCaughtCallback(cb: ((itemName: string, count: number) => void) | null): void {
    onFishCaught = cb;
}

// ---- Home position persistence ----

let homePosition: { x: number; y: number; z: number } | null = null;
let homeServerKey: string | null = null;
export function getHomePosition(): { x: number; y: number; z: number } | null {
    return homePosition;
}

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
export function initHomePosition(host: string, port: number, bot?: Bot): void {
    homeServerKey = `${host}:${port}`;
    const data = loadHomeData();
    const saved = data[homeServerKey];
    if (saved) {
        // Verify the bed still exists (world may have changed)
        if (bot) {
            const { Vec3 } = require('vec3');
            const block = bot.blockAt(new Vec3(saved.x, saved.y, saved.z));
            if (!block || !block.name.includes('bed')) {
                console.log(`[MC Action] Saved home at ${saved.x}, ${saved.y}, ${saved.z} is not a bed (found: ${block?.name ?? 'unloaded'}). Clearing stale data.`);
                homePosition = null;
                delete data[homeServerKey];
                saveHomeData(data);
                return;
            }
        }
        homePosition = saved;
        console.log(`[MC Action] Loaded home position for ${homeServerKey}: ${saved.x}, ${saved.y}, ${saved.z}`);
    } else {
        homePosition = null;
        console.log(`[MC Action] No saved home position for ${homeServerKey}`);
    }
}

/** Save bed position as home (memory and disk) */
export function saveHome(bedBlock: { position: { x: number; y: number; z: number } }): void {
    homePosition = { x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z };
    if (homeServerKey) {
        const data = loadHomeData();
        data[homeServerKey] = homePosition;
        saveHomeData(data);
    }
    console.log(`[MC Action] Home position saved: ${homePosition.x}, ${homePosition.y}, ${homePosition.z}`);
}

/** Clear saved home (bed no longer exists at saved position) */
export function clearHome(): void {
    homePosition = null;
    if (homeServerKey) {
        const data = loadHomeData();
        delete data[homeServerKey];
        saveHomeData(data);
    }
    console.log('[MC Action] Home position cleared (stale data)');
}
