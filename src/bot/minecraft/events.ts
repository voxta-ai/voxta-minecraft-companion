import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import type { McSettings } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/ipc-types';
import { isActionBusy, getCurrentActivity } from './actions';
import { isPickupSuppressed, setAutoDefending } from './actions/action-state.js';
import { FOOD_ITEMS } from './game-data';

// ---- Callback interface ----

export interface McEventCallbacks {
    /** Add a message to the chat log */
    onChat(type: ChatMessage['type'], sender: string, text: string): void;
    /** Send a note — AI sees it but does not reply */
    onNote(text: string): void;
    /** Send an event (critical — AI replies) */
    onEvent(text: string): void;
    /** Send an urgent event — interrupts current speech and forces an immediate short reply */
    onUrgentEvent(text: string): void;
    /** Send a player chat message — treated as a regular user message (triggers action inference) */
    onPlayerChat(text: string): void;
    /** Get the current settings */
    getSettings(): McSettings;
    /** Get the assistant's display name */
    getAssistantName(): string;
    /** Check if the AI is currently replying */
    isReplying(): boolean;
}

// Mineflayer entity.type is 'hostile' for most hostile mobs, but some
// (e.g. phantom) have type 'mob' with category 'Hostile mobs'.
// entity.kind maps to the minecraft-data category field.
function isHostileEntity(e: Entity): boolean {
    return e.type === 'hostile' || (e as unknown as Record<string, unknown>).kind === 'Hostile mobs';
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

    private lastDamageNoteTime = 0;
    private readonly DAMAGE_NOTE_COOLDOWN_MS = 30_000;

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
                if (damage <= 0) {
                    this.lastHealth = currentHealth;
                    return;
                }
                const source = this.getDamageSource();
                this.pendingDamage += damage;

                // After sending a note, suppress further notes for 30 seconds
                // to prevent spam from continuous damage (starvation, drowning, etc.)
                const onCooldown = Date.now() - this.lastDamageNoteTime < this.DAMAGE_NOTE_COOLDOWN_MS;

                if (onCooldown) {
                    // Still on cooldown — just accumulate, schedule a flush at cooldown end
                    if (!this.damageTimer) {
                        const remaining = this.DAMAGE_NOTE_COOLDOWN_MS - (Date.now() - this.lastDamageNoteTime);
                        const damageSource = source;
                        this.damageTimer = setTimeout(() => {
                            this.flushDamageNote(damageSource);
                        }, remaining);
                    }
                } else if (!this.damageTimer) {
                    // Not on cooldown — consolidate damage over 3 seconds then send
                    const damageSource = source;
                    this.damageTimer = setTimeout(() => {
                        this.flushDamageNote(damageSource);
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
            // Just log to chat — the respawn event handles the AI reply
            this.callbacks.onChat('event', 'Event', `${botName} died from ${killer}!`);
        }) as (...args: never[]) => void);

        // ---- Respawn (fires immediately after death) ----
        this.on('spawn', (() => {
            if (!this.died) return;
            this.died = false;
            const botName = this.callbacks.getAssistantName();
            const cause = this.deathCause ?? 'unknown causes';
            this.deathCause = null;
            this.callbacks.onChat('event', 'Event', `${botName} has respawned!`);
            this.callbacks.onUrgentEvent(
                `[URGENT] ${botName} just died to ${cause}, lost all items, and respawned. IMPORTANT: Reply in ONE sentence only, maximum 10 words.`,
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
            // Pick the CLOSEST hostile mob — not the first in the dictionary.
            // Using find() could target a distant spider while a skeleton shoots us.
            let hostileMob: Entity | undefined;
            let hostileDist = Infinity;
            for (const e of Object.values(this.bot.entities)) {
                if (e === this.bot.entity || !isHostileEntity(e)) continue;
                const d = e.position.distanceTo(this.bot.entity.position);
                if (d < 28 && Math.abs(e.position.y - this.bot.entity.position.y) < 16 && d < hostileDist) {
                    hostileMob = e;
                    hostileDist = d;
                }
            }
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
                // Skip if we're already auto-defending — getting hit back is expected
                if (this.isAutoDefending) return;
                const botName = this.callbacks.getAssistantName();
                // Only send the urgent event (triggers short AI reply).
                // No separate chat event — that caused double notifications.
                this.callbacks.onUrgentEvent(
                    `[URGENT] ${botName} is being attacked by ${this.lastAttacker}! IMPORTANT: Reply in ONE sentence only, maximum 10 words.`,
                );
            }

            // Auto self-defense — only if a mob actually hit us (not environmental damage)
            // Case 1: hostile mob nearby (skeletons, zombies, etc.)
            // Case 2: any entity that swung at us recently (provoked bears, wolves, etc.)
            // NEVER auto-defend against the player we're following — accidental hits happen
            if (settings.enableAutoDefense && !this.isAutoDefending) {
                let targetName: string | null = null;
                if (hostileMob) {
                    targetName = hostileMob.name ?? 'unknown';
                } else if (this.lastAttacker && Date.now() - this.lastAttackerTime < 2000) {
                    targetName = this.names.resolveToMc(this.lastAttacker);
                }
                // Never attack the player we're following
                const followingPlayer = this.getFollowingPlayer();
                if (targetName && followingPlayer && targetName.toLowerCase() === followingPlayer.toLowerCase()) {
                    targetName = null;
                }
                if (targetName) {
                    this.isAutoDefending = true;
                    setAutoDefending(true);
                    const botName = this.callbacks.getAssistantName();
                    this.callbacks.onChat('action', 'Action', `${botName} auto-defending against ${targetName}!`);
                    void this.onAutoDefenseAction(this.bot, targetName).finally(() => {
                        this.isAutoDefending = false;
                        setAutoDefending(false);
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
                    isHostileEntity(e) &&
                    e.position.distanceTo(entity.position) < 16 &&
                    Math.abs(e.position.y - entity.position.y) < 16, // High for flying mobs (phantoms)
            );
            if (!attacker) return;

            const mobName = attacker.name ?? 'unknown';
            const playerName = entity.username ?? entity.displayName ?? 'player';
            this.isAutoDefending = true;
            setAutoDefending(true);
            const botName = this.callbacks.getAssistantName();
            const voxtaName = this.names.resolveToVoxta(playerName);
            // Only send the urgent event — no separate chat event to avoid spam
            this.callbacks.onUrgentEvent(
                `[URGENT] ${voxtaName} is being attacked by a ${mobName}! ${botName} is rushing to protect them. IMPORTANT: Reply in ONE sentence only, maximum 10 words.`,
            );
            void this.onAutoDefenseAction(this.bot, mobName).finally(() => {
                this.isAutoDefending = false;
                setAutoDefending(false);
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

                // Skip during crafting/equipping — update snapshot so items
                // don't double-report when suppression ends
                if (isPickupSuppressed()) {
                    lastInventorySnapshot = takeSnapshot();
                    return;
                }

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

                // Detect tool/weapon/armor breaks — item disappeared from inventory.
                // Guards: skip during death (items lost) and suppression (give/toss/craft).
                // The only unsuppressed case where a tool count drops to 0 is a real durability break.
                if (!this.died && !isPickupSuppressed()) {
                    const BREAKABLE_SUFFIXES = [
                        '_pickaxe', '_sword', '_axe', '_shovel', '_hoe',
                        '_helmet', '_chestplate', '_leggings', '_boots',
                        'shield', 'bow', 'crossbow', 'trident', 'fishing_rod',
                        'shears', 'flint_and_steel',
                    ];
                    for (const [name, { count: prevCount, displayName }] of lastInventorySnapshot) {
                        const currentCount = current.get(name)?.count ?? 0;
                        if (prevCount > 0 && currentCount === 0) {
                            const isTool = BREAKABLE_SUFFIXES.some((s) => name.endsWith(s) || name === s);
                            if (isTool) {
                                this.callbacks.onChat('note', 'Note', `${botName}'s ${displayName} just broke!`);
                                this.callbacks.onNote(`${botName}'s ${displayName} just broke!`);
                            }
                        }
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

            // Skip Minecraft command output (cheat codes like /give, /tp, /summon, etc.)
            // These come through the 'chat' event attributed to the player who ran the
            // command, but aren't actual player messages. Command feedback always follows
            // predictable patterns: "Verb + rest" (e.g. "Summoned new Skeleton",
            // "Teleported Emptyngton to 0, 64, 0", "Set the time to 1000").
            const isCommandOutput = /^(Gave|Teleported|Summoned|Killed|Applied|Enchanted|Cleared|Set |Added |Removed |Changed |Filled |Cloned |Played |Stopped |Enabled |Disabled |Made |Nothing |Data |Gamerule |\[Server])/i.test(message);
            if (isCommandOutput) {
                const cleanMsg = message.replace(/^\[|]$/g, '');
                this.callbacks.onChat('system', 'System', cleanMsg);
                return; // Don't forward to AI
            }

            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', voxtaName, resolvedMsg);
            this.callbacks.onPlayerChat(resolvedMsg);
        }) as (...args: never[]) => void);

        this.on('whisper', ((username: string, message: string) => {
            if (username === this.bot.username) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableNoteChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', `${voxtaName} (whisper)`, resolvedMsg);
            this.callbacks.onPlayerChat(resolvedMsg);
        }) as (...args: never[]) => void);
    }

    /** Send accumulated damage as a single note and start cooldown */
    private flushDamageNote(source: string): void {
        const totalDmg = Math.round(this.pendingDamage * 10) / 10;
        const hp = Math.round(this.bot.health * 10) / 10;
        const name = this.callbacks.getAssistantName();
        const msg = `${name} took ${totalDmg} total damage from ${source}! Health is now: ${hp}/20`;
        this.callbacks.onChat('note', 'Note', msg);
        this.callbacks.onNote(msg);
        this.pendingDamage = 0;
        this.damageTimer = null;
        this.lastDamageNoteTime = Date.now();
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
