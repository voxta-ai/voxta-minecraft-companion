import type { Bot } from 'mineflayer';
import type { Entity } from 'prismarine-entity';
import type { NameRegistry } from '../name-registry';
import type { McSettings } from '../../shared/ipc-types';
import type { ChatMessage } from '../../shared/ipc-types';
import { isActionBusy, getCurrentActivity } from './actions';
import { isPickupSuppressed, setAutoDefending, isAutoDefending, getBotMode, getCurrentCombatTarget } from './actions/action-state.js';
import { hasLineOfSight } from './perception';
import { FOOD_ITEMS, NEUTRAL_HOSTILE_MOBS, LOW_HEALTH_THRESHOLD } from './game-data';
import { getEntityKind, isInWater, isInLava } from './mineflayer-types';

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
export function isHostileEntity(e: Entity): boolean {
    return e.type === 'hostile' || getEntityKind(e) === 'Hostile mobs';
}

// ---- Timing constants ----
const DAMAGE_CONSOLIDATION_MS = 3000; // Accumulate damage hits before sending one note
const PICKUP_FLUSH_MS = 3000;         // Batch pickup notifications before sending
const AUTO_EAT_THRESHOLD = 14;        // Eat when food drops below this (20 = full)

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
    private lastKnownAttacker: string | null = null; // Persists across getDamageSource() calls
    private isAutoDefending = false;
    private died = false;
    private deathCause: string | null = null;
    private autoLookLoop: ReturnType<typeof setInterval> | null = null;
    private pickupCheckTimer: ReturnType<typeof setInterval> | null = null;
    private proximityScanTimer: ReturnType<typeof setInterval> | null = null;

    // Companion assist: track how many times the player hits each mob
    private readonly playerAssistHits = new Map<number, { count: number; lastHit: number }>();

    // Bound listener references for cleanup
    private readonly boundListeners: Array<{ event: string; fn: (...args: never[]) => void }> = [];

    constructor(
        private readonly bot: Bot,
        private readonly names: NameRegistry,
        private readonly callbacks: McEventCallbacks,
        private readonly getFollowingPlayer: () => string | null,
        private readonly onAutoDefenseAction: (botInstance: Bot, mobName: string) => Promise<void>,
        private readonly allBotUsernames: Set<string> = new Set(),
        private readonly skipChatBridging = false,
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

    /** Clear stale attacker when a fight ends — prevents blaming dead mobs for later damage */
    clearLastAttacker(): void {
        this.lastAttacker = null;
        this.lastKnownAttacker = null;
    }

    /** Start an auto-defense fight and clean up state when it ends */
    private startAutoDefense(mobName: string): void {
        this.isAutoDefending = true;
        setAutoDefending(this.bot, true);
        void this.onAutoDefenseAction(this.bot, mobName).finally(() => {
            this.isAutoDefending = false;
            setAutoDefending(this.bot, false);
            this.clearLastAttacker();
        });
    }

    private registerListeners(): void {
        const eventCooldowns = new Map<string, number>();
        const EVENT_COOLDOWN_MS = 8_000;

        const isOnCooldown = (key: string): boolean => {
            const last = eventCooldowns.get(key);
            if (last && Date.now() - last < EVENT_COOLDOWN_MS) return true;
            eventCooldowns.set(key, Date.now());
            return false;
        };

        this.registerDamageHandlers();
        this.registerCombatHandlers(isOnCooldown);
        this.registerAutoEat();
        this.registerInventoryTracking();
        this.registerChatBridging();
    }

    // ---- Damage, death, and respawn ----

    private registerDamageHandlers(): void {
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
                    }, DAMAGE_CONSOLIDATION_MS);
                }
            }
            this.lastHealth = currentHealth;
        }) as (...args: never[]) => void);

        // ---- Death ----
        this.on('death', (() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableEventDeath) return;
            this.died = true;
            // Check for harmful status effects that could be the real killer
            const harmfulEffects = this.getHarmfulEffects();
            // Use lastKnownAttacker (persists) → lastAttacker (recent) → getDamageSource() (guess)
            let killer = this.lastKnownAttacker ?? this.lastAttacker ?? this.getDamageSource();
            // If poison/wither is active, it's likely the real cause (or a contributing factor)
            if (harmfulEffects.length > 0) {
                killer = harmfulEffects.join(' + ') + (killer !== 'environmental damage' ? ` (while fighting ${killer})` : '');
            }
            this.deathCause = killer;
            this.lastAttacker = null;
            this.lastKnownAttacker = null;
            this.lastHealth = 20;
            this.pendingDamage = 0;
            if (this.damageTimer) {
                clearTimeout(this.damageTimer);
                this.damageTimer = null;
            }
            // Don't log death separately — respawn handler sends one combined message
        }) as (...args: never[]) => void);

        // ---- Respawn (fires immediately after death) ----
        this.on('spawn', (() => {
            if (!this.died) return;
            this.died = false;
            const botName = this.callbacks.getAssistantName();
            const cause = this.deathCause ?? 'unknown causes';
            this.deathCause = null;
            // Single combined message instead of separate death + respawn + urgent events
            this.callbacks.onUrgentEvent(
                `[URGENT] ${botName} just DIED (killed by ${cause}), lost all items, and respawned at full health. The fight is over — ${botName} is no longer in danger.`,
            );
        }) as (...args: never[]) => void);

        this.on('wake', (() => {
            const botName = this.callbacks.getAssistantName();
            this.callbacks.onChat('event', 'Event', `${botName} woke up!`);
            this.callbacks.onEvent(`${botName} woke up. It is now morning.`);
        }) as (...args: never[]) => void);
    }

    // ---- Combat: swing tracking, auto-defense, player protection, companion assist, proximity ----

    private registerCombatHandlers(isOnCooldown: (key: string) => boolean): void {
        // Melee hit tracking
        this.on('entitySwingArm', ((entity: Entity) => {
            if (entity.id === this.bot.entity.id) return;
            if (entity.position.distanceTo(this.bot.entity.position) < 6) {
                const mcName = entity.username ?? entity.displayName ?? entity.name ?? 'something';
                this.lastSwingAttacker = this.names.resolveToVoxta(mcName);
                this.lastSwingTime = Date.now();
            }
        }) as (...args: never[]) => void);

        // Under attack detection + auto self-defense
        this.on('entityHurt', ((entity: { id: number }) => {
            if (entity.id !== this.bot.entity.id) return;
            if (this.bot.food === 0) return; // starvation — no attacker

            // Find closest hostile mob
            let hostileMob: Entity | undefined;
            let hostileDist = Infinity;
            for (const e of Object.values(this.bot.entities)) {
                if (e === this.bot.entity || !isHostileEntity(e)) continue;
                const d = e.position.distanceTo(this.bot.entity.position);
                if (d < 28 && Math.abs(e.position.y - this.bot.entity.position.y) < 16 && d < hostileDist) {
                    // Skip mobs behind solid walls — they aren't the real attacker
                    if (!hasLineOfSight(this.bot, e)) continue;
                    hostileMob = e;
                    hostileDist = d;
                }
            }
            if (hostileMob) {
                const mcName = hostileMob.username ?? hostileMob.displayName ?? hostileMob.name ?? 'something';
                this.lastAttacker = this.names.resolveToVoxta(mcName);
                this.lastAttackerTime = Date.now();
                this.lastKnownAttacker = this.lastAttacker; // Persist for death handler
                this.lastSwingAttacker = null; // Clear swing — mob takes priority
            } else if (this.lastSwingAttacker && Date.now() - this.lastSwingTime < 1500) {
                // Priority 2: Player PvP — only if no hostile mob is nearby
                // Skip if the swing came from the player we're following — they're
                // fighting alongside us and their arm swings aren't aimed at us
                const followingPlayer = this.getFollowingPlayer();
                const swingMc = this.names.resolveToMc(this.lastSwingAttacker);
                if (!followingPlayer || swingMc.toLowerCase() !== followingPlayer.toLowerCase()) {
                    this.lastAttacker = this.lastSwingAttacker;
                    this.lastAttackerTime = Date.now();
                }
                this.lastSwingAttacker = null;
            }

            const settings = this.callbacks.getSettings();
            if (settings.enableEventUnderAttack && !isOnCooldown('underAttack') && this.lastAttacker) {
                // Skip if we're already auto-defending — getting hit back is expected
                if (this.isAutoDefending) return;
                const botName = this.callbacks.getAssistantName();
                const msg = `[URGENT] ${botName} is being attacked by ${this.lastAttacker}!`;
                // Route through combat voice chance slider
                const roll = Math.random() * 100;
                if (roll < settings.voiceChanceCombat) {
                    this.callbacks.onUrgentEvent(msg);
                } else {
                    this.callbacks.onNote(msg);
                }
            }

            // Auto self-defense — only if a mob actually hit us (not environmental damage)
            // Case 1: hostile mob nearby (skeletons, zombies, etc.)
            // Case 2: any entity that swung at us recently (provoked bears, wolves, etc.)
            // NEVER auto-defend against the player we're following — accidental hits happen
            // Skip if aggro/hunt/guard mode is handling combat (global flag) or we started defense
            // Also skip if any combat is already active (AI-directed mc_attack, mode scans, etc.)
            if (settings.enableAutoDefense && !this.isAutoDefending && !isAutoDefending(this.bot) && !getCurrentCombatTarget(this.bot) && getBotMode(this.bot) === 'passive') {
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
                    const botName = this.callbacks.getAssistantName();
                    this.callbacks.onChat('action', 'Action', `${botName} auto-defending against ${targetName}!`);
                    this.startAutoDefense(targetName);
                }
            }
        }) as (...args: never[]) => void);

        // Player protection: auto-defend nearby players
        let lastProtectTime = 0;
        this.on('entityHurt', ((entity: Entity) => {
            // Only react to players (not the bot itself — handled above)
            if (entity.id === this.bot.entity.id) return;
            if (entity.type !== 'player') return;

            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoDefense || this.isAutoDefending) return;

            // Cooldown — don't spam protection events
            const now = Date.now();
            if (now - lastProtectTime < 15_000) return;

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

            lastProtectTime = now;
            const mobName = attacker.name ?? 'unknown';
            const playerName = entity.username ?? entity.displayName ?? 'player';
            const botName = this.callbacks.getAssistantName();
            const voxtaName = this.names.resolveToVoxta(playerName);
            const msg = `[URGENT] ${voxtaName} is being attacked by a ${mobName}! ${botName} is rushing to protect them.`;
            // Route through combat voice chance slider
            const roll = Math.random() * 100;
            if (roll < settings.voiceChanceCombat) {
                this.callbacks.onUrgentEvent(msg);
            } else {
                this.callbacks.onNote(msg);
            }
            this.startAutoDefense(mobName);
        }) as (...args: never[]) => void);

        // Companion assist: help player fight when they attack something
        this.on('entityHurt', ((entity: Entity) => {
            // Only care about non-player, non-bot entities (mobs)
            if (entity.id === this.bot.entity.id) return;
            if (entity.type === 'player') return;

            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoDefense) return;
            if (this.isAutoDefending || isAutoDefending(this.bot) || getCurrentCombatTarget(this.bot)) return;

            // Find the player we're following
            const followingPlayer = this.getFollowingPlayer();
            if (!followingPlayer) return;
            const mcName = this.names.resolveToMc(followingPlayer);
            const playerEntity = Object.values(this.bot.entities).find(
                (e) => e.type === 'player' && e.username?.toLowerCase() === mcName.toLowerCase(),
            );
            if (!playerEntity) return;

            // Is the player within melee range of the hurt mob? (4 blocks = sword reach + margin)
            const playerToMob = playerEntity.position.distanceTo(entity.position);
            if (playerToMob > 4) return;

            // Track hits per mob entity ID
            const now = Date.now();
            const entry = this.playerAssistHits.get(entity.id);
            if (entry && now - entry.lastHit < 5000) {
                entry.count++;
                entry.lastHit = now;
            } else {
                this.playerAssistHits.set(entity.id, { count: 1, lastHit: now });
            }

            const current = this.playerAssistHits.get(entity.id);
            if (!current || current.count < 2) return;

            // Player hit this mob 2+ times — join the fight!
            this.playerAssistHits.delete(entity.id);
            const mobName = entity.name ?? entity.displayName ?? 'unknown';
            const botName = this.callbacks.getAssistantName();
            console.log(`[Bot] Companion assist: ${followingPlayer} is fighting ${mobName}, joining!`);
            this.callbacks.onChat('action', 'Action', `${botName} is joining the fight against ${mobName}!`);
            this.startAutoDefense(mobName);
        }) as (...args: never[]) => void);

        // Proximity self-defense: attack hostile mobs within melee range
        this.proximityScanTimer = setInterval(() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoDefense) return;
            if (this.isAutoDefending || isAutoDefending(this.bot) || getCurrentCombatTarget(this.bot)) return;
            if (getBotMode(this.bot) !== 'passive') return;
            if (this.bot.health <= LOW_HEALTH_THRESHOLD) return;

            const pos = this.bot.entity.position;
            if (!Number.isFinite(pos.x)) return;

            // Find any hostile mob within 2.5 blocks (excluding neutral-hostile)
            const threat = Object.values(this.bot.entities).find(
                (e) =>
                    e !== this.bot.entity &&
                    isHostileEntity(e) &&
                    !NEUTRAL_HOSTILE_MOBS.has(e.name ?? '') &&
                    e.position.distanceTo(pos) < 2.5 &&
                    Math.abs(e.position.y - pos.y) < 2,
            );
            if (!threat) return;

            const mobName = threat.name ?? 'unknown';
            console.log(`[Bot] Proximity defense: ${mobName} is right next to us, attacking!`);
            this.startAutoDefense(mobName);
        }, 1000);
    }

    // ---- Auto-eat when hunger drops ----

    private registerAutoEat(): void {
        let isAutoEating = false;

        const tryAutoEat = (): void => {
            if (isAutoEating) return;
            if (this.bot.food >= AUTO_EAT_THRESHOLD) return;

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
                    const botName = this.callbacks.getAssistantName();
                    console.log(
                        `[MC] Auto-ate ${foodItem.displayName ?? foodItem.name}, hunger now: ${this.bot.food}/20`,
                    );
                    this.callbacks.onNote(
                        `${botName} automatically ate ${foodItem.displayName ?? foodItem.name}. Hunger is now ${this.bot.food}/20.`,
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
                    if (this.bot.food < AUTO_EAT_THRESHOLD) {
                        setTimeout(() => tryAutoEat(), 2000);
                    }
                }
            })();
        };

        // Trigger auto-eating when health/food changes
        this.on('health', (() => tryAutoEat()) as (...args: never[]) => void);

        // Also check on spawn (health event doesn't fire for initial values)
        setTimeout(() => tryAutoEat(), 5000);
    }

    // ---- Inventory tracking: pickup batching, tool breaks, inventory full ----

    private registerInventoryTracking(): void {
        const pendingPickups = new Map<string, number>();
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
            if (getCurrentActivity(this.bot) === 'fishing') return;
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
                if (isPickupSuppressed(this.bot)) {
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
                        pickupFlushTimer = setTimeout(flushPickups, PICKUP_FLUSH_MS);
                    }
                }

                // Detect tool/weapon/armor breaks
                if (!this.died && !isPickupSuppressed(this.bot)) {
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
        this.pickupCheckTimer = pickupCheckTimer;
    }

    // ---- Chat bridging: forward MC chat to Voxta ----

    private registerChatBridging(): void {
        if (this.skipChatBridging) return;

        // Log ALL server messages
        this.on('message', ((jsonMsg: { toString: () => string }) => {
            const message = jsonMsg.toString();
            if (!message) return;
            for (const name of this.allBotUsernames) {
                if (message.startsWith(`<${name}>`)) return;
            }
            console.log(`[MC Server] ${message}`);
        }) as (...args: never[]) => void);

        this.on('chat', ((username: string, message: string) => {
            console.log(`[MC Chat] <${username ?? 'server'}> ${message}`);
            if (!username || this.allBotUsernames.has(username)) return;
            const settings = this.callbacks.getSettings();
            if (!settings.enableNoteChat) return;

            // Skip SkinsRestorer system messages
            const isSkinsRestorerMsg = /^(Uploading skin|Your skin has been changed|You can change your skin again in|Skin data updated|Failed to set skin)/i.test(message);
            if (isSkinsRestorerMsg) {
                this.callbacks.onChat('system', 'SkinsRestorer', message);
                return;
            }

            // Skip Minecraft command output
            const isCommandOutput = /^(Gave|Teleported|Summoned|Killed|Applied|Enchanted|Cleared|Set |Added |Removed |Changed |Filled |Cloned |Played |Stopped |Enabled |Disabled |Made |Nothing |Data |Gamerule |\[Server])/i.test(message);
            if (isCommandOutput) {
                const cleanMsg = message.replace(/^\[|]$/g, '');
                this.callbacks.onChat('system', 'System', cleanMsg);
                return;
            }

            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.callbacks.onChat('player', voxtaName, resolvedMsg);
            this.callbacks.onPlayerChat(resolvedMsg);
        }) as (...args: never[]) => void);

        this.on('whisper', ((username: string, message: string) => {
            if (this.allBotUsernames.has(username)) return;
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
        if (isInWater(this.bot.entity) && (this.bot.oxygenLevel ?? 20) <= 0) return 'drowning';
        if (isInWater(this.bot.entity) && (this.bot.oxygenLevel ?? 400) < 100) return 'drowning (underwater)';
        if (isInLava(this.bot.entity)) return 'lava';
        const fireMeta = this.bot.entity as unknown as Record<string, unknown>;
        if (fireMeta['isInFire'] || fireMeta['onFire']) return 'fire';
        if (this.bot.entity.position.y < -60) return 'falling into the void';

        // Then check for a recent attacker (mob or player hit)
        if (this.lastAttacker && Date.now() - this.lastAttackerTime < 5_000) {
            return this.lastAttacker;
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

    /** Check for harmful status effects (Poison, Wither) that deal damage over time */
    private getHarmfulEffects(): string[] {
        const raw = this.bot.entity.effects;
        if (!raw) return [];

        const effects: Array<{ id: number }> = Array.isArray(raw) ? raw : Object.values(raw);
        const HARMFUL_EFFECTS: Record<number, string> = {
            19: 'Poison',
            20: 'Wither',
            7: 'Instant Damage',
        };

        return effects
            .map((e) => HARMFUL_EFFECTS[e.id])
            .filter((name): name is string => !!name);
    }

    private startAutoLook(): void {
        this.autoLookLoop = setInterval(() => {
            const settings = this.callbacks.getSettings();
            if (!settings.enableAutoLook) return;
            if (isActionBusy(this.bot)) return;
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
        if (this.proximityScanTimer) {
            clearInterval(this.proximityScanTimer);
            this.proximityScanTimer = null;
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
