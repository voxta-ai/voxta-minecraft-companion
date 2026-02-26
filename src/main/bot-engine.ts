import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
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
                const contextStrings = buildContextStrings(state);
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
            this.addChat('player', voxtaName, message);
            void this.voxta.sendMessage(`[${voxtaName} says in Minecraft chat]: ${message}`);
        });

        bot.on('whisper', (username: string, message: string) => {
            if (username === bot.username) return;
            if (!this.voxta?.sessionId) return;
            if (!this.settings.enableTelemetryChat) return;
            const voxtaName = this.names.resolveToVoxta(username);
            this.addChat('player', `${voxtaName} (whisper)`, message);
            void this.voxta.sendMessage(`[${voxtaName} whispers in Minecraft]: ${message}`);
        });

        // ---- 5. MC Game Events (with cooldowns to prevent spam) ----
        let lastHealth = bot.health;
        const eventCooldowns = new Map<string, number>();
        const EVENT_COOLDOWN_MS = 15_000; // 15s between same event type
        let pendingDamage = 0;
        let damageTimer: ReturnType<typeof setTimeout> | null = null;

        const isOnCooldown = (key: string): boolean => {
            const last = eventCooldowns.get(key);
            if (last && Date.now() - last < EVENT_COOLDOWN_MS) return true;
            eventCooldowns.set(key, Date.now());
            return false;
        };

        bot.on('health', () => {
            if (!this.voxta?.sessionId) return;
            const currentHealth = Math.round(bot.health * 10) / 10;
            if (currentHealth < lastHealth && this.settings.enableEventDamage) {
                const damage = Math.round((lastHealth - currentHealth) * 10) / 10;
                pendingDamage += damage;
                this.addChat('event', 'Event', `Took ${damage} damage! Health: ${currentHealth}/20`);

                // Consolidate damage into one message after a short delay
                if (!damageTimer) {
                    damageTimer = setTimeout(() => {
                        const totalDmg = Math.round(pendingDamage * 10) / 10;
                        const hp = Math.round(bot.health * 10) / 10;
                        if (this.voxta?.sessionId) {
                            void this.voxta.sendMessage(
                                `[event]: Bot took ${totalDmg} total damage! Health now: ${hp}/20`,
                            );
                        }
                        pendingDamage = 0;
                        damageTimer = null;
                    }, 3000); // Wait 3s to consolidate hits
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
            this.addChat('event', 'Event', 'Bot died!');
            void this.voxta.sendMessage('[event]: Bot has died and respawned!');
        });

        bot.on('entityHurt', (entity: { id: number }) => {
            if (!this.voxta?.sessionId) return;
            if (entity.id !== bot.entity.id) return;
            if (!this.settings.enableEventUnderAttack) return;
            if (isOnCooldown('underAttack')) return;
            // Find the attacker and resolve their name to Voxta name
            const attacker = bot.nearestEntity((e) => e !== bot.entity && e.position.distanceTo(bot.entity.position) < 6);
            if (attacker) {
                const mcName = attacker.username ?? attacker.displayName ?? attacker.name ?? 'something';
                const voxtaName = this.names.resolveToVoxta(mcName);
                this.addChat('event', 'Event', `Under attack by ${voxtaName}!`);
                void this.voxta.sendMessage(`[event]: Bot is being attacked by ${voxtaName}!`);
            }
        });

        bot.on('playerCollect', (collector: { id: number }, collected: { id: number }) => {
            if (!this.voxta?.sessionId) return;
            if (collector.id !== bot.entity.id) return;
            if (!this.settings.enableTelemetryItemPickup) return;
            this.addChat('system', 'Telemetry', 'Picked up an item');
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
                this.updateStatus({ currentAction: action.value });
                this.addChat('action', 'Action', `${action.value}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`);

                if (this.mcBot) {
                    void executeAction(this.mcBot.bot, action.value, action.arguments, this.names).then((result) => {
                        this.addChat('system', 'System', `Action result: ${result}`);
                        this.updateStatus({ currentAction: null });
                        // Queue result as a note — will be sent after AI finishes speaking
                        if (this.settings.enableTelemetryActionResults) {
                            this.queueNote(`[event]: Action result: ${result}`);
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
