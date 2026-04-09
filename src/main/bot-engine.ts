import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import { readWorldState, buildContextStrings, hasLineOfSight } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, initHomePosition, resumeFollowPlayer } from '../bot/minecraft/action-dispatcher';
import { loadCustomBlueprints } from '../bot/minecraft/blueprints/index.js';
import {
    isAutoDefending,
    isActionBusy,
    getCurrentCombatTarget,
    getBotMode,
    getGuardCenter,
    setAutoDefending,
} from '../bot/minecraft/actions/action-state';
import { findPlayerEntity } from '../bot/minecraft/actions/action-helpers';
import { dismountEntity } from '../bot/minecraft/actions/index';
import { McEventBridge, isHostileEntity } from '../bot/minecraft/events';
import { NameRegistry } from '../bot/name-registry';
import { VoxtaClient } from '../bot/voxta/client';
import type { ServerMessage } from '../bot/voxta/types';
import type {
    VoxtaConnectConfig,
    VoxtaInfo,
    BotConfig,
    BotStatus,
    ChatMessage,
    ActionToggle,
    CharacterInfo,
    ChatListItem,
    ScenarioInfo,
    ToastMessage,
    ToastType,
    McSettings,
    AudioPlaybackEvent,
} from '../shared/ipc-types';
import { DEFAULT_SETTINGS } from '../shared/ipc-types';
import type { CompanionConfig } from '../bot/config';
import type { MinecraftBot } from '../bot/minecraft/bot';
import type { ScenarioAction } from '../bot/voxta/types';
import { AudioPipeline } from './audio-pipeline';
import { dispatchVoxtaMessage } from './voxta-message-handler';
import { resetActionFired } from './action-orchestrator';

// Centralized version constant
const CLIENT_NAME = 'Voxta.Minecraft';
const CLIENT_VERSION = '0.2.0';

type BotEngineEvent =
    | 'status-changed'
    | 'chat-message'
    | 'clear-chat'
    | 'inspector-update'
    | 'action-triggered'
    | 'toast'
    | 'play-audio'
    | 'stop-audio'
    | 'recording-start'
    | 'recording-stop'
    | 'spatial-position';

export class BotEngine extends EventEmitter {
    private mcBot: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private followWatchdog: ReturnType<typeof setInterval> | null = null;
    private mountedSteeringLoop: ReturnType<typeof setInterval> | null = null;
    private autoDismounting = false;
    private modeScanLoop: ReturnType<typeof setInterval> | null = null;
    private spatialLoop: ReturnType<typeof setInterval> | null = null;
    private eventBridge: McEventBridge | null = null;
    private assistantName: string | null = null;
    private activeCharacterId: string | null = null;
    private activeScenarioId: string | null = null;
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
    private pendingEvents: string[] = [];
    private followingPlayer: string | null = null; // Track who we're following to resume after tasks
    private flushHuntBatch: (() => void) | null = null;
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
        let raw: string;
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
        // Version mismatch (Mineflayer reports server vs client version)
        const versionMatch = raw.match(/server is version ([\d.]+)/i);
        if (versionMatch) {
            return `Version mismatch — the server runs ${versionMatch[1]}. Set "Game Version" to ${versionMatch[1]} and try again.`;
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
        const timing =
            this.settings.actionInferenceTiming === 'user'
                ? ('AfterUserMessage' as const)
                : ('AfterAssistantMessage' as const);
        return MINECRAFT_ACTIONS.filter((a) => this.actionToggles.get(a.name) !== false).map((a) => ({ ...a, timing }));
    }

