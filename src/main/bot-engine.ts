import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, isActionBusy, setCurrentActivity } from '../bot/minecraft/actions';
import { McEventBridge } from '../bot/minecraft/events';
import { NameRegistry } from '../bot/name-registry';
import { VoxtaClient } from '../bot/voxta/client';
import type { ServerMessage, ServerActionMessage, ServerWelcomeMessage, ServerReplyChunkMessage, ServerVisionCaptureRequestMessage, ServerRecordingRequestMessage } from '../bot/voxta/types';
import { handleVisionCaptureRequest } from './vision-capture';
import type { VoxtaConnectConfig, VoxtaInfo, BotConfig, BotStatus, ChatMessage, ActionToggle, CharacterInfo, ChatListItem, ToastMessage, ToastType, McSettings, AudioChunk, AudioPlaybackEvent, RecordingStartEvent } from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';
import type { CompanionConfig } from '../bot/config';
import type { MinecraftBot } from '../bot/minecraft/bot';
import type { ScenarioAction } from '../bot/voxta/types';

// Centralized version constant
const CLIENT_NAME = 'Voxta.Minecraft';
const CLIENT_VERSION = '0.2.0';

type BotEngineEvent = 'status-changed' | 'chat-message' | 'clear-chat' | 'inspector-update' | 'action-triggered' | 'toast' | 'play-audio' | 'stop-audio' | 'recording-start' | 'recording-stop';

export class BotEngine extends EventEmitter {
    private mcBot: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private eventBridge: McEventBridge | null = null;
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
    private voxtaUrl: string | null = null;
    private voxtaApiKey: string | null = null;
    private settings: McSettings = { ...DEFAULT_SETTINGS };
    private isReplying = false;
    private pendingNotes: string[] = [];
    private followingPlayer: string | null = null; // Track who we're following to resume after tasks
    private recentEvents: string[] = []; // Events injected into context on next perception tick
    private toastCounter = 0;

    private audioDownloadChain: Promise<void> = Promise.resolve(); // Ensures audio chunks emit in order
    private audioEpoch = 0; // Bumped on interrupt — stale downloads are discarded

