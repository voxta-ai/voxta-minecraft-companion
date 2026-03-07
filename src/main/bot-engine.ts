import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, initHomePosition, resumeFollowPlayer } from '../bot/minecraft/action-dispatcher';
import { McEventBridge } from '../bot/minecraft/events';
import { NameRegistry } from '../bot/name-registry';
import { VoxtaClient } from '../bot/voxta/client';
import type { ServerMessage } from '../bot/voxta/types';
import type { VoxtaConnectConfig, VoxtaInfo, BotConfig, BotStatus, ChatMessage, ActionToggle, CharacterInfo, ChatListItem, ToastMessage, ToastType, McSettings, AudioPlaybackEvent } from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';
import type { CompanionConfig } from '../bot/config';
import type { MinecraftBot } from '../bot/minecraft/bot';
import type { ScenarioAction } from '../bot/voxta/types';
import { AudioPipeline } from './audio-pipeline';
import { dispatchVoxtaMessage } from './voxta-message-handler';

// Centralized version constant
const CLIENT_NAME = 'Voxta.Minecraft';
const CLIENT_VERSION = '0.2.0';

type BotEngineEvent = 'status-changed' | 'chat-message' | 'clear-chat' | 'inspector-update' | 'action-triggered' | 'toast' | 'play-audio' | 'stop-audio' | 'recording-start' | 'recording-stop';

export class BotEngine extends EventEmitter {
    private mcBot: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private eventBridge: McEventBridge | null = null;
    private assistantName: string | null = null;
    private currentReply = '';
    private messageCounter = 0;
    private actionToggles: Map<string, boolean> = new Map();
    private readonly names = new NameRegistry();
    private characters: CharacterInfo[] = [];
    private defaultAssistantId: string | null = null;
    private voxtaUserName: string | null = null;
    private playerMcUsername: string | null = null;
    private voxtaUrl: string | null = null;
    private voxtaApiKey: string | null = null;
    private settings: McSettings = { ...DEFAULT_SETTINGS };
    private isReplying = false;
    private pendingNotes: string[] = [];
    private followingPlayer: string | null = null; // Track who we're following to resume after tasks
    private toastCounter = 0;

    private readonly audioPipeline: AudioPipeline;

    private status: BotStatus = {
        mc: 'disconnected',
        voxta: 'disconnected',
        position: null,
        health: null,
        food: null,
        currentAction: null,
        assistantName: null,
        sessionId: null,
    };

    constructor() {
        super();
        for (const action of MINECRAFT_ACTIONS) {
            this.actionToggles.set(action.name, true);
        }
        this.audioPipeline = new AudioPipeline((chunk) => this.emit('play-audio', chunk));
    }

    override emit(event: BotEngineEvent, ...args: unknown[]): boolean {
        return super.emit(event, ...args);
    }

    /** Emit a toast notification to the renderer */
    private toast(type: ToastType, message: string, durationMs?: number): void {
        const toast: ToastMessage = {
            id: `toast-${++this.toastCounter}`,
            type,
            message,
            durationMs,
        };
        this.emit('toast', toast);
    }

    /** Convert raw errors into user-friendly messages */
    private humanizeError(err: unknown, context: string): string {
        // Build a comprehensive string to search — AggregateError has an empty message
        // but stores error codes in .code and a nested .errors[] array
        let raw = '';
        if (err instanceof Error) {
            raw = err.message || '';
            const errWithCode = err as Error & { code?: string; errors?: Error[] };
            if (errWithCode.code) raw += ` ${errWithCode.code}`;
            if (errWithCode.errors) {
                for (const nested of errWithCode.errors) {
                    raw += ` ${nested.message}`;
                    if ((nested as Error & { code?: string }).code) {
                        raw += ` ${(nested as Error & { code?: string }).code}`;
                    }
                }
            }
        } else {
            raw = String(err);
        }

        // Minecraft connection errors
        if (raw.includes('ECONNREFUSED')) {
            return `Cannot connect to Minecraft server — is the server running and the port correct?`;
        }
        if (raw.includes('ETIMEDOUT') || raw.includes('EHOSTUNREACH')) {
            return `Cannot reach Minecraft server — check the host address and make sure the server is accessible.`;
        }
        if (raw.includes('ENOTFOUND')) {
            return `Server address not found — check the host name is correct.`;
        }

        // Voxta connection errors
        if (raw.includes('Failed to complete negotiation') || raw.includes('Status code')) {
            return `Cannot connect to Voxta — is the server running at the specified URL?`;
        }
        if (raw.includes('authentication') || raw.includes('401') || raw.includes('403')) {
            return `Voxta authentication failed — check your API key.`;
        }

        // Generic
        if (raw.includes('timed out')) {
            return `${context} timed out — try again.`;
        }

        return `${context}: ${raw}`;
    }

