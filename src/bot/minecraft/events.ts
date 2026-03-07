import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import type { McSettings } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/ipc-types';
import { isActionBusy, getCurrentActivity } from './actions';
import { FOOD_ITEMS } from './game-data';

// ---- Callback interface ----

export interface McEventCallbacks {
    /** Add a message to the chat log */
    onChat(type: ChatMessage['type'], sender: string, text: string): void;
    /** Send a note — AI sees it but does not reply */
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
    private deathCause: string | null = null;
    private autoLookLoop: ReturnType<typeof setInterval> | null = null;
    private pickupCheckTimer: ReturnType<typeof setInterval> | null = null;

    // Bound listener references for cleanup
    private readonly boundListeners: Array<{ event: string; fn: (...args: never[]) => void }> = [];

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

    private on(event: string, fn: (...args: never[]) => void): void {
        this.bot.on(event as 'health', fn);
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

                // Log each tick to chat (visible but doesn't trigger AI reply)
                const botName = this.callbacks.getAssistantName();
                this.callbacks.onChat(
                    'note',
                    'Note',
                    `${botName} took ${damage} damage from ${source}! Health: ${currentHealth}/20`,
                );

                // Consolidate damage into one AI message after a short delay
                if (!this.damageTimer) {
                    const damageSource = source;
                    this.damageTimer = setTimeout(() => {
                        const totalDmg = Math.round(this.pendingDamage * 10) / 10;
                        const hp = Math.round(this.bot.health * 10) / 10;
                        const name = this.callbacks.getAssistantName();
                        const msg = `${name} took ${totalDmg} total damage from ${damageSource}! Health is now: ${hp}/20`;
                        // Damage is always a silent note — AI sees health in context
                        // and gets 'under attack' events separately from mob attacks
                        this.callbacks.onChat('note', 'Note', msg);
                        this.callbacks.onNote(msg);
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
            const killer = this.lastAttacker ?? this.getDamageSource();
            this.deathCause = killer;
            this.lastAttacker = null;
            this.lastHealth = 20;
            this.pendingDamage = 0;
            if (this.damageTimer) {
                clearTimeout(this.damageTimer);
                this.damageTimer = null;
            }
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('note', 'Note', `${botName} died from ${killer}!`);
            this.callbacks.onNote(`${botName} died from ${killer}!`);
        }) as (...args: never[]) => void);

        // ---- Respawn ----
        this.on('spawn', (() => {
            if (!this.died) return;
            this.died = false;
            const botName = this.callbacks.getAssistantName();
            const cause = this.deathCause ?? 'unknown causes';
            this.deathCause = null;
            this.callbacks.onChat('event', 'Event', `${botName} has respawned!`);
            this.callbacks.onEvent(
                `${botName} was killed by ${cause} and lost all items, but has respawned with full health (20/20) and full food (20/20). ${botName} should acknowledge that they died and came back.`,
            );
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

            // Ignore environmental damage (starvation, drowning, fall, etc.)
            // bot.food === 0 means starvation; no attacker to defend against.
            if (this.bot.food === 0) return;

            // Priority 1: Check for nearby hostile mobs (handles explosions, ranged, AOE)
            const hostileMob = Object.values(this.bot.entities).find(
                (e) =>
                    e !== this.bot.entity &&
                    e.type === 'hostile' &&
                    e.position.distanceTo(this.bot.entity.position) < 28 &&
                    Math.abs(e.position.y - this.bot.entity.position.y) < 3,
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
                this.callbacks.onChat('note', 'Note', `${botName} is under attack by ${this.lastAttacker}!`);
                this.callbacks.onNote(`${botName} is being attacked by ${this.lastAttacker}!`);
            }

            // Auto self-defense — only if a mob actually hit us (not environmental damage)
            // Case 1: hostile mob nearby (skeletons, zombies, etc.)
            // Case 2: any entity that swung at us recently (provoked bears, wolves, etc.)
            if (settings.enableAutoDefense && !this.isAutoDefending) {
                let targetName: string | null = null;
                if (hostileMob) {
                    targetName = hostileMob.name ?? 'unknown';
                } else if (this.lastAttacker && Date.now() - this.lastAttackerTime < 2000) {
                    targetName = this.names.resolveToMc(this.lastAttacker);
                }
                if (targetName) {
                    this.isAutoDefending = true;
                    const botName = this.callbacks.getAssistantName();
                    this.callbacks.onChat('action', 'Action', `${botName} auto-defending against ${targetName}!`);
                    void this.onAutoDefenseAction(this.bot, targetName).finally(() => {
                        this.isAutoDefending = false;
                    });
                }
            }
        }) as (...args: never[]) => void);

        // ---- Player protection: auto-defend nearby players ----
        this.on('entityHurt', ((entity: Entity) => {
            // Only react to players (not the bot itself — handled above)
            if (entity.id === this.bot.entity.id) return;
            if (entity.type !== 'player') return;

            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoDefense || this.isAutoDefending) return;

            // Only protect if the bot is within 16 blocks of the player
            const distToPlayer = entity.position.distanceTo(this.bot.entity.position);
            if (distToPlayer > 16) return;

            // Find the hostile mob near the player that is likely attacking them
            const attacker = Object.values(this.bot.entities).find(
                (e) =>
                    e !== this.bot.entity &&
                    e.id !== entity.id &&
                    e.type === 'hostile' &&
                    e.position.distanceTo(entity.position) < 8 &&
                    Math.abs(e.position.y - entity.position.y) < 3,
            );
            if (!attacker) return;

            const mobName = attacker.name ?? 'unknown';
            const playerName = entity.username ?? entity.displayName ?? 'player';
            this.isAutoDefending = true;
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('note', 'Note', `${botName} protecting ${playerName} from ${mobName}!`);
            this.callbacks.onNote(`${botName} is rushing to protect ${playerName} from a ${mobName}!`);
            void this.onAutoDefenseAction(this.bot, mobName).finally(() => {
                this.isAutoDefending = false;
            });
        }) as (...args: never[]) => void);

