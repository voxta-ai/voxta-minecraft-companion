import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import type { McSettings } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/ipc-types';
import { executeAction, isActionBusy } from './actions';

// ---- Callback interface ----

export interface McEventCallbacks {
    /** Add a message to the chat log */
    onChat(type: ChatMessage['type'], sender: string, text: string): void;
    /** Send a note (telemetry — AI sees it but does not reply) */
    onNote(text: string): void;
    /** Send an event (critical — AI replies) */
    onEvent(text: string): void;
    /** Get the current settings */
    getSettings(): McSettings;
    /** Get the assistant's display name */
    getAssistantName(): string;
    /** Check if the AI is currently replying */
    isReplying(): boolean;
}

// ---- MC Event Bridge ----

/**
 * Registers all Minecraft event listeners on a bot and routes them
 * through typed callbacks. Owns damage-tracking state, auto-defense,
 * auto-look, and chat bridging. Call destroy() on disconnect to
 * clean up all listeners.
 */
export class McEventBridge {
    private lastHealth: number;
    private pendingDamage = 0;
    private damageTimer: ReturnType<typeof setTimeout> | null = null;
    private lastAttacker: string | null = null;
    private lastAttackerTime = 0;
    private lastSwingAttacker: string | null = null;
    private lastSwingTime = 0;
    private isAutoDefending = false;
    private died = false;
    private autoLookLoop: ReturnType<typeof setInterval> | null = null;

    // Bound listener references for cleanup
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private readonly boundListeners: Array<{ event: string; fn: Function }> = [];
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private readonly boundInventoryListeners: Array<{ event: string; fn: Function }> = [];

    constructor(
        private readonly bot: Bot,
        private readonly names: NameRegistry,
        private readonly callbacks: McEventCallbacks,
        private readonly getFollowingPlayer: () => string | null,
        private readonly onAutoDefenseAction: (botInstance: Bot, mobName: string) => Promise<void>,
    ) {
        this.lastHealth = bot.health;
        this.registerListeners();
        this.startAutoLook();
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private on(event: string, fn: Function): void {
        this.bot.on(event as 'health', fn as (...args: never[]) => void);
        this.boundListeners.push({ event, fn });
    }

    private registerListeners(): void {
        const eventCooldowns = new Map<string, number>();
        const EVENT_COOLDOWN_MS = 15_000;

        const isOnCooldown = (key: string): boolean => {
            const last = eventCooldowns.get(key);
            if (last && Date.now() - last < EVENT_COOLDOWN_MS) return true;
            eventCooldowns.set(key, Date.now());
            return false;
        };

        // ---- Health / Damage ----
        this.on('health', (() => {
            const settings = this.callbacks.getSettings();
            const currentHealth = Math.round(this.bot.health * 10) / 10;
            if (currentHealth < this.lastHealth && settings.enableEventDamage) {
                const damage = Math.round((this.lastHealth - currentHealth) * 10) / 10;
                const source = this.getDamageSource();
                this.pendingDamage += damage;
                const botName = this.callbacks.getAssistantName();
                this.callbacks.onChat('event', 'Event', `${botName} took ${damage} damage from ${source}! Health: ${currentHealth}/20`);

                // Consolidate damage into one message after a short delay
                if (!this.damageTimer) {
                    const damageSource = source;
                    this.damageTimer = setTimeout(() => {
                        const totalDmg = Math.round(this.pendingDamage * 10) / 10;
                        const hp = Math.round(this.bot.health * 10) / 10;
                        const name = this.callbacks.getAssistantName();
                        const msg = `${name} took ${totalDmg} total damage from ${damageSource}! Health is now: ${hp}/20`;
                        if (damageSource === 'starvation (no food)') {
                            this.callbacks.onNote(msg);
                        } else {
                            this.callbacks.onEvent(msg);
                        }
                        this.pendingDamage = 0;
                        this.damageTimer = null;
                    }, 3000);
                }
            }
            this.lastHealth = currentHealth;
        }) as (...args: never[]) => void);

        // ---- Death ----
        this.on('death', (() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableEventDeath) return;
            this.died = true;
            const killer = this.lastAttacker ?? 'unknown causes';
            this.lastAttacker = null;
            this.lastHealth = 20;
            this.pendingDamage = 0;
            if (this.damageTimer) { clearTimeout(this.damageTimer); this.damageTimer = null; }
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('event', 'Event', `${botName} was killed by ${killer}!`);
            this.callbacks.onNote(`${botName} was killed by ${killer}!`);
        }) as (...args: never[]) => void);