    // Sentinel-based ack queue (matches Voxta Talk's AudioPlayback.complete() pattern).
    // When replyEnd arrives, ackCallback is set. When all pending chunks complete
    // (or on interrupt), the callback fires speechPlaybackComplete.
    private ackPendingChunks = 0;
    private ackCallback: (() => void) | null = null;

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
        // Build a comprehensive string to search — AggregateError has empty message
        // but stores error codes in .code and nested .errors[] array
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
        // Keep only the latest 10 events
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
            this.toast('success', `Bot "${config.mc.username}" joined the Minecraft server!`);
        } catch (err) {
            const message = this.humanizeError(err, 'Minecraft connection');
            this.updateStatus({ mc: 'error' });
            this.addChat('system', 'System', `MC connection failed: ${message}`);
            this.toast('error', message);
            return;
        }

        // ---- 2. Start chat with selected character ----
        const bot = this.mcBot.bot;
        const character = this.characters.find((c) => c.id === uiConfig.characterId);
        this.assistantName = character?.name ?? 'AI';

        // Auto-detect the player's actual MC username from the server
        // The UI field may contain the Voxta name (e.g., "Lapiro") but the real
        // MC username could be different (e.g., "Emptyngton")
        const botUsername = config.mc.username;
        const onlinePlayers = Object.keys(bot.players).filter(
            (name) => name !== botUsername,
        );

        if (onlinePlayers.length === 1) {
            // Only one other player — that's the user
            this.playerMcUsername = onlinePlayers[0];
            this.addChat('system', 'System', `Detected player: ${this.playerMcUsername}`);
        } else if (onlinePlayers.length > 1) {
            // Multiple players — use the UI-provided name as a hint to find the right one
            const uiName = uiConfig.playerMcUsername;
            const match = onlinePlayers.find((p) => p.toLowerCase() === uiName.toLowerCase());
            this.playerMcUsername = match ?? onlinePlayers[0];
            this.addChat('system', 'System', `Multiple players online, using: ${this.playerMcUsername}`);
        }
        // else: no other players, keep the UI value as fallback

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

                // Append recent events to context
                if (this.recentEvents.length > 0) {
                    contextStrings.push('Recent events: ' + this.recentEvents.join(' | '));
                }

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
                    // Clear events after they've been sent to context
                    this.recentEvents = [];
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
                try {
                    const result = await executeAction(botInstance, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names);
                    this.addChat('system', 'System', `${botName}: ${result}`);
                    // Resume following if we were following before
                    if (this.followingPlayer && this.mcBot) {
                        const resumeResult = await executeAction(
                            this.mcBot.bot, 'mc_follow_player',
                            [{ name: 'player_name', value: this.followingPlayer }],
                            this.names,
                        );
                        console.log(`[Bot] Resumed following after defense: ${resumeResult}`);
                    }
                } catch {
                    // Defense failed, continue
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

        this.assistantId = null;
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
        console.log(`[Msg] sendMessage - "${text}"`);

        const name = this.voxtaUserName ?? 'You';
        this.addChat('player', `${name} (text)`, text);
        await this.voxta.sendMessage(text);
    }



    /** Renderer reports audio started playing — relay to server */
    handleAudioStarted(event: AudioPlaybackEvent): void {
        void this.voxta?.speechPlaybackStart(
            event.messageId, event.startIndex, event.endIndex, event.duration, event.isNarration,
        );
    }

    /** Renderer reports audio finished playing — dequeue and check sentinel */
    handleAudioComplete(_messageId: string): void {
        if (this.ackPendingChunks > 0) this.ackPendingChunks--;
        this.tryFireAck();
    }

    /** Fire sentinel callback if all chunks are done (or queue is empty) */
    private tryFireAck(): void {
        if (this.ackPendingChunks === 0 && this.ackCallback) {
            const cb = this.ackCallback;
            this.ackCallback = null;
            cb();
        }
    }

    /** Immediately fire sentinel (interrupt/cancel) — like Voxta Talk's stop() */
    private fireAckNow(): void {
        this.ackPendingChunks = 0;
        this.tryFireAck();
    }

    private handleVoxtaMessage(message: ServerMessage): void {
        // Trace ALL incoming messages for debugging
        const msgType = message.$type;
        if (msgType !== 'replyChunk' && msgType !== 'speechRecognitionPartial') {
            console.log(`[Msg] << ${msgType}`);
        }
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
            case 'chatStarting': {
                // New chat starting — clear old messages from the UI
                this.emit('clear-chat');
                break;
            }
            case 'chatStarted': {
                // Load old chat messages when continuing an existing chat.
                // The server sends the full history in chatStarted.messages[].
                const started = message as {
                    messages?: Array<{
                        senderId: string;
                        role: string;
                        text: string;
                        name?: string;
                    }>;
                    characters?: Array<{ id: string; name: string }>;
                };
                const characters = started.characters ?? this.characters;
                if (started.messages && started.messages.length > 0) {
                    for (const m of started.messages) {
                        if (!m.text?.trim()) continue;
                        const role = m.role; // 'User' | 'Assistant' | 'System' | 'Note'
                        if (role === 'User') {
                            const name = m.name ?? this.voxtaUserName ?? 'You';
                            this.addChat('player', name, m.text);
                        } else if (role === 'Assistant') {
                            const char = characters.find((c) => c.id === m.senderId);
                            this.addChat('ai', char?.name ?? this.assistantName ?? 'AI', m.text);
                        }
                        // Skip System/Note messages — they're internal context
                    }
                    console.log(`[Msg] chatStarted - loaded ${started.messages.length} old messages`);
                }
                break;
            }
            case 'replyChunk': {
                const chunk = message as ServerReplyChunkMessage;
                this.currentReply += chunk.text;
                // DEBUG: trace audio URL presence
                console.log(`[Msg] replyChunk - text: "${chunk.text.substring(0, 40)}...", audioUrl: ${chunk.audioUrl ? chunk.audioUrl.substring(0, 60) : '(none)'}`);
                // Forward audio URL to renderer for playback (same as Voxta Talk)
                if (chunk.audioUrl) {
                    // audioUrl is relative (e.g. /api/tts/gens/...) — download in main process
                    // to avoid cross-origin issues (renderer is on a different port)
                    const baseUrl = (this.voxtaUrl ?? 'http://localhost:5384').replace(/\/hub\/?$/, '');
                    const fullUrl = chunk.audioUrl.startsWith('http') ? chunk.audioUrl : `${baseUrl}${chunk.audioUrl}`;
                    const headers: Record<string, string> = {};
                    if (this.voxtaApiKey) headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;

                    // Track chunk in the ack queue
                    this.ackPendingChunks++;

                    // Start download immediately (parallel) but emit in order via chain
                    const epoch = this.audioEpoch;
                    const downloadPromise = fetch(fullUrl, { headers })
                        .then((res) => {
                            if (!res.ok) throw new Error(`HTTP ${res.status}`);
                            return res.arrayBuffer();
                        });

                    this.audioDownloadChain = this.audioDownloadChain
                        .then(() => downloadPromise)
                        .then((buf) => {
                            // If audio was stopped since this chunk was queued, discard it
                            if (this.audioEpoch !== epoch) return;
                            const b64 = Buffer.from(buf).toString('base64');
                            const dataUrl = `data:audio/wav;base64,${b64}`;
                            const audioChunk: AudioChunk = {
                                url: dataUrl,
                                messageId: chunk.messageId,
                                startIndex: chunk.startIndex,
                                endIndex: chunk.endIndex,
                                isNarration: chunk.isNarration,
                            };
                            this.emit('play-audio', audioChunk);
                        })
                        .catch((err) => {
                            console.error(`[Audio] Failed to download ${fullUrl}:`, err);
                            // Ack so server flow doesn't hang
                            void this.voxta?.speechPlaybackStart(
                                chunk.messageId, chunk.startIndex, chunk.endIndex, 0, chunk.isNarration,
                            );
                        });
                } else {
                    // No audio URL — immediately ack playback (matches Voxta Talk)
                    void this.voxta?.speechPlaybackStart(
                        chunk.messageId, chunk.startIndex, chunk.endIndex, 0, chunk.isNarration,
                    );
                }
                break;
            }
            case 'replyStart': {
                // Reset the download chain for the new reply
                this.audioDownloadChain = Promise.resolve();
                break;
            }
            case 'replyGenerating':
                console.log('[Msg] replyGenerating - AI is generating a reply');
                this.isReplying = true;
                break;
            case 'replyEnd': {
                console.log(`[Msg] replyEnd - reply complete, text length: ${this.currentReply.trim().length}`);
                if (this.currentReply.trim()) {
                    const chatText = this.currentReply.trim();
                    this.addChat('ai', this.assistantName ?? 'AI', chatText);

                    // Speak in MC chat (only if enabled)
                    if (this.mcBot && this.settings.enableBotChatEcho) {
                        const maxLen = 250;
                        for (let i = 0; i < chatText.length; i += maxLen) {
                            this.mcBot.bot.chat(chatText.substring(i, i + maxLen));
                        }
                    }
                }
                this.currentReply = '';
                this.isReplying = false;
                this.flushPendingNotes();

                // Sentinel: set callback that fires when all pending chunks complete.
                // If no chunks are pending, tryFireAck fires it immediately.
                // (Matches Voxta Talk's markChunksComplete() pattern.)
                const endMsg = message as { messageId?: string; sessionId?: string };
                const endMsgId = endMsg.messageId;
                if (endMsgId && this.voxta?.sessionId) {
                    this.ackCallback = () => {
                        console.log(`[Msg] ack sentinel fired for ${endMsgId}`);
                        void this.voxta?.speechPlaybackComplete(endMsgId);
                    };
                    this.tryFireAck();
                }
                break;
            }
            case 'replyCancelled': {
                // Reply was interrupted (user spoke or typed while AI was talking).
                // Reset state so the chat doesn't get stuck.
                console.log(`[Msg] replyCancelled - reply aborted, had ${this.currentReply.length} chars buffered`);
                if (this.currentReply.trim()) {
                    // Show whatever partial text was received
                    this.addChat('ai', this.assistantName ?? 'AI', this.currentReply.trim());
                }
                this.currentReply = '';
                this.isReplying = false;
                this.flushPendingNotes();

                // Cancel = stop: fire sentinel immediately
                this.fireAckNow();
                break;
            }
            case 'action': {
                const action = message as ServerActionMessage;
                const actionName = action.value?.trim() ?? '';
                console.log(`[Msg] action - ${actionName}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`);

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
                    } else if (actionName === 'mc_stop' || actionName === 'mc_go_home' || actionName === 'mc_go_to') {
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
                            && actionName !== 'mc_go_home'
                            && actionName !== 'mc_go_to';
                        console.log(`[Bot] Action done: ${actionName}, followingPlayer: ${this.followingPlayer}, shouldResume: ${!!shouldResume}`);
                        if (actionName === 'mc_follow_player' && this.mcBot) {
                            console.log(`[Bot] Pathfinder goal after follow: ${!!this.mcBot.bot.pathfinder.goal}`);
                        }
                        if (shouldResume && this.mcBot) {
                            const resumeResult = await executeAction(
                                this.mcBot.bot, 'mc_follow_player',
                                [{ name: 'player_name', value: this.followingPlayer ?? '' }],
                                this.names,
                            );
                            console.log(`[Bot] Resumed following: ${resumeResult}`);
                        }

                        // Look up action metadata to decide if we should report the result
                        const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);
                        if (!this.settings.enableTelemetryActionResults) return;
                        if (actionDef?.isQuick) return;

                        // Send result as a note (not an event!) to prevent feedback loops.
                        // An event would trigger a new AI response → new action → new result → loop.
                        this.queueNote(`${botName}: ${result}`);
                    });
                }
                break;
            }
            case 'interruptSpeech': {
                // Server says stop playback — kill renderer audio and cancel pending downloads
                console.log('[Msg] interruptSpeech - stopping audio playback');
                this.audioEpoch++;
                this.emit('stop-audio');
                break;
            }
            case 'chatFlow': {
                const state = (message as { state?: string }).state;
                console.log(`[Msg] chatFlow - state: ${state}`);
                break;
            }
            case 'speechRecognitionStart': {
                // User started speaking — stop local audio playback immediately.
                // NOTE: Do NOT send interrupt() to the server! The server already detects
                // speech via its own STT and interrupts the reply automatically.
                // Sending a duplicate interrupt jams the server's foreground command queue.
                console.log('[Msg] speechRecognitionStart - stopping local audio');
                this.audioEpoch++;
                this.emit('stop-audio');
                // Stop = fire sentinel immediately (matches Voxta Talk's AudioPlayback.stop())
                this.fireAckNow();
                break;
            }
            case 'speechRecognitionEnd': {
                // Send immediately — matches Voxta Talk. The server handles
                // ordering internally via its command queue.
                const text = (message as { text?: string }).text;
                console.log(`[Msg] speechRecognitionEnd - "${text ?? '(empty)'}"`);
                if (text) {
                    const playerName = this.voxtaUserName ?? 'You';
                    this.addChat('player', `${playerName} (voice)`, text);
                    void this.voxta?.sendMessage(text);
                }
                break;
            }
            case 'visionCaptureRequest': {
                if (this.settings.visionMode === 'off') {
                    console.log('[Vision] Capture request received but vision is disabled in settings');
                    break;
                }
                const visionReq = message as ServerVisionCaptureRequestMessage;
                const baseUrl = (this.voxtaUrl ?? 'http://localhost:5384/hub').replace(/\/hub\/?$/, '');
                console.log(`[Vision] Received capture request: ${visionReq.visionCaptureRequestId} (source: ${visionReq.source})`);
                void handleVisionCaptureRequest(visionReq, baseUrl, this.voxtaApiKey, this.settings.visionMode);
                break;
            }
            case 'recordingRequest': {
                const req = message as ServerRecordingRequestMessage;
                const baseUrl = (this.voxtaUrl ?? 'http://localhost:5384/hub').replace(/\/hub\/?$/, '');
                if (req.enabled) {
                    console.log('[Recording] Server requested recording START');
                    const event: RecordingStartEvent = {
                        sessionId: req.sessionId,
                        voxtaBaseUrl: baseUrl,
                        voxtaApiKey: this.voxtaApiKey,
                    };
                    this.emit('recording-start', event);
                } else {
                    console.log('[Recording] Server requested recording STOP');
                    this.emit('recording-stop');
                }
                break;
            }
            case 'contextUpdated': {
                // Forward context + actions to the renderer for the inspector drawer
                const ctx = message as {
                    contexts?: Array<{ contextKey: string; name: string; text: string }>;
                    actions?: Array<{ name: string; description: string; layer?: string }>;
                };
                const inspectorData: import('../shared/ipc-types').InspectorData = {
                    contexts: (ctx.contexts ?? []).map((c) => ({ name: c.name, text: c.text })),
                    actions: (ctx.actions ?? []).map((a) => ({ name: a.name, description: a.description, layer: a.layer })),
                };
                this.emit('inspector-update', inspectorData);
                break;
            }
            default:
                break;
        }
    }
}