        // ---- Wake up ----
        this.on('wake', (() => {
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('event', 'Event', `${botName} woke up!`);
            this.callbacks.onEvent(`${botName} woke up. It is now morning.`);
        }) as (...args: never[]) => void);

        // ---- Auto-eat: eat when hunger drops below a threshold ----
        let isAutoEating = false;

        const tryAutoEat = (): void => {
            if (isAutoEating) return;
            if (this.bot.food >= 14) return; // only eat when hungry (20 = full)

            // Find the best food in inventory
            const items = this.bot.inventory.items();
            const foodItems = items
                .filter((i) => i.name in FOOD_ITEMS)
                .sort((a, b) => (FOOD_ITEMS[b.name] ?? 0) - (FOOD_ITEMS[a.name] ?? 0));
            const foodItem = foodItems[0];
            if (!foodItem) return; // no food available

            isAutoEating = true;
            const prevHeldItem = this.bot.heldItem;

            console.log(`[MC] Auto-eating ${foodItem.displayName ?? foodItem.name} (hunger: ${this.bot.food}/20)`);

            void (async () => {
                try {
                    await this.bot.equip(foodItem.type, 'hand');
                    await this.bot.consume();
                    console.log(
                        `[MC] Auto-ate ${foodItem.displayName ?? foodItem.name}, hunger now: ${this.bot.food}/20`,
                    );
                    // Re-equip previous item
                    if (prevHeldItem && prevHeldItem.type !== foodItem.type) {
                        try {
                            await this.bot.equip(prevHeldItem.type, 'hand');
                        } catch {
                            /* best effort */
                        }
                    }
                } catch (err) {
                    console.warn(`[MC] Auto-eat failed:`, err);
                } finally {
                    isAutoEating = false;
                    // Still hungry? Eat again after a short delay
                    if (this.bot.food < 14) {
                        setTimeout(() => tryAutoEat(), 2000);
                    }
                }
            })();
        };

        // Trigger auto-eating when health/food changes
        this.on('health', (() => tryAutoEat()) as (...args: never[]) => void);