        // ---- Respawn ----
        this.on('spawn', (() => {
            if (!this.died) return;
            this.died = false;
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('event', 'Event', `${botName} has respawned!`);
            this.callbacks.onEvent(`${botName} has respawned and is back in the world.`);
        }) as (...args: never[]) => void);

        // ---- Entity swing arm (melee hit tracking) ----
        this.on('entitySwingArm', ((entity: Entity) => {
            if (entity.id === this.bot.entity.id) return;
            if (entity.position.distanceTo(this.bot.entity.position) < 6) {
                const mcName = entity.username ?? entity.displayName ?? entity.name ?? 'something';
                this.lastSwingAttacker = this.names.resolveToVoxta(mcName);
                this.lastSwingTime = Date.now();
            }
        }) as (...args: never[]) => void);

        // ---- Entity hurt (under attack detection + auto-defense) ----
        this.on('entityHurt', ((entity: { id: number }) => {
            if (entity.id !== this.bot.entity.id) return;

            // Priority 1: Check for nearby hostile mobs (handles explosions, ranged, AOE)
            const hostileMob = Object.values(this.bot.entities).find(
                (e) => e !== this.bot.entity
                    && (e.type === 'mob' || e.type === 'hostile')
                    && e.position.distanceTo(this.bot.entity.position) < 16,
            );
            if (hostileMob) {
                const mcName = hostileMob.username ?? hostileMob.displayName ?? hostileMob.name ?? 'something';
                this.lastAttacker = this.names.resolveToVoxta(mcName);
                this.lastAttackerTime = Date.now();
                this.lastSwingAttacker = null; // Clear swing — mob takes priority
            } else if (this.lastSwingAttacker && Date.now() - this.lastSwingTime < 1500) {
                // Priority 2: Player PvP — only if no hostile mob is nearby
                this.lastAttacker = this.lastSwingAttacker;
                this.lastAttackerTime = Date.now();
                this.lastSwingAttacker = null;
            }

            const settings = this.callbacks.getSettings();
            if (settings.enableEventUnderAttack && !isOnCooldown('underAttack') && this.lastAttacker) {
                const botName = this.callbacks.getAssistantName();
                this.callbacks.onChat('event', 'Event', `${botName} is under attack by ${this.lastAttacker}!`);
                this.callbacks.onNote(`${botName} is being attacked by ${this.lastAttacker}!`);
            }

            // Auto self-defense
            if (settings.enableAutoDefense && !this.isAutoDefending) {
                const attacker = Object.values(this.bot.entities).find(
                    (e) => e !== this.bot.entity
                        && (e.type === 'mob' || e.type === 'hostile')
                        && e.position.distanceTo(this.bot.entity.position) < 8,
                );
                if (attacker) {
                    const mobName = attacker.name ?? 'unknown';
                    this.isAutoDefending = true;
                    const botName = this.callbacks.getAssistantName();
                    this.callbacks.onChat('action', 'Action', `${botName} auto-defending against ${mobName}!`);
                    void this.onAutoDefenseAction(this.bot, mobName)
                        .finally(() => { this.isAutoDefending = false; });
                }
            }
        }) as (...args: never[]) => void);

        // ---- Wake up ----
        this.on('wake', (() => {
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('event', 'Event', `${botName} woke up!`);
            this.callbacks.onEvent(`${botName} woke up. It is now morning.`);
        }) as (...args: never[]) => void);

