import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import type { Entity } from 'prismarine-entity';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS, executeAction } from '../bot/minecraft/actions';
import { NameRegistry } from '../bot/name-registry';
import { VoxtaClient } from '../bot/voxta/client';
import type { ServerMessage, ServerActionMessage, ServerWelcomeMessage, ServerReplyChunkMessage } from '../bot/voxta/types';
import type { BotConfig, BotStatus, ChatMessage, ActionToggle, CharacterInfo, McSettings } from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';
import type { CompanionConfig } from '../bot/config';
import type { MinecraftBot } from '../bot/minecraft/bot';
import type { ScenarioAction } from '../bot/voxta/types';

type BotEngineEvent = 'status-changed' | 'chat-message' | 'action-triggered' | 'characters-available';

export class BotEngine extends EventEmitter {
    private mcBot: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private assistantId: string | null = null;
    private assistantName: string | null = null;
    private currentReply = '';
    private messageCounter = 0;
    private actionToggles: Map<string, boolean> = new Map();
    private readonly names = new NameRegistry();
    private characters: CharacterInfo[] = [];
    private defaultAssistantId: string | null = null;
    private currentConfig: CompanionConfig | null = null;
    private voxtaUserName: string | null = null;
    private playerMcUsername: string | null = null;
    private settings: McSettings = { ...DEFAULT_SETTINGS };
    private isReplying = false;
    private pendingNotes: string[] = [];
    private followingPlayer: string | null = null; // Track who we're following to resume after tasks
    private recentEvents: string[] = []; // Events injected into context on next perception tick

    private status: BotStatus = {
        mc: 'disconnected',
        voxta: 'disconnected',
        position: null,
        health: null,
        currentAction: null,
        assistantName: null,
        sessionId: null,
    };

    constructor() {
        super();
        for (const action of MINECRAFT_ACTIONS) {
            this.actionToggles.set(action.name, true);
        }
    }

    override emit(event: BotEngineEvent, ...args: unknown[]): boolean {
        return super.emit(event, ...args);
    }

    getStatus(): BotStatus {
        return { ...this.status };
    }

    getActions(): ActionToggle[] {
        return MINECRAFT_ACTIONS.map((a) => ({
            name: a.name,
            description: a.description,
            enabled: this.actionToggles.get(a.name) ?? true,
            category: this.categorizeAction(a.name),
        }));
    }

    private categorizeAction(name: string): 'movement' | 'combat' | 'communication' {
        if (['mc_follow_player', 'mc_go_to', 'mc_stop', 'mc_look_at'].includes(name)) return 'movement';
        if (['mc_attack', 'mc_mine_block'].includes(name)) return 'combat';
        return 'communication';
    }

    toggleAction(name: string, enabled: boolean): void {
        this.actionToggles.set(name, enabled);
        this.pushActionsToVoxta();
    }

    private getEnabledActions(): ScenarioAction[] {
        return MINECRAFT_ACTIONS.filter((a) => this.actionToggles.get(a.name) !== false);
    }

    private pushActionsToVoxta(): void {
        if (!this.voxta?.sessionId) return;
        void this.voxta.updateContext(
            [{ text: 'The user is playing Minecraft. You are their AI companion bot inside the game world. You can see the world around you and perform actions.' }],
            this.getEnabledActions(),
        );
    }

    private updateStatus(patch: Partial<BotStatus>): void {
        Object.assign(this.status, patch);
        this.emit('status-changed', this.getStatus());
    }

    updateSettings(newSettings: McSettings): void {
        this.settings = { ...newSettings };
    }

    /** Queue a note — sent immediately if AI is idle, queued if AI is speaking */
    private queueNote(text: string): void {
        if (this.isReplying) {
            this.pendingNotes.push(text);
        } else {
            void this.voxta?.sendNote(text);
        }
    }

    /** Flush all queued notes after AI finishes speaking */
    private flushPendingNotes(): void {
        if (!this.voxta || this.pendingNotes.length === 0) return;
        for (const note of this.pendingNotes) {
            void this.voxta.sendNote(note);
        }
        this.pendingNotes = [];
    }

    /** Push a game event into the context queue — AI sees it via updateContext, not as a user message */
    private pushEvent(text: string): void {
        this.recentEvents.push(text);
        // Keep only latest 10 events
        if (this.recentEvents.length > 10) {
            this.recentEvents.shift();
        }
    }