    getStatus(): BotStatus {
        return { ...this.status };
    }

    getActions(): ActionToggle[] {
        return MINECRAFT_ACTIONS.map((a) => ({
            name: a.name,
            description: a.description,
            enabled: this.actionToggles.get(a.name) ?? true,
            category: a.category,
        }));
    }

    toggleAction(name: string, enabled: boolean): void {
        this.actionToggles.set(name, enabled);
        this.pushActionsToVoxta();
    }

    private getEnabledActions(): ScenarioAction[] {
        const timing = this.settings.actionInferenceTiming === 'user'
            ? 'AfterUserMessage' as const
            : 'AfterAssistantMessage' as const;
        return MINECRAFT_ACTIONS
            .filter((a) => this.actionToggles.get(a.name) !== false)
            .map((a) => ({ ...a, timing }));
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
        const timingChanged = this.settings.actionInferenceTiming !== newSettings.actionInferenceTiming;
        this.settings = { ...newSettings };
        if (timingChanged) {
            this.pushActionsToVoxta();
        }
    }

    /** Queue a note — sent immediately if AI is idle, queued if AI is speaking */
    private queueNote(text: string): void {
        if (this.isReplying) {
            console.log(`[Bot >>] note (queued): "${text.substring(0, 80)}"`);
            this.pendingNotes.push(text);
        } else {
            console.log(`[Bot >>] note: "${text.substring(0, 80)}"`);
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

    // ---- Phase 1: Connect to Voxta only ----

    async connectVoxta(voxtaConfig: VoxtaConnectConfig): Promise<VoxtaInfo> {
        this.voxtaUrl = voxtaConfig.voxtaUrl;
        this.voxtaApiKey = voxtaConfig.voxtaApiKey;

        this.updateStatus({ voxta: 'connecting' });
        this.addChat('system', 'System', 'Connecting to Voxta...');

        const companionConfig: CompanionConfig = {
            mc: { host: '', port: 0, username: '', version: '' },
            voxta: {
                url: voxtaConfig.voxtaUrl,
                apiKey: voxtaConfig.voxtaApiKey,
                clientName: CLIENT_NAME,
                clientVersion: CLIENT_VERSION,
            },
            perception: { intervalMs: 3000, entityRange: 32 },
        };

        this.voxta = new VoxtaClient(companionConfig);

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
                this.toast('error', 'Voxta authentication timed out — check your API key and try again.');
                throw new Error('Voxta authentication timed out');
            }

            this.updateStatus({ voxta: 'connected' });
            this.addChat('system', 'System', 'Connected to Voxta!');
            this.toast('success', 'Connected to Voxta!');

            // Register app
            await this.voxta.registerApp();

            // Fetch characters from REST API
            const baseUrl = voxtaConfig.voxtaUrl.replace(/\/hub\/?$/, '');
            const headers: Record<string, string> = {};
            if (voxtaConfig.voxtaApiKey) {
                headers['Authorization'] = `Bearer ${voxtaConfig.voxtaApiKey}`;
            }
            const res = await fetch(`${baseUrl}/api/characters/?assistant=true`, { headers });
            if (res.ok) {
                const data = await res.json() as { characters: Array<{ id: string; name: string }> };
                this.characters = data.characters.map((c) => ({ id: c.id, name: c.name }));
            }

            const userName = this.voxtaUserName ?? 'Player';
            this.addChat('system', 'System', `Welcome, ${userName}! ${this.characters.length} character(s) available.`);

            return {
                userName,
                characters: this.characters,
                defaultAssistantId: this.defaultAssistantId,
            };
        } catch (err) {
            const message = this.humanizeError(err, 'Voxta connection');
            this.updateStatus({ voxta: 'error' });
            this.addChat('system', 'System', `Voxta connection failed: ${message}`);
            this.toast('error', message);
            throw err;
        }
    }

    // ---- Load previous chats for a character ----

