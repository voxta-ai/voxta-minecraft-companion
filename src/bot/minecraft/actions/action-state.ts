import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot } from 'mineflayer';

// ---- Per-bot state ----

export type BotMode = 'passive' | 'aggro' | 'hunt' | 'guard';

interface BotStateData {
    actionAbort: AbortController;
    actionBusy: boolean;
    suppressPickups: boolean;
    currentActivity: string | null;
    currentCombatTarget: string | null;
    autoDefending: boolean;
    autoEating: boolean;
    botMode: BotMode;
    guardCenter: { x: number; y: number; z: number } | null;
    onFishCaught: ((itemName: string, count: number) => void) | null;
    homePosition: { x: number; y: number; z: number } | null;
    homeServerKey: string | null;
}

const botStateMap = new WeakMap<Bot, BotStateData>();

function getBotState(bot: Bot): BotStateData {
    let state = botStateMap.get(bot);
    if (!state) {
        state = {
            actionAbort: new AbortController(),
            actionBusy: false,
            suppressPickups: false,
            currentActivity: null,
            currentCombatTarget: null,
            autoDefending: false,
            autoEating: false,
            botMode: 'passive',
            guardCenter: null,
            onFishCaught: null,
            homePosition: null,
            homeServerKey: null,
        };
        botStateMap.set(bot, state);
    }
    return state;
}

// ---- Cancellation & busy tracking ----

export function getActionAbort(bot: Bot): AbortController {
    return getBotState(bot).actionAbort;
}
export function resetActionAbort(bot: Bot): AbortController {
    const state = getBotState(bot);
    state.actionAbort.abort();
    state.actionAbort = new AbortController();
    return state.actionAbort;
}

// Tracks whether a physical action is running (mining, following, etc.)
export function isActionBusy(bot: Bot): boolean {
    return getBotState(bot).actionBusy;
}
export function setActionBusy(bot: Bot, busy: boolean): void {
    getBotState(bot).actionBusy = busy;
}

// Suppress pickup notes during inventory management (equip/unequip in crafting)
export function isPickupSuppressed(bot: Bot): boolean {
    return getBotState(bot).suppressPickups;
}
export function setSuppressPickups(bot: Bot, value: boolean): void {
    getBotState(bot).suppressPickups = value;
}

// Human-readable description of what the bot is currently doing
export function getCurrentActivity(bot: Bot): string | null {
    return getBotState(bot).currentActivity;
}
export function setCurrentActivity(bot: Bot, activity: string | null): void {
    getBotState(bot).currentActivity = activity;
}

// Current combat target — used to prevent duplicate mc_attack from cancelling
// an ongoing fight (e.g., auto-defense + AI action both targeting the same mob)
export function getCurrentCombatTarget(bot: Bot): string | null {
    return getBotState(bot).currentCombatTarget;
}
export function setCurrentCombatTarget(bot: Bot, target: string | null): void {
    getBotState(bot).currentCombatTarget = target;
}

// Auto-defense flag — when true, the event system is handling combat.
// AI-generated combat actions should be silently skipped to avoid spam loops.
export function isAutoDefending(bot: Bot): boolean {
    return getBotState(bot).autoDefending;
}
export function setAutoDefending(bot: Bot, value: boolean): void {
    getBotState(bot).autoDefending = value;
}

// Auto-eating flag — when true, the auto-eat system is consuming food.
// AI-generated mc_eat actions should be skipped to avoid consume() race.
export function isAutoEating(bot: Bot): boolean {
    return getBotState(bot).autoEating;
}
export function setAutoEating(bot: Bot, value: boolean): void {
    getBotState(bot).autoEating = value;
}

// ---- Behavior mode ----

export function getBotMode(bot: Bot): BotMode {
    return getBotState(bot).botMode;
}
export function setBotMode(bot: Bot, mode: BotMode): void {
    getBotState(bot).botMode = mode;
    console.log(`[${bot.username}] Mode changed to: ${mode}`);
}

// Guard center — the position the bot should patrol around in guard mode
export function getGuardCenter(bot: Bot): { x: number; y: number; z: number } | null {
    return getBotState(bot).guardCenter;
}
export function setGuardCenter(bot: Bot, pos: { x: number; y: number; z: number } | null): void {
    getBotState(bot).guardCenter = pos;
}

// ---- Fishing callback ----

export function getOnFishCaught(bot: Bot): ((itemName: string, count: number) => void) | null {
    return getBotState(bot).onFishCaught;
}
export function setFishCaughtCallback(bot: Bot, cb: ((itemName: string, count: number) => void) | null): void {
    getBotState(bot).onFishCaught = cb;
}

// ---- Home position persistence ----

export function getHomePosition(bot: Bot): { x: number; y: number; z: number } | null {
    return getBotState(bot).homePosition;
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
export function initHomePosition(bot: Bot, host: string, port: number): void {
    const state = getBotState(bot);
    // Use bot username in key so each bot has its own home
    state.homeServerKey = `${host}:${port}:${bot.username}`;
    const data = loadHomeData();
    const saved = data[state.homeServerKey];
    if (saved) {
        // Verify the bed still exists (world may have changed)
        const { Vec3 } = require('vec3');
        const block = bot.blockAt(new Vec3(saved.x, saved.y, saved.z));
        if (!block || !block.name.includes('bed')) {
            console.log(`[${bot.username}] Saved home at ${saved.x}, ${saved.y}, ${saved.z} is not a bed (found: ${block?.name ?? 'unloaded'}). Clearing stale data.`);
            state.homePosition = null;
            delete data[state.homeServerKey];
            saveHomeData(data);
            return;
        }
        state.homePosition = saved;
        console.log(`[${bot.username}] Loaded home position for ${state.homeServerKey}: ${saved.x}, ${saved.y}, ${saved.z}`);
    } else {
        state.homePosition = null;
        console.log(`[${bot.username}] No saved home position for ${state.homeServerKey}`);
    }
}

/** Save bed position as home (memory and disk) */
export function saveHome(bot: Bot, bedBlock: { position: { x: number; y: number; z: number } }): void {
    const state = getBotState(bot);
    state.homePosition = { x: bedBlock.position.x, y: bedBlock.position.y, z: bedBlock.position.z };
    if (state.homeServerKey) {
        const data = loadHomeData();
        data[state.homeServerKey] = state.homePosition;
        saveHomeData(data);
    }
    console.log(`[${bot.username}] Home position saved: ${state.homePosition.x}, ${state.homePosition.y}, ${state.homePosition.z}`);
}

/** Clear saved home (bed no longer exists at saved position) */
export function clearHome(bot: Bot): void {
    const state = getBotState(bot);
    state.homePosition = null;
    if (state.homeServerKey) {
        const data = loadHomeData();
        delete data[state.homeServerKey];
        saveHomeData(data);
    }
    console.log(`[${bot.username}] Home position cleared (stale data)`);
}