        // ---- Inventory changes (item pickup) ----
        // Batch pickup notes: accumulate items over a short window, then send
        // a single aggregated note to Voxta (e.g. "Zom picked up 5 Dirt, 3 Leaf Litter").
        const pendingPickups = new Map<string, number>(); // displayName → total gained
        let pickupFlushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushPickups = (): void => {
            pickupFlushTimer = null;
            if (pendingPickups.size === 0) return;
            const botName = this.callbacks.getAssistantName();
            const parts: string[] = [];
            for (const [name, count] of pendingPickups) {
                parts.push(`${count} ${name}`);
            }
            pendingPickups.clear();
            this.callbacks.onNote(`${botName} picked up ${parts.join(', ')}`);
        };

        const updateSlotHandler = ((_slot: number, oldItem: { name: string; count: number } | null, newItem: { name: string; displayName: string; count: number } | null) => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableTelemetryItemPickup) return;
            if (!newItem) return;
            const gained = oldItem && oldItem.name === newItem.name
                ? newItem.count - oldItem.count
                : newItem.count;
            if (gained <= 0) return;
            const name = newItem.displayName ?? newItem.name;
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('system', 'Telemetry', `${botName} picked up ${gained} ${name}`);

            // Accumulate for batched note
            pendingPickups.set(name, (pendingPickups.get(name) ?? 0) + gained);
            if (!pickupFlushTimer) {
                pickupFlushTimer = setTimeout(flushPickups, 3000);
            }
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.bot.inventory.on('updateSlot', updateSlotHandler as any);
        this.boundInventoryListeners.push({ event: 'updateSlot', fn: updateSlotHandler });

        // ---- Chat bridging ----
        this.on('chat', ((username: string, message: string) => {
            if (!username || username === this.bot.username) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableTelemetryChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', voxtaName, resolvedMsg);
            this.callbacks.onEvent(`[${voxtaName} says in Minecraft chat]: ${resolvedMsg}`);
        }) as (...args: never[]) => void);

        this.on('whisper', ((username: string, message: string) => {
            if (username === this.bot.username) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableTelemetryChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', `${voxtaName} (whisper)`, resolvedMsg);
            this.callbacks.onEvent(`[${voxtaName} whispers in Minecraft]: ${resolvedMsg}`);
        }) as (...args: never[]) => void);
    }

    /** Guess damage source from bot state and recent attacker */
    private getDamageSource(): string {
        if (this.lastAttacker && Date.now() - this.lastAttackerTime < 2000) {
            const source = this.lastAttacker;
            this.lastAttacker = null;
            return source;
        }
        if (this.bot.food === 0) return 'starvation (no food)';
        const meta = this.bot.entity as unknown as Record<string, unknown>;
        if (meta['isInLava']) return 'lava';
        if (meta['isInFire'] || meta['onFire']) return 'fire';
        return 'falling or environment';
    }

    private startAutoLook(): void {
        this.autoLookLoop = setInterval(() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoLook) return;
            if (isActionBusy()) return;

            const nearestPlayer = Object.values(this.bot.entities).find(
                (e) => e.type === 'player'
                    && e !== this.bot.entity
                    && e.position.distanceTo(this.bot.entity.position) < 50,
            );
            if (nearestPlayer) {
                void this.bot.lookAt(nearestPlayer.position.offset(0, 1.6, 0));
            }
        }, 1000);
    }

    /** Remove all event listeners and stop loops. Call on disconnect. */
    destroy(): void {
        if (this.autoLookLoop) {
            clearInterval(this.autoLookLoop);
            this.autoLookLoop = null;
        }
        if (this.damageTimer) {
            clearTimeout(this.damageTimer);
            this.damageTimer = null;
        }
        for (const { event, fn } of this.boundListeners) {
            this.bot.removeListener(event as 'health', fn as (...args: never[]) => void);
        }
        for (const { event, fn } of this.boundInventoryListeners) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            this.bot.inventory.removeListener(event as 'updateSlot', fn as any);
        }
        this.boundListeners.length = 0;
        this.boundInventoryListeners.length = 0;
    }
}
