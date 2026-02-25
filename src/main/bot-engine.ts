import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS, executeAction } from '../bot/minecraft/actions';
import { VoxtaClient } from '../bot/voxta/client';
import type { ServerMessage, ServerActionMessage, ServerWelcomeMessage, ServerReplyChunkMessage } from '../bot/voxta/types';
import type { BotConfig, BotStatus, ChatMessage, ActionToggle } from '../shared/ipc-types';
import type { CompanionConfig } from '../bot/config';
import type { MinecraftBot } from '../bot/minecraft/bot';
import type { ScenarioAction } from '../bot/voxta/types';

type BotEngineEvent = 'status-changed' | 'chat-message' | 'action-triggered';

export class BotEngine extends EventEmitter {
    private mcBot: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private assistantId: string | null = null;
    private assistantName: string | null = null;
    private currentReply = '';
    private messageCounter = 0;
    private actionToggles: Map<string, boolean> = new Map();

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

            // Start chat
            if (this.assistantId) {
                await this.voxta.startChat(this.assistantId);

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
                this.addChat('system', 'System', `Chat started with ${this.assistantName ?? 'assistant'}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateStatus({ voxta: 'error' });
            this.addChat('system', 'System', `Voxta connection failed: ${message}`);
            return;
        }

        // ---- 3. Perception loop ----
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
            this.addChat('player', username, message);
            void this.voxta.sendMessage(`[${username} says in Minecraft chat]: ${message}`);
        });

        bot.on('whisper', (username: string, message: string) => {
            if (username === bot.username) return;
            if (!this.voxta?.sessionId) return;
            this.addChat('player', `${username} (whisper)`, message);
            void this.voxta.sendMessage(`[${username} whispers in Minecraft]: ${message}`);
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
                if (welcome.assistant) {
                    this.assistantId = welcome.assistant.id;
                    this.assistantName = welcome.assistant.name;
                }
                break;
            }
            case 'replyChunk': {
                const chunk = message as ServerReplyChunkMessage;
                this.currentReply += chunk.text;
                break;
            }
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
                break;
            }
            case 'action': {
                const action = message as ServerActionMessage;
                this.updateStatus({ currentAction: action.value });
                this.addChat('action', 'Action', `${action.value}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`);

                if (this.mcBot) {
                    void executeAction(this.mcBot.bot, action.value, action.arguments).then((result) => {
                        this.addChat('system', 'System', `Action result: ${result}`);
                        this.updateStatus({ currentAction: null });
                    });
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