    private addChat(type: ChatMessage['type'], sender: string, text: string): void {
        const msg: ChatMessage = {
            id: `msg-${++this.messageCounter}`,
            timestamp: Date.now(),
            type,
            sender,
            text,
        };
        this.emit('chat-message', msg);
    }

    async connect(uiConfig: BotConfig): Promise<void> {
        const config = this.toCompanionConfig(uiConfig);
        this.currentConfig = config;
        this.playerMcUsername = uiConfig.playerMcUsername || null;

        // ---- 1. Connect Minecraft ----
        this.updateStatus({ mc: 'connecting' });
        this.addChat('system', 'System', `Connecting to MC ${config.mc.host}:${config.mc.port}...`);

        try {
            this.mcBot = createMinecraftBot(config);
            await this.mcBot.connect();
            this.updateStatus({ mc: 'connected' });
            this.addChat('system', 'System', `Minecraft bot spawned as ${config.mc.username}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateStatus({ mc: 'error' });
            this.addChat('system', 'System', `MC connection failed: ${message}`);
            return;
        }

        const bot = this.mcBot.bot;

        // ---- 2. Connect Voxta ----
        this.updateStatus({ voxta: 'connecting' });
        this.addChat('system', 'System', 'Connecting to Voxta...');

        this.voxta = new VoxtaClient(config);

        this.voxta.onMessage((message: ServerMessage) => {
            this.handleVoxtaMessage(message);
        });

        try {
            await this.voxta.connect();

            // Wait for auth
            const authStart = Date.now();
            while (!this.voxta.authenticated && Date.now() - authStart < 15000) {
                await new Promise((r) => setTimeout(r, 200));
            }

            if (!this.voxta.authenticated) {
                this.updateStatus({ voxta: 'error' });
                this.addChat('system', 'System', 'Voxta authentication timed out');
                return;
            }

            this.updateStatus({ voxta: 'connected' });
            this.addChat('system', 'System', 'Connected to Voxta!');

            // Register app
            await this.voxta.registerApp();

            // Fetch characters from REST API
            const baseUrl = config.voxta.url.replace(/\/hub\/?$/, '');
            const headers: Record<string, string> = {};
            if (config.voxta.apiKey) {
                headers['Authorization'] = `Bearer ${config.voxta.apiKey}`;
            }
            const res = await fetch(`${baseUrl}/api/characters/?assistant=true`, { headers });
            if (res.ok) {
                const data = await res.json() as { characters: Array<{ id: string; name: string }> };
                this.characters = data.characters.map((c) => ({ id: c.id, name: c.name }));
            }

            // Emit characters for the UI to show picker
            this.addChat('system', 'System', `${this.characters.length} character(s) available — select one to start chatting`);
            this.emit('characters-available', this.characters, this.defaultAssistantId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateStatus({ voxta: 'error' });
            this.addChat('system', 'System', `Voxta connection failed: ${message}`);
            return;
        }
    }

    async startChat(characterId: string): Promise<void> {
        if (!this.voxta || !this.mcBot) return;

        const config = this.currentConfig;
        if (!config) return;

        const bot = this.mcBot.bot;
        const character = this.characters.find((c) => c.id === characterId);
        this.assistantName = character?.name ?? 'AI';

        // Populate name registry
        this.names.clear();
        if (this.voxtaUserName && this.playerMcUsername) {
            this.names.register(this.voxtaUserName, this.playerMcUsername);
        }
        if (this.assistantName && config.mc.username) {
            this.names.register(this.assistantName, config.mc.username);
        }

        await this.voxta.startChat(characterId);

        const chatStart = Date.now();
        while (!this.voxta.sessionId && Date.now() - chatStart < 15000) {
            await new Promise((r) => setTimeout(r, 200));
        }

        this.updateStatus({
            sessionId: this.voxta.sessionId,
            assistantName: this.assistantName,
        });

        // Register actions
        this.pushActionsToVoxta();
        this.addChat('system', 'System', `Chat started with ${this.assistantName}`);

        // ---- Perception loop ----
        let lastContextHash = '';
        this.perceptionLoop = setInterval(() => {
            if (!this.voxta?.sessionId) return;
            try {
                const state = readWorldState(bot, config.perception.entityRange);
                const contextStrings = buildContextStrings(state, this.names, this.assistantName);

                // Append recent events to context
                if (this.recentEvents.length > 0) {
                    contextStrings.push('Recent events: ' + this.recentEvents.join(' | '));
                }

                const contextHash = contextStrings.join('|');

                this.updateStatus({
                    position: state.position ? { x: Math.round(state.position.x), y: Math.round(state.position.y), z: Math.round(state.position.z) } : null,
                    health: state.health,
                });

                if (contextHash !== lastContextHash) {
                    lastContextHash = contextHash;
                    void this.voxta.updateContext(
                        contextStrings.map((text) => ({ text })),
                    );
                    // Clear events after they've been sent to context
                    this.recentEvents = [];
                }
            } catch {
                // Perception can fail during respawn/chunk loading
            }
        }, config.perception.intervalMs);

        // ---- 4. Bridge MC chat ----
        bot.on('chat', (username: string, message: string) => {
            if (username === bot.username) return;
            if (!this.voxta?.sessionId) return;
            if (!this.settings.enableTelemetryChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.addChat('player', voxtaName, resolvedMsg);
            void this.voxta.sendMessage(`[${voxtaName} says in Minecraft chat]: ${resolvedMsg}`);
        });

        bot.on('whisper', (username: string, message: string) => {
            if (username === bot.username) return;
            if (!this.voxta?.sessionId) return;
            if (!this.settings.enableTelemetryChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            const resolvedMsg = this.names.resolveNamesInText(message);
            this.addChat('player', `${voxtaName} (whisper)`, resolvedMsg);
            void this.voxta.sendMessage(`[${voxtaName} whispers in Minecraft]: ${resolvedMsg}`);
        });

        // ---- 5. MC Game Events (with cooldowns to prevent spam) ----
        let lastHealth = bot.health;
        const eventCooldowns = new Map<string, number>();
        const EVENT_COOLDOWN_MS = 15_000; // 15s between same event type
        let pendingDamage = 0;
        let damageTimer: ReturnType<typeof setTimeout> | null = null;
        let lastAttacker: string | null = null;
        let lastAttackerTime = 0;

        const isOnCooldown = (key: string): boolean => {
            const last = eventCooldowns.get(key);
            if (last && Date.now() - last < EVENT_COOLDOWN_MS) return true;
            eventCooldowns.set(key, Date.now());
            return false;
        };

        /** Guess damage source from bot state and recent attacker */
        const getDamageSource = (): string => {
            // Recent attacker (within 2 seconds)
            if (lastAttacker && Date.now() - lastAttackerTime < 2000) {
                const source = lastAttacker;
                lastAttacker = null;
                return source;
            }
            // Starvation: food at 0 causes periodic damage
            if (bot.food === 0) return 'starvation (no food)';
            // Environmental checks via entity metadata
            const meta = bot.entity as unknown as Record<string, unknown>;
            if (meta['isInLava']) return 'lava';
            if (meta['isInFire'] || meta['onFire']) return 'fire';
            // Fall damage: check if velocity was high before landing
            return 'falling or environment';
        };

        bot.on('health', () => {
            if (!this.voxta?.sessionId) return;
            const currentHealth = Math.round(bot.health * 10) / 10;
            if (currentHealth < lastHealth && this.settings.enableEventDamage) {
                const damage = Math.round((lastHealth - currentHealth) * 10) / 10;
                const source = getDamageSource();
                pendingDamage += damage;
                const botName = this.assistantName ?? 'Bot';
                this.addChat('event', 'Event', `${botName} took ${damage} damage from ${source}! Health: ${currentHealth}/20`);

                // Consolidate damage into one message after a short delay
                if (!damageTimer) {
                    const damageSource = source;
                    damageTimer = setTimeout(() => {
                        const totalDmg = Math.round(pendingDamage * 10) / 10;
                        const hp = Math.round(bot.health * 10) / 10;
                        if (this.voxta?.sessionId) {
                            const botName = this.assistantName ?? 'Bot';
                            void this.voxta.sendEvent(
                                `${botName} took ${totalDmg} total damage from ${damageSource}! Health is now: ${hp}/20`,
                            );
                        }
                        pendingDamage = 0;
                        damageTimer = null;
                    }, 3000);
                }
            }
            lastHealth = currentHealth;
        });

        bot.on('death', () => {
            if (!this.voxta?.sessionId) return;
            if (!this.settings.enableEventDeath) return;
            lastHealth = 20;
            pendingDamage = 0;
            if (damageTimer) { clearTimeout(damageTimer); damageTimer = null; }
            this.addChat('event', 'Event', `${this.assistantName ?? 'Bot'} died!`);
            void this.voxta.sendEvent(`${this.assistantName ?? 'Bot'} has died and respawned!`);
        });

        // Track actual attackers via arm swing animation (melee hits)
        let lastSwingAttacker: string | null = null;
        let lastSwingTime = 0;
        bot.on('entitySwingArm', (entity: Entity) => {
            if (entity.id === bot.entity.id) return;
            // Only track if they're close enough to actually hit the bot
            if (entity.position.distanceTo(bot.entity.position) < 6) {
                const mcName = entity.username ?? entity.displayName ?? entity.name ?? 'something';
                lastSwingAttacker = this.names.resolveToVoxta(mcName);
                lastSwingTime = Date.now();
            }
        });

        bot.on('entityHurt', (entity: { id: number }) => {
            if (!this.voxta?.sessionId) return;
            if (entity.id !== bot.entity.id) return;
            // Use the entity that actually swung at us (within last 1.5s)
            if (lastSwingAttacker && Date.now() - lastSwingTime < 1500) {
                lastAttacker = lastSwingAttacker;
                lastAttackerTime = Date.now();
                lastSwingAttacker = null;
            } else {
                // Fallback for ranged attacks: find nearest hostile mob
                const hostileMob = Object.values(bot.entities).find(
                    (e) => e !== bot.entity
                        && (e.type === 'mob' || e.type === 'hostile')
                        && e.position.distanceTo(bot.entity.position) < 16,
                );
                if (hostileMob) {
                    const mcName = hostileMob.username ?? hostileMob.displayName ?? hostileMob.name ?? 'something';
                    lastAttacker = this.names.resolveToVoxta(mcName);
                    lastAttackerTime = Date.now();
                }
            }
            if (!this.settings.enableEventUnderAttack) return;
            if (isOnCooldown('underAttack')) return;
            if (lastAttacker) {
                this.addChat('event', 'Event', `${this.assistantName ?? 'Bot'} is under attack by ${lastAttacker}!`);
                void this.voxta.sendEvent(`${this.assistantName ?? 'Bot'} is being attacked by ${lastAttacker}!`);
            }
        });

        // Track item pickups via inventory changes
        bot.inventory.on('updateSlot', (slot: number, oldItem: { name: string; count: number } | null, newItem: { name: string; displayName: string; count: number } | null) => {
            if (!this.voxta?.sessionId) return;
            if (!this.settings.enableTelemetryItemPickup) return;
            if (!newItem) return;
            const gained = oldItem && oldItem.name === newItem.name
                ? newItem.count - oldItem.count
                : newItem.count;
            if (gained <= 0) return;
            const name = newItem.displayName ?? newItem.name;
            const botName = this.assistantName ?? 'Bot';
            this.addChat('system', 'Telemetry', `${botName} picked up ${gained} ${name}`);
            this.queueNote(`${botName} picked up ${gained} ${name}`);
        });

        bot.chat("Hello! I'm your Voxta AI companion. Talk to me!");
    }

    async disconnect(): Promise<void> {
        if (this.perceptionLoop) {
            clearInterval(this.perceptionLoop);
            this.perceptionLoop = null;
        }

        if (this.mcBot) {
            try {
                this.mcBot.bot.chat('Goodbye!');
                this.mcBot.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.mcBot = null;
        }

        if (this.voxta) {
            try {
                await this.voxta.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.voxta = null;
        }

        this.assistantId = null;
        this.assistantName = null;
        this.currentReply = '';

        this.updateStatus({
            mc: 'disconnected',
            voxta: 'disconnected',
            position: null,
            health: null,
            currentAction: null,
            assistantName: null,
            sessionId: null,
        });

        this.addChat('system', 'System', 'Disconnected');
    }

    async sendMessage(text: string): Promise<void> {
        if (!this.voxta?.sessionId) return;
        this.addChat('player', 'You', text);
        await this.voxta.sendMessage(text);
    }

    private handleVoxtaMessage(message: ServerMessage): void {
        switch (message.$type) {
            case 'welcome': {
                const welcome = message as ServerWelcomeMessage;
                this.characters = (welcome.characters ?? []).map((c) => ({ id: c.id, name: c.name }));
                this.voxtaUserName = welcome.user?.name ?? null;
                if (welcome.assistant) {
                    this.defaultAssistantId = welcome.assistant.id;
                }
                break;
            }
            case 'replyChunk': {
                const chunk = message as ServerReplyChunkMessage;
                this.currentReply += chunk.text;
                break;
            }
            case 'replyGenerating':
                this.isReplying = true;
                break;
            case 'replyEnd': {
                if (this.currentReply.trim()) {
                    const chatText = this.currentReply.trim();
                    this.addChat('ai', this.assistantName ?? 'AI', chatText);

                    // Speak in MC chat
                    if (this.mcBot) {
                        const maxLen = 250;
                        for (let i = 0; i < chatText.length; i += maxLen) {
                            this.mcBot.bot.chat(chatText.substring(i, i + maxLen));
                        }
                    }
                }
                this.currentReply = '';
                this.isReplying = false;
                this.flushPendingNotes();
                break;
            }
            case 'action': {
                const action = message as ServerActionMessage;
                const actionName = action.value?.trim() ?? '';

                // Ignore empty actions (AI sometimes sends action () with no name)
                if (!actionName) {
                    this.updateStatus({ currentAction: null });
                    break;
                }

                this.updateStatus({ currentAction: actionName });
                this.addChat('action', 'Action', `${actionName}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`);

                if (this.mcBot) {
                    // Track follow state
                    if (actionName === 'mc_follow_player') {
                        const playerArg = action.arguments?.find((a) => a.name.toLowerCase() === 'player_name');
                        // Strip LLM type annotations like 'string="Lapiro' → 'Lapiro'
                        let rawVal = playerArg?.value ?? '';
                        const eqIdx = rawVal.lastIndexOf('=');
                        if (eqIdx >= 0) rawVal = rawVal.slice(eqIdx + 1);
                        rawVal = rawVal.replace(/"/g, '').trim();
                        this.followingPlayer = rawVal || null;
                    } else if (actionName === 'mc_stop') {
                        this.followingPlayer = null;
                    }

                    void executeAction(this.mcBot.bot, actionName, action.arguments, this.names).then(async (result) => {
                        const botName = this.assistantName ?? 'Bot';
                        // Don't show empty results (e.g. mc_acknowledge)
                        if (result) {
                            this.addChat('system', 'System', `${botName}: ${result}`);
                        }
                        this.updateStatus({ currentAction: null });

                        // Resume following if we were following before this action (silent — UI only)
                        const shouldResume = this.followingPlayer
                            && actionName !== 'mc_follow_player'
                            && actionName !== 'mc_stop'
                            && actionName !== 'mc_acknowledge';
                        console.log(`[Bot] Action done: ${actionName}, followingPlayer: ${this.followingPlayer}, shouldResume: ${!!shouldResume}`);
                        if (shouldResume && this.mcBot) {
                            const resumeResult = await executeAction(
                                this.mcBot.bot, 'mc_follow_player',
                                [{ name: 'player_name', value: this.followingPlayer ?? '' }],
                                this.names,
                            );
                            console.log(`[Bot] Resumed following: ${resumeResult}`);
                        }

                        if (!this.settings.enableTelemetryActionResults) return;
                        // Only send event for long-running actions (not follow, equip, look, stop, say)
                        const QUICK_ACTIONS = ['mc_follow_player', 'mc_stop', 'mc_equip', 'mc_look_at', 'mc_acknowledge'];
                        if (QUICK_ACTIONS.includes(actionName)) return;
                        // Use sendEvent so AI responds without it appearing as user message
                        if (this.isReplying) {
                            this.queueNote(`${botName}: ${result}`);
                        } else if (this.voxta?.sessionId) {
                            void this.voxta.sendEvent(`${botName} finished: ${result}`);
                        }
                    });
                }
                break;
            }
            case 'speechRecognitionEnd': {
                const text = (message as { text?: string }).text;
                if (text) {
                    this.addChat('player', 'You (voice)', text);
                    void this.voxta?.sendMessage(text);
                }
                break;
            }
        }
    }

    private toCompanionConfig(ui: BotConfig): CompanionConfig {
        return {
            mc: {
                host: ui.mcHost,
                port: ui.mcPort,
                username: ui.mcUsername,
                version: ui.mcVersion,
            },
            voxta: {
                url: ui.voxtaUrl,
                apiKey: ui.voxtaApiKey,
                clientName: 'Voxta.Minecraft',
                clientVersion: '0.2.0',
            },
            perception: {
                intervalMs: ui.perceptionIntervalMs,
                entityRange: ui.entityRange,
            },
        };
    }
}