    private pushActionsToVoxta(): void {
        if (!this.voxta?.sessionId) return;
        void this.voxta.updateContext(
            [
                {
                    text: 'The user is playing Minecraft. You are their AI companion bot inside the game world. You can see the world around you and perform actions.',
                },
            ],
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
        console.log(`[Bot >>] flushing ${this.pendingNotes.length} queued note(s)`);
        for (const note of this.pendingNotes) {
            console.log(`[Bot >>] note (flushed): "${note.substring(0, 80)}"`);
            void this.voxta.sendNote(note);
        }
        this.pendingNotes = [];
    }

    /** Flush queued events — triggers voiced AI replies for action results */
    private flushPendingEvents(): void {
        if (!this.voxta || this.pendingEvents.length === 0) return;
        // Only send the most recent event to avoid spamming multiple replies
        const event = this.pendingEvents[this.pendingEvents.length - 1];
        console.log(`[Bot >>] event (deferred): "${event.substring(0, 80)}"`);
        void this.voxta.sendEvent(event);
        this.pendingEvents = [];
    }

    private addChat(type: ChatMessage['type'], sender: string, text: string, badge?: string): void {
        const msg: ChatMessage = {
            id: `msg-${++this.messageCounter}`,
            timestamp: Date.now(),
            type,
            sender,
            text,
            badge,
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

        this.voxta.onReconnecting(() => {
            this.updateStatus({ voxta: 'connecting' });
            this.addChat('system', 'System', 'Voxta connection lost — reconnecting...');
            this.toast('warning', 'Voxta connection lost — reconnecting...');
        });

        this.voxta.onReconnected(() => {
            // Session is gone after server restart — stop sending stale context updates
            if (this.perceptionLoop) {
                clearInterval(this.perceptionLoop);
                this.perceptionLoop = null;
            }
            if (this.followWatchdog) {
                clearInterval(this.followWatchdog);
                this.followWatchdog = null;
            }
            if (this.mountedSteeringLoop) {
                clearInterval(this.mountedSteeringLoop);
                this.mountedSteeringLoop = null;
            }
            if (this.modeScanLoop) {
                clearInterval(this.modeScanLoop);
                this.modeScanLoop = null;
            }
            if (this.spatialLoop) {
                clearInterval(this.spatialLoop);
                this.spatialLoop = null;
            }
            this.emit('stop-audio');

            // Auto-resume the chat if we had an active session
            if (this.activeCharacterId && this.mcBot) {
                this.addChat('system', 'System', 'Voxta reconnected — resuming chat...');
                this.toast('info', 'Reconnected to Voxta — resuming chat...');
                void this.autoResumeChat();
            } else {
                this.updateStatus({
                    voxta: 'connected',
                    sessionId: null,
                    assistantName: null,
                    currentAction: null,
                });
                this.addChat('system', 'System', 'Voxta reconnected — start a new chat to continue.');
                this.toast('warning', 'Reconnected to Voxta — start a new chat to continue.');
            }
        });

        this.voxta.onClose(() => {
            // Full teardown — server is gone
            if (this.perceptionLoop) {
                clearInterval(this.perceptionLoop);
                this.perceptionLoop = null;
            }
            if (this.followWatchdog) {
                clearInterval(this.followWatchdog);
                this.followWatchdog = null;
            }
            if (this.mountedSteeringLoop) {
                clearInterval(this.mountedSteeringLoop);
                this.mountedSteeringLoop = null;
            }
            if (this.modeScanLoop) {
                clearInterval(this.modeScanLoop);
                this.modeScanLoop = null;
            }
            this.emit('stop-audio');
            this.updateStatus({
                voxta: 'disconnected',
                mc: 'disconnected',
                sessionId: null,
                assistantName: null,
                currentAction: null,
                position: null,
                health: null,
                food: null,
            });
            this.voxta = null;
            this.addChat('system', 'System', 'Voxta server disconnected');
            this.toast('error', 'Voxta server disconnected — the server may have been shut down.');
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

            // Fetch characters from REST API (with MC config detection)
            await this.fetchCharacterDetails();

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

    // ---- Fetch character list with MC config detection ----

    private async fetchCharacterDetails(): Promise<void> {
        if (!this.voxtaUrl) return;
        const baseUrl = this.voxtaUrl.replace(/\/hub\/?$/, '');
        const headers: Record<string, string> = {};
        if (this.voxtaApiKey) {
            headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;
        }
        const res = await fetch(`${baseUrl}/api/characters/?assistant=true`, { headers });
        if (res.ok) {
            const data = (await res.json()) as { characters: Array<{ id: string; name: string }> };

            // Parallel-fetch full details to check for Minecraft Companion app config
            const detailed = await Promise.all(
                data.characters.map(async (c) => {
                    try {
                        const detailRes = await fetch(`${baseUrl}/api/characters/${c.id}`, { headers });
                        if (detailRes.ok) {
                            const detail = (await detailRes.json()) as {
                                appConfiguration?: Record<string, Record<string, string>>;
                            };
                            const mcConfig = detail.appConfiguration?.[CLIENT_NAME];
                            const enabledValue = mcConfig?.['enabled']?.toLowerCase();
                            const hasMc = enabledValue === 'true' || (mcConfig?.['skin'] != null && mcConfig['skin'] !== '');
                            return { id: c.id, name: c.name, hasMcConfig: hasMc };
                        }
                    } catch {
                        // Ignore individual fetch failures
                    }
                    return { id: c.id, name: c.name, hasMcConfig: false };
                }),
            );
            this.characters = detailed;
        }
    }

    /** Re-fetch character details (MC config) without reconnecting */
    async refreshCharacters(): Promise<VoxtaInfo> {
        await this.fetchCharacterDetails();
        return {
            userName: this.voxtaUserName ?? 'Player',
            characters: this.characters,
            defaultAssistantId: this.defaultAssistantId,
        };
    }

    // ---- Load scenarios ----

    async loadScenarios(): Promise<ScenarioInfo[]> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        const baseUrl = this.voxtaUrl.replace(/\/hub\/?$/, '');
        const headers: Record<string, string> = {};
        if (this.voxtaApiKey) {
            headers['Authorization'] = `Bearer ${this.voxtaApiKey}`;
        }
        const res = await fetch(`${baseUrl}/api/scenarios`, { headers });
        if (!res.ok) {
            console.error(`[Voxta] Failed to load scenarios: ${res.status}`);
            return [];
        }
        const data = (await res.json()) as {
            scenarios: Array<{ id: string; name: string; client?: string }>;
        };
        return data.scenarios.map((s) => ({ id: s.id, name: s.name, client: s.client ?? null }));
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
        const data = (await res.json()) as {
            chats: Array<{
                id: string;
                title?: string;
                created: string;
                lastSession?: string;
                lastSessionTimestamp?: string;
                createdTimestamp?: string;
                favorite?: boolean;
                scenarioId?: string;
            }>;
        };
        return data.chats.map((c) => ({
            id: c.id,
            title: c.title ?? null,
            created: c.created,
            lastSession: c.lastSession ?? null,
            lastSessionTimestamp: c.lastSessionTimestamp ?? c.createdTimestamp ?? null,
            favorite: c.favorite ?? false,
            scenarioId: c.scenarioId ?? null,
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

        // Reset session state from any previous chat
        this.followingPlayer = null;
        this.isReplying = false;
        this.currentReply = '';
        this.pendingNotes = [];
        this.pendingEvents = [];

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
        this.activeScenarioId = uiConfig.scenarioId;

        // ---- 1. Connect Minecraft ----
        this.updateStatus({ mc: 'connecting' });
        this.addChat('system', 'System', `Connecting to MC ${config.mc.host}:${config.mc.port}...`);

        try {
            this.mcBot = createMinecraftBot(config);


            await this.mcBot.connect();
            initHomePosition(config.mc.host, config.mc.port, this.mcBot.bot);
            loadCustomBlueprints();
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

        // Auto-dismount: the MC server may remember the bot was riding from a previous session.
        // bot.vehicle isn't set yet at connect() — the set_passengers packet arrives async.
        // Retry up to 3 times — spawn-mounted entities need the server to fully load.
        this.autoDismounting = false;
        const autoDismount = async (): Promise<void> => {
            await new Promise((r) => setTimeout(r, 3000));
            const v = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
            console.log(`[MC] Auto-dismount check: vehicle=${v ? 'yes (id=' + v.id + ')' : 'no'}`);
            if (!v) return;

            this.autoDismounting = true;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
                if (!vehicle) {
                    console.log(`[MC] Auto-dismount: vehicle cleared (attempt ${attempt})`);
                    break;
                }
                console.log(`[MC] Auto-dismount attempt ${attempt}/3...`);
                try {
                    await dismountEntity(bot);
                    console.log('[MC] Auto-dismount complete');
                    break;
                } catch (err) {
                    console.log(`[MC] Auto-dismount attempt ${attempt} failed:`, err);
                    await new Promise((r) => setTimeout(r, 1000));
                }
            }
            this.autoDismounting = false;
        };
        void autoDismount();

        const character = this.characters.find((c) => c.id === uiConfig.characterId);
        this.assistantName = character?.name ?? 'AI';
        this.activeCharacterId = uiConfig.characterId;

        // Auto-detect the player's actual MC username from the server
        const botUsername = config.mc.username;
        const onlinePlayers = Object.keys(bot.players).filter((name) => name !== botUsername);

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

        // Read initial world state BEFORE starting chat — the server processes
        // context from the startChat message before generating the greeting
        let initialContextStrings: string[] = [];
        try {
            const initialState = readWorldState(bot, config.perception.entityRange);
            initialContextStrings = buildContextStrings(initialState, this.names, this.assistantName);
            this.updateStatus({
                position: initialState.position
                    ? {
                          x: Math.round(initialState.position.x),
                          y: Math.round(initialState.position.y),
                          z: Math.round(initialState.position.z),
                      }
                    : null,
                health: initialState.health,
                food: initialState.food,
            });
        } catch (err) {
            // Perception can fail during initial chunk loading
            console.error('[Perception] Initial context failed:', err);
        }

        await this.voxta.startChat(
            uiConfig.characterId,
            uiConfig.chatId ?? undefined,
            uiConfig.scenarioId ?? undefined,
            {
                contextKey: 'minecraft',
                contexts: initialContextStrings.map((text) => ({ text })),
                actions: this.getEnabledActions(),
            },
        );

        const chatStart = Date.now();
        while (!this.voxta.sessionId && Date.now() - chatStart < 15000) {
            await new Promise((r) => setTimeout(r, 200));
        }

        this.updateStatus({
            sessionId: this.voxta.sessionId,
            assistantName: this.assistantName,
        });

        this.addChat('system', 'System', `Chat started with ${this.assistantName}`);

        // ---- Perception loop ----
        let lastContextHash = initialContextStrings.join('|');

        this.perceptionLoop = setInterval(() => {
            if (!this.voxta?.sessionId) return;
            try {
                const state = readWorldState(bot, config.perception.entityRange);
                const contextStrings = buildContextStrings(state, this.names, this.assistantName);

                const contextHash = contextStrings.join('|');

                // Only update position if it's valid (perception returns 0,0,0 when bot pos is NaN)
                const posValid = state.position.x !== 0 || state.position.y !== 0 || state.position.z !== 0;
                this.updateStatus({
                    ...(posValid
                        ? {
                              position: {
                                  x: Math.round(state.position.x),
                                  y: Math.round(state.position.y),
                                  z: Math.round(state.position.z),
                              },
                          }
                        : {}),
                    health: state.health,
                    food: state.food,
                });

                if (contextHash !== lastContextHash) {
                    lastContextHash = contextHash;
                    void this.voxta.updateContext(contextStrings.map((text) => ({ text })));
                }
            } catch (err) {
                // Perception can fail during respawn/chunk loading
                console.error('[Perception] Context update failed:', err);
            }
        }, config.perception.intervalMs);

        // ---- Spatial audio position loop (fast — 100ms for responsive audio) ----
        this.spatialLoop = setInterval(() => {
            if (!this.playerMcUsername) return;
            try {
                // Use vehicle position when mounted — entity position is stale for passengers
                const botVehicle = (bot as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
                const botPos = botVehicle ? botVehicle.position : bot.entity?.position;
                const playerEntity = bot.players[this.playerMcUsername]?.entity;
                if (botPos && playerEntity) {
                    const playerVehicle = (playerEntity as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
                    const pPos = playerVehicle ? playerVehicle.position : playerEntity.position;
                    this.emit('spatial-position', {
                        botX: botPos.x,
                        botY: botPos.y,
                        botZ: botPos.z,
                        playerX: pPos.x,
                        playerY: pPos.y,
                        playerZ: pPos.z,
                        playerYaw: playerEntity.yaw,
                    });
                } else if (botPos) {
                    // Player out of entity tracking range — signal max distance
                    this.emit('spatial-position', {
                        botX: botPos.x,
                        botY: botPos.y,
                        botZ: botPos.z,
                        playerX: botPos.x + 9999,
                        playerY: botPos.y,
                        playerZ: botPos.z,
                        playerYaw: 0,
                    });
                }
            } catch {
                // Entity may not exist yet
            }
        }, 100);

        // ---- Mounted steering loop ----
        // Horse movement is client-side in MC: the client sends vehicle_move packets
        // with the computed position. player_input tells the server input state, but
        // the actual movement comes from vehicle_move (x, y, z, yaw, pitch, onGround).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcClient = (bot as any)._client;
        let lastSteerLog = 0;
        this.mountedSteeringLoop = setInterval(() => {
            if (!this.mcBot || !this.followingPlayer) return;
            if (isActionBusy() || this.autoDismounting) return; // Don't steer during dismount
            const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
            if (!vehicle) return;

            // Detect vehicle type — only steer horses, skip boats (different physics)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vehicleEntity = (vehicle as any);
            const vehicleName: string = (vehicleEntity.displayName ?? vehicleEntity.name ?? '').toLowerCase();
            const isBoat = vehicleName.includes('boat');
            if (isBoat) return; // Boat steering not yet implemented — let pathfinder handle it

            const player = findPlayerEntity(bot, this.followingPlayer, this.names);
            if (!player) return;
            // When the PLAYER is mounted, their position is stale — use their vehicle's position
            const playerVehicle = (player as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
            const targetPos = playerVehicle ? playerVehicle.position : player.position;
            // Use vehicle position — bot.entity.position is stale while mounted
            const vPos = vehicleEntity.position;
            if (!vPos) return;
            const dist = vPos.distanceTo(targetPos);
            if (dist < 5) {
                mcClient.write('player_input', {
                    inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false },
                });
                return;
            }

            // Calculate yaw toward player (from vehicle position)
            const dx = targetPos.x - vPos.x;
            const dz = targetPos.z - vPos.z;
            const yaw = -Math.atan2(dx, dz); // radians, MC convention
            const yawDeg = yaw * (180 / Math.PI);

            // Horse speed: attribute * 43.17 = blocks/sec (vanilla MC formula)
            let speedAttr = 0.225;
            if (vehicleEntity.attributes?.['minecraft:generic.movement_speed']) {
                speedAttr = vehicleEntity.attributes['minecraft:generic.movement_speed'].value ?? 0.225;
            } else if (vehicleEntity.attributes?.['generic.movementSpeed']) {
                speedAttr = vehicleEntity.attributes['generic.movementSpeed'].value ?? 0.225;
            }
            const blocksPerSec = speedAttr * 100; // ~22.5 b/s — keeps up with player's horse
            const moveStep = Math.min(blocksPerSec * 0.05, 2.0);

            // Helper: check if a position is impassable for a horse
            // A 1-block step-up is OK (horse can jump), but walls/trees blocking
            // headroom above the ground are impassable.
            const Vec3 = require('vec3');
            const isBlocked = (x: number, z: number, baseY: number): boolean => {
                try {
                    const floorY = Math.floor(baseY);
                    // Find ground level at destination
                    let groundLevel = floorY - 1; // default: assume same ground
                    for (let y = floorY + 2; y >= floorY - 3; y--) {
                        const b = bot.blockAt(new Vec3(x, y, z));
                        if (b && b.boundingBox === 'block') {
                            groundLevel = y;
                            break;
                        }
                    }
                    const stepUp = (groundLevel + 1) - baseY;
                    // Can't climb more than 1.5 blocks even with a jump
                    if (stepUp > 1.5) return true;
                    // Check headroom above ground (horse + rider = 2.5 blocks)
                    const standY = groundLevel + 1;
                    for (let dy = 0; dy <= 2; dy++) {
                        const b = bot.blockAt(new Vec3(x, standY + dy, z));
                        if (b && b.boundingBox === 'block') return true;
                    }
                } catch { /* world not loaded */ }
                return false;
            };

            // Try straight ahead, then ±45°, then ±90° to steer around obstacles
            let moveYaw = yaw;
            let moveYawDeg = yawDeg;
            const offsets = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
            let foundClear = false;
            for (const offset of offsets) {
                const tryYaw = yaw + offset;
                const tryX = vPos.x + (-Math.sin(tryYaw) * moveStep);
                const tryZ = vPos.z + (Math.cos(tryYaw) * moveStep);
                if (!isBlocked(tryX, tryZ, vPos.y)) {
                    moveYaw = tryYaw;
                    moveYawDeg = moveYaw * (180 / Math.PI);
                    foundClear = true;
                    break;
                }
            }

            if (!foundClear) {
                // All directions blocked — just face player and wait
                mcClient.write('look', {
                    yaw: yawDeg, pitch: 0,
                    flags: { onGround: true, hasHorizontalCollision: false },
                });
                return;
            }

            const forwardX = -Math.sin(moveYaw) * moveStep;
            const forwardZ = Math.cos(moveYaw) * moveStep;
            const newX = vPos.x + forwardX;
            const newZ = vPos.z + forwardZ;

            // Find ground height — detect step-ups for jumping
            let newY = vPos.y;
            let shouldJump = false;
            try {
                const searchY = Math.floor(vPos.y);
                for (let y = searchY + 2; y >= searchY - 4; y--) {
                    const b = bot.blockAt(new Vec3(newX, y, newZ));
                    if (b && b.boundingBox === 'block') {
                        const groundY = y + 1;
                        const yDiff = groundY - vPos.y;
                        if (yDiff >= 0.5 && yDiff <= 1.5) {
                            // 1-block step-up — jump!
                            shouldJump = true;
                            newY = groundY;
                        } else {
                            // Smooth transition for gentle slopes / descents
                            newY = vPos.y + Math.max(-0.5, Math.min(0.5, yDiff));
                        }
                        break;
                    }
                }
            } catch {
                // World data not loaded — keep current Y
            }

            // Send rider look direction (horse faces where rider looks)
            mcClient.write('look', {
                yaw: moveYawDeg,
                pitch: 0,
                flags: { onGround: true, hasHorizontalCollision: false },
            });

            // Tell server forward + jump if stepping up a ledge
            mcClient.write('player_input', {
                inputs: { forward: true, backward: false, left: false, right: false, jump: shouldJump, shift: false, sprint: false },
            });

            // Send vehicle_move — the proper packet for moving a ridden entity
            mcClient.write('vehicle_move', {
                x: newX,
                y: newY,
                z: newZ,
                yaw: moveYawDeg,
                pitch: 0,
                onGround: !shouldJump,
            });

            const now = Date.now();
            if (now - lastSteerLog > 2000) {
                lastSteerLog = now;
                console.log(`[MC Steer] Riding: dist=${dist.toFixed(1)}, speed=${blocksPerSec.toFixed(1)}b/s, step=${moveStep.toFixed(2)}, y=${newY.toFixed(1)}, pos=(${newX.toFixed(1)}, ${newZ.toFixed(1)})`);
            }
        }, 50);

        // ---- Follow watchdog ----
        // The pathfinder can silently stop computing paths after combat/death/respawn
        // even though the goal is still set. This watchdog uses escalating strategies:
        //   1. Re-set the pathfinder goal
        //   2. Fully reset movements + goal
        //   3. Bypass pathfinder — manually walk toward the player
        let followWatchdogLastPos = bot.entity.position.clone();
        let followStuckCount = 0;
        // Track which vehicle the followed player is riding — set_passengers fires instantly
        let playerMountedVehicleId: number | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mcClient.on('set_passengers', (packet: any) => {
            if (!this.followingPlayer) return;
            const player = findPlayerEntity(bot, this.followingPlayer, this.names);
            if (!player) return;
            const passengerIds: number[] = packet.passengers ?? [];
            const vehicleEntityId: number = packet.entityId;
            const vEntity = bot.entities[vehicleEntityId];
            const vName = vEntity?.displayName ?? vEntity?.name ?? 'unknown';
            if (passengerIds.includes(player.id)) {
                // Player mounted this vehicle
                if (playerMountedVehicleId !== vehicleEntityId) {
                    playerMountedVehicleId = vehicleEntityId;
                    console.log(`[Bot] Player mounted ${vName} (id=${vehicleEntityId})`);
                    if (!isActionBusy()) {
                        resumeFollowPlayer(bot, this.followingPlayer, this.names);
                    }
                }
            } else if (playerMountedVehicleId === vehicleEntityId) {
                // Player dismounted from this vehicle
                console.log(`[Bot] Player dismounted ${vName} (id=${vehicleEntityId})`);
                playerMountedVehicleId = null;
                // Mineflayer doesn't clear .vehicle for other players — do it manually
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (player as any).vehicle = null;
                if (!isActionBusy()) {
                    resumeFollowPlayer(bot, this.followingPlayer, this.names);
                }
            }
        });
        this.followWatchdog = setInterval(() => {
            if (!this.mcBot || !this.followingPlayer) return;
            if (getBotMode() === 'guard') return; // Don't follow in guard mode
            if (isAutoDefending()) { console.log('[Bot] Watchdog skip: auto-defending'); return; }
            if (isActionBusy()) { console.log('[Bot] Watchdog skip: action busy'); return; }

            // When the BOT is mounted, the steering loop handles movement — skip pathfinder
            const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
            if (vehicle) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vn = ((vehicle as any).displayName ?? (vehicle as any).name ?? 'vehicle').toLowerCase();
                console.log(`[Bot] Watchdog skip: bot is mounted (${vn})`);
                return;
            }

            const pos = bot.entity.position;
            if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

            const player = findPlayerEntity(bot, this.followingPlayer, this.names);
            if (!player) return;

            // Use the tracked vehicle ID (from set_passengers listener) for the target position
            const playerVehicleEntity = playerMountedVehicleId
                ? bot.entities[playerMountedVehicleId]
                : null;
            const targetPos = playerVehicleEntity ? playerVehicleEntity.position : player.position;

            const distToPlayer = pos.distanceTo(targetPos);
            const movedSinceLastCheck = pos.distanceTo(followWatchdogLastPos);
            followWatchdogLastPos = pos.clone();

            // If we're close enough to the player, reset counter
            if (distToPlayer < 5) {
                followStuckCount = 0;
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                return;
            }

            // If we moved more than 0.5 blocks since last check, pathfinder is working
            if (movedSinceLastCheck > 0.5) {
                followStuckCount = 0;
                return;
            }

            followStuckCount++;

            if (followStuckCount <= 1) {
                // Tier 1: Re-set the pathfinder goal
                console.log(
                    `[Bot] Follow watchdog: stuck ${distToPlayer.toFixed(1)} blocks from player, ` +
                    `moved ${movedSinceLastCheck.toFixed(2)} blocks — re-setting goal (tier 1)`,
                );
                resumeFollowPlayer(bot, this.followingPlayer, this.names);
            } else if (followStuckCount === 2) {
                // Tier 2: Full pathfinder reset — fresh movements + goal
                console.log(
                    `[Bot] Follow watchdog: still stuck — resetting pathfinder movements (tier 2)`,
                );
                const freshMovements = new (require('mineflayer-pathfinder').Movements)(bot);
                freshMovements.canDig = true;
                freshMovements.allow1by1towers = true;
                bot.pathfinder.setMovements(freshMovements);
                resumeFollowPlayer(bot, this.followingPlayer, this.names);
            } else {
                // Tier 3: Bypass pathfinder — look at player and walk forward
                console.log(
                    `[Bot] Follow watchdog: pathfinder failed — manual walking toward player (tier 3, ` +
                    `dist=${distToPlayer.toFixed(1)})`,
                );
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
                void bot.lookAt(targetPos.offset(0, 1.6, 0));
                bot.setControlState('forward', true);
                bot.setControlState('sprint', true);
            }
        }, 5000);

        // ---- Mode scan loop (aggro + hunt + guard/patrol) ----
        let patrolTarget: { x: number; z: number } | null = null;
        const aggroCooldowns: Record<string, number> = {};

        // Batch mode kills to save LLM context — instead of sending
        // "Defeated the slime" x10, send one "Defeated 10 slimes in aggro mode."
        const modeKillCounts: Record<string, number> = {};
        let modeBatchTimer: ReturnType<typeof setTimeout> | null = null;
        let modeBatchLabel = 'aggro'; // Tracks which mode the batch belongs to
        const flushModeBatch = (): void => {
            if (modeBatchTimer) { clearTimeout(modeBatchTimer); modeBatchTimer = null; }
            const entries = Object.entries(modeKillCounts).filter(([, count]) => count > 0);
            if (entries.length === 0) return;
            const botName = this.assistantName ?? 'Bot';
            const summary = entries.map(([mob, count]) => `${count} ${mob}${count > 1 ? 's' : ''}`).join(', ');
            const verb = modeBatchLabel === 'hunt' ? 'Hunted' : 'Defeated';
            this.queueNote(`${botName}: ${verb} ${summary} in ${modeBatchLabel} mode.`);
            console.log(`[Bot] ${modeBatchLabel} batch note: ${verb} ${summary}`);
            for (const key of Object.keys(modeKillCounts)) {
                modeKillCounts[key] = 0;
            }
        };
        this.flushHuntBatch = flushModeBatch;

        // Farm animals that the hunt mode will target
        const HUNTABLE_ANIMALS = ['pig', 'cow', 'mooshroom', 'sheep', 'chicken', 'rabbit'];
        let huntCooldownUntil = 0; // Post-kill cooldown to let the bot settle

        let patrolPauseUntil = 0;
        this.modeScanLoop = setInterval(() => {
            if (!this.mcBot) return;
            const mode = getBotMode();
            if (mode === 'passive') return;
            if (isAutoDefending() || isActionBusy()) return;
            // Don't seek new fights when critically wounded
            if (bot.health > 0 && bot.health <= 6) return;

            const pos = bot.entity.position;
            if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

            // ---- Aggro mode: attack nearest hostile while following player ----
            if (mode === 'aggro') {
                const player = this.followingPlayer
                    ? findPlayerEntity(bot, this.followingPlayer, this.names)
                    : null;

                // Mobs that split on death (slime → babies, magma_cube → babies).
                // After killing one we ignore that type for 5s to avoid chasing
                // tiny split babies that the attack action can't reliably hit.
                const SPLIT_MOBS = ['slime', 'magma_cube'];

                // Mobs classified as hostile but actually neutral — they only attack
                // when provoked. Don't auto-target them; the user can still say "attack the enderman".
                const NEUTRAL_HOSTILE = ['enderman', 'spider', 'cave_spider', 'zombified_piglin'];

                let nearestHostile: (typeof bot.entities)[number] | undefined;
                let nearestDist = Infinity;
                for (const e of Object.values(bot.entities)) {
                    if (e === bot.entity || !isHostileEntity(e)) continue;
                    const name = e.name ?? '';
                    if (NEUTRAL_HOSTILE.includes(name)) continue;
                    // Skip split-mob babies during cooldown
                    if (SPLIT_MOBS.includes(name) && aggroCooldowns[name] && Date.now() < aggroCooldowns[name]) continue;
                    const d = e.position.distanceTo(pos);
                    // Within 16 blocks of bot AND within 20 blocks of player (leash)
                    if (d < 16 && d < nearestDist) {
                        if (player && e.position.distanceTo(player.position) > 20) continue;
                        // Skip mobs behind solid walls (e.g. in adjacent cave systems)
                        if (!hasLineOfSight(bot, e)) continue;
                        nearestHostile = e;
                        nearestDist = d;
                    }
                }

                if (nearestHostile && !getCurrentCombatTarget()) {
                    const mobName = nearestHostile.name ?? 'unknown';
                    console.log(`[Bot] Aggro mode: attacking ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                    setAutoDefending(true);
                    this.addChat('action', 'Action', `${this.assistantName ?? 'Bot'} fighting ${mobName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names)
                        .then((result) => {
                            console.log(`[Bot] Aggro attack result: ${result}`);

                            // Only batch successful kills, send failures immediately
                            if (result.toLowerCase().includes('defeated')) {
                                this.addChat('note', 'Note', `${this.assistantName ?? 'Bot'}: ${result}`);
                                modeBatchLabel = 'aggro';
                                modeKillCounts[mobName] = (modeKillCounts[mobName] ?? 0) + 1;
                                // Reset batch timer — flush after 5s of no new kills
                                if (modeBatchTimer) clearTimeout(modeBatchTimer);
                                modeBatchTimer = setTimeout(flushModeBatch, 5000);
                            } else if (!result) {
                                // Empty = creeper explosion — environmental note, no bot attribution
                                this.addChat('note', 'Note', 'Creeper exploded nearby');
                                this.queueNote('Creeper exploded nearby');
                            } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
                                this.addChat('note', 'Note', `${this.assistantName ?? 'Bot'}: ${result}`);
                                this.queueNote(`${this.assistantName ?? 'Bot'}: ${result}`);
                            }

                            // Set cooldown for split mobs
                            if (SPLIT_MOBS.includes(mobName)) {
                                aggroCooldowns[mobName] = Date.now() + 5000;
                                console.log(`[Bot] Aggro: ${mobName} split cooldown set for 5s`);
                            }
                        })
                        .catch((err) => console.log(`[Bot] Aggro attack failed:`, err))
                        .finally(() => {
                            setAutoDefending(false);
                            console.log(`[Bot] Aggro: combat ended, scheduling follow resume in 2s`);
                            // Wait 2s before resuming follow — if another fight starts
                            // in that window, the scan will pick it up and this timer
                            // becomes irrelevant (the new fight sets its own goal).
                            setTimeout(() => {
                                const combatTarget = getCurrentCombatTarget();
                                const defending = isAutoDefending();
                                console.log(`[Bot] Aggro: follow resume check — following=${this.followingPlayer}, combatTarget=${combatTarget}, defending=${defending}`);
                                if (this.followingPlayer && !combatTarget && !defending) {
                                    void executeAction(
                                        bot,
                                        'mc_follow_player',
                                        [{ name: 'player_name', value: this.followingPlayer }],
                                        this.names,
                                    ).then((r) => console.log(`[Bot] Aggro: resumed following after kill: ${r}`));
                                } else {
                                    console.log(`[Bot] Aggro: skipped follow resume (busy or no player)`);
                                }
                            }, 2000);
                        });
                }
                return;
            }

            // ---- Hunt mode: attack nearest farm animal while following player ----
            if (mode === 'hunt') {
                // Post-kill cooldown — let the bot settle, pick up loot, and breathe
                if (Date.now() < huntCooldownUntil) return;

                const player = this.followingPlayer
                    ? findPlayerEntity(bot, this.followingPlayer, this.names)
                    : null;

                let nearestAnimal: (typeof bot.entities)[number] | undefined;
                let nearestDist = Infinity;
                for (const e of Object.values(bot.entities)) {
                    if (e === bot.entity) continue;
                    const name = e.name ?? '';
                    if (!HUNTABLE_ANIMALS.includes(name)) continue;
                    const d = e.position.distanceTo(pos);
                    // Within 12 blocks of bot AND within 20 blocks of player (leash)
                    if (d < 12 && d < nearestDist) {
                        if (player && e.position.distanceTo(player.position) > 20) continue;
                        // Skip animals behind solid walls
                        if (!hasLineOfSight(bot, e)) continue;
                        nearestAnimal = e;
                        nearestDist = d;
                    }
                }

                if (nearestAnimal && !getCurrentCombatTarget()) {
                    const animalName = nearestAnimal.name ?? 'unknown';
                    console.log(`[Bot] Hunt mode: targeting ${animalName} (${nearestDist.toFixed(1)} blocks)`);
                    setAutoDefending(true);
                    this.addChat('action', 'Action', `${this.assistantName ?? 'Bot'} hunting ${animalName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: animalName }], this.names)
                        .then((result) => {
                            console.log(`[Bot] Hunt attack result: ${result}`);

                            if (result.toLowerCase().includes('defeated')) {
                                this.addChat('note', 'Note', `${this.assistantName ?? 'Bot'}: ${result}`);
                                modeBatchLabel = 'hunt';
                                modeKillCounts[animalName] = (modeKillCounts[animalName] ?? 0) + 1;
                                if (modeBatchTimer) clearTimeout(modeBatchTimer);
                                modeBatchTimer = setTimeout(flushModeBatch, 5000);
                            } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
                                this.addChat('note', 'Note', `${this.assistantName ?? 'Bot'}: ${result}`);
                                this.queueNote(`${this.assistantName ?? 'Bot'}: ${result}`);
                            }
                        })
                        .catch((err) => console.log(`[Bot] Hunt attack failed:`, err))
                        .finally(() => {
                            setAutoDefending(false);
                            // 1.5-second cooldown before hunting the next animal
                            huntCooldownUntil = Date.now() + 1500;
                            console.log(`[Bot] Hunt: kill ended, scheduling follow resume in 2s`);
                            setTimeout(() => {
                                const combatTarget = getCurrentCombatTarget();
                                const defending = isAutoDefending();
                                console.log(`[Bot] Hunt: follow resume check — following=${this.followingPlayer}, combatTarget=${combatTarget}, defending=${defending}`);
                                if (this.followingPlayer && !combatTarget && !defending) {
                                    void executeAction(
                                        bot,
                                        'mc_follow_player',
                                        [{ name: 'player_name', value: this.followingPlayer }],
                                        this.names,
                                    ).then((r) => console.log(`[Bot] Hunt: resumed following after kill: ${r}`));
                                } else {
                                    console.log(`[Bot] Hunt: skipped follow resume (busy or no player)`);
                                }
                            }, 2000);
                        });
                }
                return;
            }

            // ---- Guard mode: patrol area + attack hostiles ----
            if (mode === 'guard') {
                const center = getGuardCenter();
                if (!center) return;

                // Check for hostiles near guard center (skip neutral mobs like endermen)
                const GUARD_NEUTRAL = ['enderman', 'spider', 'cave_spider', 'zombified_piglin'];
                let nearestHostile: (typeof bot.entities)[number] | undefined;
                let nearestDist = Infinity;
                for (const e of Object.values(bot.entities)) {
                    if (e === bot.entity || !isHostileEntity(e)) continue;
                    const name = e.name ?? '';
                    if (GUARD_NEUTRAL.includes(name)) continue;
                    const d = e.position.distanceTo(pos);
                    if (d < 16 && d < nearestDist) {
                        // Skip mobs behind solid walls
                        if (!hasLineOfSight(bot, e)) continue;
                        nearestHostile = e;
                        nearestDist = d;
                    }
                }

                if (nearestHostile && !getCurrentCombatTarget()) {
                    const mobName = nearestHostile.name ?? 'unknown';
                    console.log(`[Bot] Guard mode: engaging ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                    patrolTarget = null;
                    setAutoDefending(true);
                    this.addChat('action', 'Action', `${this.assistantName ?? 'Bot'} defending area from ${mobName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names)
                        .then((result) => {
                            this.addChat('note', 'Note', `${this.assistantName ?? 'Bot'}: ${result}`);
                            this.queueNote(`${this.assistantName ?? 'Bot'}: ${result}`);
                            console.log(`[Bot] Guard attack result: ${result}`);
                        })
                        .catch((err) => console.log(`[Bot] Guard attack failed:`, err))
                        .finally(() => setAutoDefending(false));
                    return;
                }

                // Patrol: always pick a new random point on each tick after pause
                if (Date.now() < patrolPauseUntil) return;

                const distToCenter = Math.sqrt(
                    (pos.x - center.x) ** 2 + (pos.z - center.z) ** 2,
                );

                // Pick new patrol point within 8 blocks of center
                const angle = Math.random() * Math.PI * 2;
                const radius = 3 + Math.random() * 5; // 3-8 blocks
                patrolTarget = {
                    x: center.x + Math.cos(angle) * radius,
                    z: center.z + Math.sin(angle) * radius,
                };
                patrolPauseUntil = Date.now() + 3000 + Math.random() * 3000; // 3-6s between moves
                console.log(`[Bot] Patrol: walking to (${patrolTarget.x.toFixed(0)}, ${patrolTarget.z.toFixed(0)}) — ${distToCenter.toFixed(1)} from center`);

                // Walk to patrol point
                const { GoalNear } = require('mineflayer-pathfinder').goals;
                bot.pathfinder.setGoal(new GoalNear(patrolTarget.x, center.y, patrolTarget.z, 1));
            }
        }, 2000);

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
                        console.log(`[Bot >>] event: "${text.substring(0, 80)}"`);
                        void this.voxta.sendEvent(text);
                    }
                },
                onUrgentEvent: (text) => {
                    if (!this.voxta?.sessionId) return;
                    this.addChat('event', 'Event', text);
                    // Interrupt current speech and server reply
                    this.audioPipeline.interrupt();
                    this.audioPipeline.fireAckNow();
                    this.emit('stop-audio');
                    void this.voxta.interrupt();
                    this.isReplying = false;
                    this.currentReply = '';
                    // Send the urgent event immediately
                    console.log(`[Bot >>] event (urgent): "${text.substring(0, 80)}"`);
                    void this.voxta.sendEvent(text);
                },
                onPlayerChat: (text) => {
                    if (!this.voxta?.sessionId) return;
                    console.log(`[User >>] MC chat: "${text}"`);
                    resetActionFired();
                    this.flushHuntBatch?.();

                    if (this.isReplying) {
                        // Interrupt the current speech first, then send after server settles
                        console.log('[User >>] MC chat during speech — interrupting first');
                        this.audioPipeline.interrupt();
                        this.audioPipeline.fireAckNow();
                        this.isReplying = false;
                        this.currentReply = '';
                        this.pendingEvents = [];
                        // Give the server time to process the interrupt before sending
                        setTimeout(() => {
                            void this.voxta?.sendMessage(text);
                        }, 300);
                    } else {
                        void this.voxta.sendMessage(text);
                    }
                },
                getSettings: () => this.settings,
                getAssistantName: () => this.assistantName ?? 'Bot',
                isReplying: () => this.isReplying,
            },
            () => this.followingPlayer,
            async (botInstance, mobName) => {
                // Skip auto-defense while mounted — can't fight from horseback
                const vehicleCheck = (botInstance as unknown as { vehicle: { id: number } | null }).vehicle;
                if (vehicleCheck) {
                    console.log(`[Bot] Skipping auto-defense against ${mobName} — mounted on vehicle`);
                    return;
                }
                const botName = this.assistantName ?? 'Bot';
                console.log(`[Bot] Auto-defense started against ${mobName}, followingPlayer=${this.followingPlayer}`);
                try {
                    const result = await executeAction(
                        botInstance,
                        'mc_attack',
                        [{ name: 'entity_name', value: mobName }],
                        this.names,
                    );
                    // Don't send redundant notes — "Already fighting" is noise,
                    // "Stopped fighting" and "Died while fighting" are covered by the death event.
                    const isNoise = result.startsWith('Already fighting')
                        || result.startsWith('Stopped fighting')
                        || result.startsWith('Died while fighting');
                    if (!result) {
                        // Empty = creeper explosion — environmental note, no bot attribution
                        this.addChat('note', 'Note', 'Creeper exploded nearby');
                        this.queueNote('Creeper exploded nearby');
                    } else if (!isNoise) {
                        this.addChat('note', 'Note', `${botName}: ${result}`);
                        this.queueNote(`${botName}: ${result}`);
                    }
                    console.log(`[Bot] Auto-defense attack result: ${result}`);
                } catch (err) {
                    console.log(`[Bot] Auto-defense attack failed:`, err);
                } finally {
                    // Clear stale attacker so post-combat damage isn't misattributed
                    this.eventBridge?.clearLastAttacker();
                    console.log(
                        `[Bot] Auto-defense finished, followingPlayer=${this.followingPlayer}, mcBot=${!!this.mcBot}`,
                    );
                    // Don't resume follow if combat is still active — another mc_attack is
                    // running with GoalFollow(target). Overwriting it with GoalFollow(player)
                    // would cause the bot to stop fighting and just absorb arrows.
                    if (getCurrentCombatTarget()) {
                        console.log(`[Bot] Combat still active (${getCurrentCombatTarget()}), NOT overriding with follow`);
                    } else if (getBotMode() === 'guard') {
                        console.log(`[Bot] Guard mode — staying at post, not following`);
                    } else if (this.followingPlayer && this.mcBot) {
                        // Small delay: pathfinder.stop() in combat sets an internal
                        // "stopPathing" flag that takes one tick to clear. Without
                        // this delay, setGoal(null)+setGoal(follow) races with the
                        // async path reset and the bot appears stuck.
                        const playerToFollow = this.followingPlayer;
                        const mcBotRef = this.mcBot;
                        setTimeout(() => {
                            if (this.followingPlayer !== playerToFollow) return; // state changed
                            const resumeResult = resumeFollowPlayer(mcBotRef.bot, playerToFollow, this.names);
                            console.log(`[Bot] Resumed following after defense: ${resumeResult}`);
                        }, 150);
                    } else {
                        console.log(
                            `[Bot] NOT resuming follow — followingPlayer=${this.followingPlayer}, mcBot=${!!this.mcBot}`,
                        );
                    }
                }
            },
        );

        // Auto-follow: companion should follow the player by default on spawn
        // Small delay to let pathfinder initialize after bot spawn
        if (this.playerMcUsername) {
            this.followingPlayer = this.playerMcUsername;
            const playerName = this.playerMcUsername;
            console.log(`[Bot] Auto-following ${playerName} on spawn`);
            setTimeout(() => {
                if (!this.mcBot) return;
                executeAction(
                    this.mcBot.bot,
                    'mc_follow_player',
                    [{ name: 'player_name', value: playerName }],
                    this.names,
                ).catch((err) => {
                    console.log(`[Bot] Auto-follow failed, retrying in 2s:`, err);
                    setTimeout(() => {
                        if (!this.mcBot || this.followingPlayer !== playerName) return;
                        void executeAction(
                            this.mcBot.bot,
                            'mc_follow_player',
                            [{ name: 'player_name', value: playerName }],
                            this.names,
                        );
                    }, 2000);
                });
            }, 1000);
        }
    }

    /** Auto-resume a chat session after Voxta reconnection */
    private async autoResumeChat(): Promise<void> {
        if (!this.voxta || !this.activeCharacterId || !this.mcBot) return;

        try {
            // Wait for re-authentication
            const authStart = Date.now();
            while (!this.voxta.authenticated && Date.now() - authStart < 10000) {
                await new Promise((r) => setTimeout(r, 200));
            }
            if (!this.voxta.authenticated) {
                this.toast('error', 'Failed to re-authenticate with Voxta.');
                return;
            }

            this.updateStatus({ voxta: 'connected' });
            await this.voxta.registerApp();

            // Build initial context from current world state
            const bot = this.mcBot.bot;
            let initialContextStrings: string[] = [];
            try {
                const state = readWorldState(bot, 32);
                initialContextStrings = buildContextStrings(state, this.names, this.assistantName);
            } catch {
                // Perception can fail
            }

            // Resume the same conversation (pass chatId to continue history)
            const lastChatId = this.voxta.chatId;
            console.log(`[Voxta] Auto-resuming chat: character=${this.activeCharacterId}, chatId=${lastChatId ?? 'new'}`);
            await this.voxta.startChat(
                this.activeCharacterId,
                lastChatId ?? undefined,
                undefined,
                {
                    contextKey: 'minecraft',
                    contexts: initialContextStrings.map((text) => ({ text })),
                    actions: this.getEnabledActions(),
                },
            );

            // Wait for session
            const chatStart = Date.now();
            while (!this.voxta.sessionId && Date.now() - chatStart < 15000) {
                await new Promise((r) => setTimeout(r, 200));
            }

            this.updateStatus({
                sessionId: this.voxta.sessionId,
                assistantName: this.assistantName,
                currentAction: null,
            });

            this.addChat('system', 'System', `Chat resumed with ${this.assistantName}`);
            this.toast('success', `Chat resumed with ${this.assistantName}!`);

            // Restart perception loop
            let lastContextHash = initialContextStrings.join('|');
            this.perceptionLoop = setInterval(() => {
                if (!this.voxta?.sessionId) return;
                try {
                    const state = readWorldState(bot, 32);
                    const contextStrings = buildContextStrings(state, this.names, this.assistantName);
                    const contextHash = contextStrings.join('|');

                    this.updateStatus({
                        position: state.position
                            ? {
                                  x: Math.round(state.position.x),
                                  y: Math.round(state.position.y),
                                  z: Math.round(state.position.z),
                              }
                            : null,
                        health: state.health,
                        food: state.food,
                    });

                    if (contextHash !== lastContextHash) {
                        lastContextHash = contextHash;
                        void this.voxta.updateContext(contextStrings.map((text) => ({ text })));
                    }
                } catch {
                    // Perception can fail during respawn/chunk loading
                }
            }, 3000);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.addChat('system', 'System', `Auto-resume failed: ${message}`);
            this.toast('error', `Failed to resume chat: ${message}`);
        }
    }

    /** Stop the current chat session + MC bot, but keep the Voxta connection alive */
    async stopSession(): Promise<void> {
        if (this.perceptionLoop) {
            clearInterval(this.perceptionLoop);
            this.perceptionLoop = null;
        }
        if (this.followWatchdog) {
            clearInterval(this.followWatchdog);
            this.followWatchdog = null;
        }
        if (this.mountedSteeringLoop) {
            clearInterval(this.mountedSteeringLoop);
            this.mountedSteeringLoop = null;
        }
        if (this.modeScanLoop) {
            clearInterval(this.modeScanLoop);
            this.modeScanLoop = null;
        }
        if (this.spatialLoop) {
            clearInterval(this.spatialLoop);
            this.spatialLoop = null;
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

        // End the Voxta chat session but keep the SignalR connection
        if (this.voxta?.sessionId) {
            try {
                await this.voxta.endSession();
            } catch {
                // Ignore — session may already be closed
            }
        }

        // Reset session-related state
        this.assistantName = null;
        this.activeCharacterId = null;
        this.currentReply = '';
        this.followingPlayer = null;
        this.isReplying = false;
        this.pendingNotes = [];
        this.pendingEvents = [];

        this.updateStatus({
            ...this.status,
            mc: 'disconnected',
            voxta: this.voxta ? 'connected' : 'disconnected',
            position: null,
            health: null,
            food: null,
            currentAction: null,
            assistantName: null,
            sessionId: null,
        });

        // Stop any playing audio immediately
        this.emit('stop-audio');

        this.addChat('system', 'System', 'Session ended');
    }

    async disconnect(): Promise<void> {
        await this.stopSession();

        if (this.voxta) {
            try {
                await this.voxta.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.voxta = null;
        }

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
        resetActionFired();
        this.flushHuntBatch?.();

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
            setAssistantName: (name) => {
                this.assistantName = name;
                this.updateStatus({ assistantName: name });
            },
            setVoxtaUserName: (name) => {
                this.voxtaUserName = name;
            },
            setDefaultAssistantId: (id) => {
                this.defaultAssistantId = id;
            },
            setCharacters: (chars) => {
                this.characters = chars;
            },
            setCurrentReply: (text) => {
                this.currentReply = text;
            },
            appendCurrentReply: (text) => {
                this.currentReply += text;
            },
            getCurrentReply: () => this.currentReply,
            setIsReplying: (value) => {
                this.isReplying = value;
            },
            setFollowingPlayer: (player) => {
                this.followingPlayer = player;
            },
            setSkinUrl: (url) => {
                this.mcBot?.setSkinUrl(url);
            },

            // Actions
            addChat: (type, sender, text, badge) => this.addChat(type, sender, text, badge),
            updateStatus: (patch) => this.updateStatus(patch),
            flushPendingNotes: () => this.flushPendingNotes(),
            flushPendingEvents: () => this.flushPendingEvents(),
            queueNote: (text) => this.queueNote(text),
            queueEvent: (text) => {
                if (this.isReplying) {
                    this.pendingEvents.push(text);
                } else {
                    console.log(`[Bot >>] event (immediate, reply done): "${text.substring(0, 80)}"`);
                    void this.voxta?.sendEvent(text);
                }
            },
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