    async loadChats(characterId: string): Promise<ChatListItem[]> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        const baseUrl = this.voxtaUrl.replace(/\/hub\/?$/, '');
        const headers: Record<string, string> = {};
        if (this.voxtaApiKey) {
            headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;
        }
        const res = await fetch(`${baseUrl}/api/chats?characterId=${characterId}`, { headers });
        if (!res.ok) {
            console.error(`[Voxta] Failed to load chats: ${res.status}`);
            return [];
        }
        const data = await res.json() as { chats: Array<{ id: string; title?: string; created: string; lastSession?: string; lastSessionTimestamp?: string; createdTimestamp?: string; favorite?: boolean }> };
        return data.chats.map((c) => ({
            id: c.id,
            title: c.title ?? null,
            created: c.created,
            lastSession: c.lastSession ?? null,
            lastSessionTimestamp: c.lastSessionTimestamp ?? c.createdTimestamp ?? null,
            favorite: c.favorite ?? false,
        }));
    }

    async favoriteChat(chatId: string, favorite: boolean): Promise<void> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        const baseUrl = this.voxtaUrl.replace(/\/hub\/?$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.voxtaApiKey) {
            headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;
        }
        const res = await fetch(`${baseUrl}/api/chats/${chatId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ favorite }),
        });
        if (!res.ok) {
            console.error(`[Voxta] Failed to toggle favorite: ${res.status}`);
        }
    }

    async deleteChat(chatId: string): Promise<void> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        const baseUrl = this.voxtaUrl.replace(/\/hub\/?$/, '');
        const headers: Record<string, string> = {};
        if (this.voxtaApiKey) {
            headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;
        }
        const res = await fetch(`${baseUrl}/api/chats/${chatId}`, {
            method: 'DELETE',
            headers,
        });
        if (!res.ok) {
            console.error(`[Voxta] Failed to delete chat: ${res.status}`);
        }
    }

    // ---- Phase 2: Launch MC bot + start chat ----

    async launchBot(uiConfig: BotConfig): Promise<void> {
        if (!this.voxta) {
            throw new Error('Must connect to Voxta first');
        }

        const config: CompanionConfig = {
            mc: {
                host: uiConfig.mcHost,
                port: uiConfig.mcPort,
                username: uiConfig.mcUsername,
                version: uiConfig.mcVersion,
            },
            voxta: {
                url: this.voxtaUrl ?? '',
                apiKey: this.voxtaApiKey ?? '',
                clientName: CLIENT_NAME,
                clientVersion: CLIENT_VERSION,
            },
            perception: {
                intervalMs: uiConfig.perceptionIntervalMs,
                entityRange: uiConfig.entityRange,
            },
        };
        this.playerMcUsername = uiConfig.playerMcUsername || null;

        // ---- 1. Connect Minecraft ----
        this.updateStatus({ mc: 'connecting' });
        this.addChat('system', 'System', `Connecting to MC ${config.mc.host}:${config.mc.port}...`);

        try {
            this.mcBot = createMinecraftBot(config);
            await this.mcBot.connect();
            initHomePosition(config.mc.host, config.mc.port);
            this.updateStatus({ mc: 'connected' });
            this.addChat('system', 'System', `Minecraft bot spawned as ${config.mc.username}`);
            this.toast('success', `Bot "${config.mc.username}" joined the Minecraft server!`);
        } catch (err) {
            const message = this.humanizeError(err, 'Minecraft connection');
            this.updateStatus({ mc: 'error' });
            this.addChat('system', 'System', `MC connection failed: ${message}`);
            this.toast('error', message);
            return;
        }

        // ---- 2. Start chat with a selected character ----
        const bot = this.mcBot.bot;
        const character = this.characters.find((c) => c.id === uiConfig.characterId);
        this.assistantName = character?.name ?? 'AI';

        // Auto-detect the player's actual MC username from the server
        const botUsername = config.mc.username;
        const onlinePlayers = Object.keys(bot.players).filter(
            (name) => name !== botUsername,
        );

        if (onlinePlayers.length === 1) {
            this.playerMcUsername = onlinePlayers[0];
            this.addChat('system', 'System', `Detected player: ${this.playerMcUsername}`);
        } else if (onlinePlayers.length > 1) {
            const uiName = uiConfig.playerMcUsername;
            const match = onlinePlayers.find((p) => p.toLowerCase() === uiName.toLowerCase());
            this.playerMcUsername = match ?? onlinePlayers[0];
            this.addChat('system', 'System', `Multiple players online, using: ${this.playerMcUsername}`);
        }

        // Populate name registry
        this.names.clear();
        if (this.voxtaUserName && this.playerMcUsername) {
            this.names.register(this.voxtaUserName, this.playerMcUsername);
        }
        if (this.assistantName && config.mc.username) {
            this.names.register(this.assistantName, config.mc.username);
        }

        await this.voxta.startChat(uiConfig.characterId, uiConfig.chatId ?? undefined);

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

                const contextHash = contextStrings.join('|');

                this.updateStatus({
                    position: state.position ? { x: Math.round(state.position.x), y: Math.round(state.position.y), z: Math.round(state.position.z) } : null,
                    health: state.health,
                    food: state.food,
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

        // ---- 3. Register MC event bridge ----
        this.eventBridge = new McEventBridge(
            bot,
            this.names,
            {
                onChat: (type, sender, text) => {
                    if (!this.voxta?.sessionId) return;
                    this.addChat(type, sender, text);
                },
                onNote: (text) => {
                    if (!this.voxta?.sessionId) return;
                    this.queueNote(text);
                },
                onEvent: (text) => {
                    if (!this.voxta?.sessionId) return;
                    this.addChat('event', 'Event', text);
                    if (this.isReplying) {
                        this.queueNote(text);
                    } else {
                        void this.voxta.sendEvent(text);
                    }
                },
                getSettings: () => this.settings,
                getAssistantName: () => this.assistantName ?? 'Bot',
                isReplying: () => this.isReplying,
            },
            () => this.followingPlayer,
            async (botInstance, mobName) => {
                const botName = this.assistantName ?? 'Bot';
                console.log(`[Bot] Auto-defense started against ${mobName}, followingPlayer=${this.followingPlayer}`);
                try {
                    const result = await executeAction(botInstance, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names);
                    this.addChat('system', 'System', `${botName}: ${result}`);
                    console.log(`[Bot] Auto-defense attack result: ${result}`);
                } catch (err) {
                    console.log(`[Bot] Auto-defense attack failed:`, err);
                } finally {
                    console.log(`[Bot] Auto-defense finished, followingPlayer=${this.followingPlayer}, mcBot=${!!this.mcBot}`);
                    if (this.followingPlayer && this.mcBot) {
                        const resumeResult = resumeFollowPlayer(this.mcBot.bot, this.followingPlayer, this.names);
                        console.log(`[Bot] Resumed following after defense: ${resumeResult}`);
                    } else {
                        console.log(`[Bot] NOT resuming follow — followingPlayer=${this.followingPlayer}, mcBot=${!!this.mcBot}`);
                    }
                }
            },
        );

        bot.chat("Hello! I'm your Voxta AI companion. Talk to me!");
    }

    async disconnect(): Promise<void> {
        if (this.perceptionLoop) {
            clearInterval(this.perceptionLoop);
            this.perceptionLoop = null;
        }
        if (this.eventBridge) {
            this.eventBridge.destroy();
            this.eventBridge = null;
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

        this.assistantName = null;
        this.currentReply = '';
        this.voxtaUrl = null;
        this.voxtaApiKey = null;

        this.updateStatus({
            mc: 'disconnected',
            voxta: 'disconnected',
            position: null,
            health: null,
            food: null,
            currentAction: null,
            assistantName: null,
            sessionId: null,
        });

        this.addChat('system', 'System', 'Disconnected');
    }

    async sendMessage(text: string): Promise<void> {
        if (!this.voxta?.sessionId) return;
        console.log(`[User >>] sendMessage: "${text}"`);

        const name = this.voxtaUserName ?? 'You';
        this.addChat('player', `${name} (text)`, text);

        await this.voxta.sendMessage(text);
    }



    /** Renderer reports audio started playing — relay to the server */
    handleAudioStarted(event: AudioPlaybackEvent): void {
        if (this.voxta) this.audioPipeline.handleAudioStarted(event, this.voxta);
    }

    /** Renderer reports audio finished playing — dequeue and check sentinel */
    handleAudioComplete(_messageId: string): void {
        this.audioPipeline.handleAudioComplete();
    }

    // ---- Voxta message handling ----

    private handleVoxtaMessage(message: ServerMessage): void {
        dispatchVoxtaMessage(message, {
            // State accessors
            getVoxta: () => this.voxta,
            getVoxtaUrl: () => this.voxtaUrl,
            getVoxtaApiKey: () => this.voxtaApiKey,
            getAssistantName: () => this.assistantName,
            getSettings: () => this.settings,
            isReplying: () => this.isReplying,
            getMcBot: () => this.mcBot?.bot ?? null,
            getNames: () => this.names,
            getFollowingPlayer: () => this.followingPlayer,

            // State mutators
            setAssistantName: (name) => { this.assistantName = name; },
            setVoxtaUserName: (name) => { this.voxtaUserName = name; },
            setDefaultAssistantId: (id) => { this.defaultAssistantId = id; },
            setCharacters: (chars) => { this.characters = chars; },
            setCurrentReply: (text) => { this.currentReply = text; },
            appendCurrentReply: (text) => { this.currentReply += text; },
            getCurrentReply: () => this.currentReply,
            setIsReplying: (value) => { this.isReplying = value; },
            setFollowingPlayer: (player) => { this.followingPlayer = player; },

            // Actions
            addChat: (type, sender, text) => this.addChat(type, sender, text),
            updateStatus: (patch) => this.updateStatus(patch),
            flushPendingNotes: () => this.flushPendingNotes(),
            queueNote: (text) => this.queueNote(text),
            emit: (event, ...args) => this.emit(event as BotEngineEvent, ...args),
            mcChatEcho: (text) => {
                if (this.mcBot && this.settings.enableBotChatEcho) {
                    const maxLen = 250;
                    for (let i = 0; i < text.length; i += maxLen) {
                        this.mcBot.bot.chat(text.substring(i, i + maxLen));
                    }
                }
            },

            // Audio pipeline
            audioPipeline: this.audioPipeline,
        });
    }
}