        // Also check on spawn (health event doesn't fire for initial values)
        setTimeout(() => tryAutoEat(), 5000);

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
            // During fishing, the fishing callback handles catch notifications
            if (getCurrentActivity() === 'fishing') return;
            this.callbacks.onChat('note', 'Note', `${botName} picked up ${parts.join(', ')}`);
            this.callbacks.onNote(`${botName} picked up ${parts.join(', ')}`);
        };

        // Track pickups by comparing total inventory snapshots.
        // Per-slot tracking fires false positives on equip/unequip (item moves between hand and inventory).
        let lastInventorySnapshot = new Map<string, { count: number; displayName: string }>();
        const takeSnapshot = (): Map<string, { count: number; displayName: string }> => {
            const snap = new Map<string, { count: number; displayName: string }>();
            for (const item of this.bot.inventory.items()) {
                const prev = snap.get(item.name);
                snap.set(item.name, {
                    count: (prev?.count ?? 0) + item.count,
                    displayName: item.displayName ?? item.name,
                });
            }
            return snap;
        };
        lastInventorySnapshot = takeSnapshot();

        let pickupCheckTimer: ReturnType<typeof setInterval> | null = null;
        let inventoryFullNotified = false;
        const startPickupCheck = (): void => {
            if (pickupCheckTimer) return;
            pickupCheckTimer = setInterval(() => {
                const settings = this.callbacks.getSettings();
                if (!settings.enableNoteItemPickup) return;

                const current = takeSnapshot();
                const botName = this.callbacks.getAssistantName();
                const gains: string[] = [];

                for (const [name, { count, displayName }] of current) {
                    const prev = lastInventorySnapshot.get(name)?.count ?? 0;
                    const gained = count - prev;
                    if (gained > 0) {
                        gains.push(`${gained} ${displayName}`);
                        // Accumulate for batched note
                        pendingPickups.set(displayName, (pendingPickups.get(displayName) ?? 0) + gained);
                    }
                }

                if (gains.length > 0) {
                    if (!pickupFlushTimer) {
                        pickupFlushTimer = setTimeout(flushPickups, 3000);
                    }
                }

                lastInventorySnapshot = current;

                // ---- Inventory full detection ----
                // Minecraft inventory has 36 slots (9 hotbar + 27 main)
                const usedSlots = this.bot.inventory.items().length;
                const maxSlots = 36;
                if (usedSlots >= maxSlots && !inventoryFullNotified) {
                    inventoryFullNotified = true;
                    this.callbacks.onChat(
                        'note',
                        'Note',
                        `${botName}'s inventory is full (${usedSlots}/${maxSlots} slots). Should drop or store unwanted items.`,
                    );
                    this.callbacks.onNote(
                        `${botName}'s inventory is full (${usedSlots}/${maxSlots} slots). Should drop or store unwanted items.`,
                    );
                } else if (usedSlots < maxSlots) {
                    // Reset so we can notify again the next time it fills up
                    inventoryFullNotified = false;
                }
            }, 500);
        };
        startPickupCheck();
        // Store for cleanup
        this.pickupCheckTimer = pickupCheckTimer;

        // ---- Chat bridging ----
        this.on('chat', ((username: string, message: string) => {
            if (!username || username === this.bot.username) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableNoteChat) return;

            // Skip Minecraft command output (cheat codes like /give, /tp, /gamemode, etc.)
            // These come through chat but aren't actual player messages
            const commandPatterns = [
                /^Gave \d+/i, // /give command output
                /^Teleported /i, // /tp command output
                /^Set own game mode/i, // /gamemode command output
                /^Set the time to/i, // /time command output
                /^Set the weather to/i, // /weather command output
                /^\[Server]/i, // Server broadcast messages
            ];
            if (commandPatterns.some((p) => p.test(message))) {
                this.callbacks.onChat('system', 'System', message);
                return; // Don't forward to AI
            }

            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', voxtaName, resolvedMsg);
            this.callbacks.onEvent(`[${voxtaName} says in Minecraft chat]: ${resolvedMsg}`);
        }) as (...args: never[]) => void);

        this.on('whisper', ((username: string, message: string) => {
            if (username === this.bot.username) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableNoteChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', `${voxtaName} (whisper)`, resolvedMsg);
            this.callbacks.onEvent(`[${voxtaName} whispers in Minecraft]: ${resolvedMsg}`);
        }) as (...args: never[]) => void);
    }

    /** Guess damage source from bot state and recent attacker */
    private getDamageSource(): string {
        // Check environmental causes first — these are unambiguous
        if (this.bot.food === 0) return 'starvation (no food)';
        const meta = this.bot.entity as unknown as Record<string, unknown>;
        if (meta['isInWater'] && (this.bot.oxygenLevel ?? 20) <= 0) return 'drowning';
        if (meta['isInWater'] && (this.bot.oxygenLevel ?? 400) < 100) return 'drowning (underwater)';
        if (meta['isInLava']) return 'lava';
        if (meta['isInFire'] || meta['onFire']) return 'fire';
        if (this.bot.entity.position.y < -60) return 'falling into the void';

        // Then check for a recent attacker (mob or player hit)
        if (this.lastAttacker && Date.now() - this.lastAttackerTime < 2000) {
            const source = this.lastAttacker;
            this.lastAttacker = null;
            return source;
        }

        if (!this.bot.entity.onGround) return 'fall damage';
        // Check if inside a block (suffocation)
        try {
            const headBlock = this.bot.blockAt(this.bot.entity.position.offset(0, 1.6, 0));
            if (headBlock && headBlock.name !== 'air' && headBlock.name !== 'cave_air' && headBlock.name !== 'water') {
                return 'suffocation';
            }
        } catch {
            /* chunk not loaded */
        }
        return 'environmental damage';
    }

    private startAutoLook(): void {
        this.autoLookLoop = setInterval(() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoLook) return;
            if (isActionBusy()) return;
            if (this.getFollowingPlayer()) return; // Pathfinder handles looking during follow

            const nearestPlayer = Object.values(this.bot.entities).find(
                (e) =>
                    e.type === 'player' &&
                    e !== this.bot.entity &&
                    e.position.distanceTo(this.bot.entity.position) < 50,
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
        if (this.pickupCheckTimer) {
            clearInterval(this.pickupCheckTimer);
            this.pickupCheckTimer = null;
        }
        if (this.damageTimer) {
            clearTimeout(this.damageTimer);
            this.damageTimer = null;
        }
        for (const { event, fn } of this.boundListeners) {
            this.bot.removeListener(event as 'health', fn as (...args: never[]) => void);
        }
        this.boundListeners.length = 0;
    }
}
