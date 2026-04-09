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
import type { Bot as MineflayerBot } from 'mineflayer';
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
    private mcBot2: MinecraftBot | null = null;
    private voxta: VoxtaClient | null = null;
    private perceptionLoop: ReturnType<typeof setInterval> | null = null;
    private perceptionLoop2: ReturnType<typeof setInterval> | null = null;
    private followWatchdog: ReturnType<typeof setInterval> | null = null;
    private followWatchdog2: ReturnType<typeof setInterval> | null = null;
    private mountedSteeringLoop: ReturnType<typeof setInterval> | null = null;
    private mountedSteeringLoop2: ReturnType<typeof setInterval> | null = null;
    private autoDismounting = false;
    private modeScanLoop: ReturnType<typeof setInterval> | null = null;
    private modeScanLoop2: ReturnType<typeof setInterval> | null = null;
    private proximityLoop: ReturnType<typeof setInterval> | null = null;
    private bot1InRange = true;
    private bot2InRange = true;
    private spatialLoop: ReturnType<typeof setInterval> | null = null;
    private eventBridge: McEventBridge | null = null;
    private eventBridge2: McEventBridge | null = null;
    private assistantName: string | null = null;
    private assistantName2: string | null = null;
    private activeCharacterId: string | null = null;
    private activeCharacterIds: string[] = [];
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
    private flushHuntBatch2: (() => void) | null = null;
    private toastCounter = 0;
    // Maps Voxta character ID → MC bot slot (1 or 2) — populated after chatStarted
    private readonly characterBotMap: Map<string, 1 | 2> = new Map();
    // Which bot slot spoke last — actions are routed to this bot
    private lastSpeakingSlot: 1 | 2 = 1;

    private readonly audioPipeline: AudioPipeline;

    private status: BotStatus = {
        mc: 'disconnected',
        mc2: 'disconnected',
        voxta: 'disconnected',
        position: null,
        health: null,
        food: null,
        position2: null,
        health2: null,
        food2: null,
        currentAction: null,
        assistantName: null,
        assistantName2: null,
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
            'minecraft-bot1',
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
            if (this.perceptionLoop2) {
                clearInterval(this.perceptionLoop2);
                this.perceptionLoop2 = null;
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
            if (this.modeScanLoop2) {
                clearInterval(this.modeScanLoop2);
                this.modeScanLoop2 = null;
            }
            if (this.proximityLoop) {
                clearInterval(this.proximityLoop);
                this.proximityLoop = null;
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
            if (this.perceptionLoop2) {
                clearInterval(this.perceptionLoop2);
                this.perceptionLoop2 = null;
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
            if (this.modeScanLoop2) {
                clearInterval(this.modeScanLoop2);
                this.modeScanLoop2 = null;
            }
            if (this.proximityLoop) {
                clearInterval(this.proximityLoop);
                this.proximityLoop = null;
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
                position2: null,
                health2: null,
                food2: null,
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

        // ---- 1. Connect Minecraft bots ----
        this.updateStatus({ mc: 'connecting' });
        this.addChat('system', 'System', `Connecting to MC ${config.mc.host}:${config.mc.port}...`);

        try {
            this.mcBot = createMinecraftBot(config);
            await this.mcBot.connect();
            initHomePosition(this.mcBot.bot, config.mc.host, config.mc.port);
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

        // ---- Optional: connect second bot in parallel ----
        const isDualBot = !!(uiConfig.secondMcUsername && uiConfig.secondCharacterId);
        if (isDualBot) {
            this.updateStatus({ mc2: 'connecting' });
            const config2: CompanionConfig = {
                ...config,
                mc: { ...config.mc, username: uiConfig.secondMcUsername! },
            };
            try {
                this.mcBot2 = createMinecraftBot(config2);
                await this.mcBot2.connect();
                initHomePosition(this.mcBot2.bot, config2.mc.host, config2.mc.port);
                this.updateStatus({ mc2: 'connected' });
                this.addChat('system', 'System', `Minecraft bot 2 spawned as ${config2.mc.username}`);
                this.toast('success', `Bot "${config2.mc.username}" joined the Minecraft server!`);
            } catch (err) {
                const message = this.humanizeError(err, 'Minecraft connection (bot 2)');
                this.updateStatus({ mc2: 'error' });
                this.addChat('system', 'System', `MC bot 2 connection failed: ${message}`);
                this.toast('error', message);
                // Continue with single-bot mode — don’t abort the whole session
                this.mcBot2 = null;
            }
        }

        // ---- Wire up dual-bot spacing ----
        // Each bot's pathfinder treats the other as high-cost terrain (exclusion zone)
        // and uses a different follow distance to prevent overlapping.
        if (isDualBot && this.mcBot2) {
            this.mcBot.setCompanion(this.mcBot2.bot);
            this.mcBot2.setCompanion(this.mcBot.bot);
            // Bot 1 follows at 3 blocks, bot 2 at 5 — creates natural spacing layers
            (this.mcBot.bot as unknown as { followDistance: number }).followDistance = 3;
            (this.mcBot2.bot as unknown as { followDistance: number }).followDistance = 5;
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

        // Resolve second character name if dual-bot mode is active
        if (isDualBot && uiConfig.secondCharacterId) {
            const char2 = this.characters.find((c) => c.id === uiConfig.secondCharacterId);
            this.assistantName2 = char2?.name ?? 'AI2';
        } else {
            this.assistantName2 = null;
        }

        // Auto-detect the player's actual MC username from the server
        const botUsername = config.mc.username;
        const onlinePlayers = Object.keys(bot.players).filter(
            (name) => name !== botUsername && name !== uiConfig.secondMcUsername,
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

        // Populate name registry (player + both bots)
        this.names.clear();
        if (this.voxtaUserName && this.playerMcUsername) {
            this.names.register(this.voxtaUserName, this.playerMcUsername);
        }
        if (this.assistantName && config.mc.username) {
            this.names.register(this.assistantName, config.mc.username);
        }
        if (this.assistantName2 && uiConfig.secondMcUsername) {
            this.names.register(this.assistantName2, uiConfig.secondMcUsername);
        }

        // Read initial world state BEFORE starting chat — the server processes
        // context from the startChat message before generating the greeting
        const assistantName1 = this.assistantName;
        let initialContextStrings: string[] = [];
        try {
            const initialState = readWorldState(bot, config.perception.entityRange);
            const rawStrings = buildContextStrings(initialState, this.names, assistantName1);
            // Label each context block with the bot's character name
            initialContextStrings = rawStrings.map((s) => `[${assistantName1}] ${s}`);
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

        // Build the character IDs array (1 or 2 IDs depending on dual-bot mode)
        const characterIds = [uiConfig.characterId];
        if (isDualBot && uiConfig.secondCharacterId) {
            characterIds.push(uiConfig.secondCharacterId);
        }
        this.activeCharacterIds = characterIds;

        await this.voxta.startChat(
            characterIds,
            uiConfig.chatId ?? undefined,
            uiConfig.scenarioId ?? undefined,
            {
                contextKey: 'minecraft-bot1',
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
            assistantName2: this.assistantName2,
        });

        const sessionMsg = isDualBot && this.assistantName2
            ? `Chat started with ${this.assistantName} & ${this.assistantName2}`
            : `Chat started with ${this.assistantName}`;
        this.addChat('system', 'System', sessionMsg);

        // ---- Perception loop — bot 1 ----
        let lastContextHash = initialContextStrings.join('|');

        this.perceptionLoop = setInterval(() => {
            if (!this.voxta?.sessionId) return;
            try {
                const state = readWorldState(bot, config.perception.entityRange);
                const rawStrings = buildContextStrings(state, this.names, assistantName1);
                const contextStrings = rawStrings.map((s) => `[${assistantName1}] ${s}`);

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
                    // Send actions only with bot1's context (shared between both bots)
                    // Skip if bot1 is out of proximity range (removed from session)
                    if (this.bot1InRange) {
                        void this.voxta.updateContext(
                            'minecraft-bot1',
                            contextStrings.map((text) => ({ text })),
                            this.getEnabledActions(),
                        );
                    }
                }
            } catch (err) {
                // Perception can fail during respawn/chunk loading
                console.error('[Perception] Context update failed:', err);
            }
        }, config.perception.intervalMs);

        // ---- Perception loop — bot 2 (dual-bot mode only) ----
        if (isDualBot && this.mcBot2) {
            const bot2 = this.mcBot2.bot;
            const assistantName2 = this.assistantName2 ?? 'AI2';
            let lastContextHash2 = '';

            this.perceptionLoop2 = setInterval(() => {
                if (!this.voxta?.sessionId) return;
                try {
                    const state2 = readWorldState(bot2, config.perception.entityRange);
                    const rawStrings2 = buildContextStrings(state2, this.names, assistantName2);
                    const contextStrings2 = rawStrings2.map((s) => `[${assistantName2}] ${s}`);

                    this.updateStatus({
                        position2: state2.position
                            ? {
                                  x: Math.round(state2.position.x),
                                  y: Math.round(state2.position.y),
                                  z: Math.round(state2.position.z),
                              }
                            : null,
                        health2: state2.health,
                        food2: state2.food,
                    });

                    const contextHash2 = contextStrings2.join('|');
                    if (contextHash2 !== lastContextHash2) {
                        lastContextHash2 = contextHash2;
                        // Skip if bot2 is out of proximity range (removed from session)
                        if (this.bot2InRange) {
                            // No actions here — actions are sent with bot1's context update
                            void this.voxta.updateContext(
                                'minecraft-bot2',
                                contextStrings2.map((text) => ({ text })),
                            );
                        }
                    }
                } catch (err) {
                    console.error('[Perception] Bot 2 context update failed:', err);
                }
            }, config.perception.intervalMs);
        }

        // ---- Spatial audio position loop (fast — 100ms for responsive audio) ----
        this.spatialLoop = setInterval(() => {
            if (!this.playerMcUsername) return;
            try {
                // Use the currently speaking bot's position — not always bot 1
                const activeBot = (this.lastSpeakingSlot === 2 && this.mcBot2) ? this.mcBot2.bot : bot;
                // Use vehicle position when mounted — entity position is stale for passengers
                const botVehicle = (activeBot as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
                const botPos = botVehicle ? botVehicle.position : activeBot.entity?.position;
                const playerEntity = activeBot.players[this.playerMcUsername]?.entity;
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

        // ---- Mounted steering + Follow watchdog ----
        this.mountedSteeringLoop = this.createMountedSteeringLoop(bot, () => !!this.mcBot);
        this.followWatchdog = this.createFollowWatchdog(bot, () => !!this.mcBot, 'Bot');

        // ---- Same loops for bot 2 (dual-bot mode) ----
        if (isDualBot && this.mcBot2) {
            this.mountedSteeringLoop2 = this.createMountedSteeringLoop(this.mcBot2.bot, () => !!this.mcBot2);
            this.followWatchdog2 = this.createFollowWatchdog(this.mcBot2.bot, () => !!this.mcBot2, 'Bot2');
            const { loop: scanLoop2, flush: flushBatch2 } = this.createModeScanLoop(
                this.mcBot2.bot, () => !!this.mcBot2, 'Bot2', () => this.assistantName2 ?? 'Bot2',
            );
            this.modeScanLoop2 = scanLoop2;
            this.flushHuntBatch2 = flushBatch2;
        }

        // ---- Mode scan loop (aggro + hunt + guard/patrol) ----
        const { loop: scanLoop1, flush: flushBatch1 } = this.createModeScanLoop(
            bot, () => !!this.mcBot, 'Bot', () => this.assistantName ?? 'Bot',
        );
        this.modeScanLoop = scanLoop1;
        this.flushHuntBatch = flushBatch1;

        // ---- Proximity loop: silence/activate characters based on distance to player ----
        // When a bot is farther than PROXIMITY_RANGE blocks from the player, it gets
        // disabled in Voxta so it doesn't speak about things it can't see or know about.
        // It re-activates automatically when it comes back in range.
        const PROXIMITY_RANGE = 40; // blocks
        this.bot1InRange = true;
        this.bot2InRange = true;
        let proximityLogTick = 0;
        this.proximityLoop = setInterval(() => {
            if (!this.voxta?.sessionId || !this.playerMcUsername) return;

            const findPlayer = (b: typeof bot) =>
                Object.values(b.entities).find(
                    (e) => e.type === 'player' && e.username?.toLowerCase() === this.playerMcUsername!.toLowerCase(),
                );

            // Bot 1
            if (this.mcBot && this.activeCharacterIds[0]) {
                const playerEntity = findPlayer(this.mcBot.bot);
                // Player not visible in entities = beyond render distance = definitely out of range
                const dist1 = playerEntity
                    ? playerEntity.position.distanceTo(this.mcBot.bot.entity.position)
                    : Infinity;
                const inRange = dist1 <= PROXIMITY_RANGE;
                if (proximityLogTick % 6 === 0) {
                    console.log(`[Proximity] ${this.assistantName ?? 'Bot1'}: ${dist1 === Infinity ? 'not visible' : `${dist1.toFixed(1)} blocks`} (${inRange ? 'in range' : 'OUT OF RANGE'})`);
                }
                if (inRange !== this.bot1InRange) {
                    this.bot1InRange = inRange;
                    const name = this.assistantName ?? 'Bot';
                    if (inRange) {
                        console.log(`[Proximity] ${name} back in range — rejoining`);
                        void this.voxta.addChatParticipant(this.activeCharacterIds[0]);
                        this.addChat('system', 'System', `${name} is back in range.`);
                        this.queueNote(`${name} rejoined — back within range of the player.`);
                    } else {
                        console.log(`[Proximity] ${name} out of range — removing`);
                        void this.voxta.removeChatParticipant(this.activeCharacterIds[0]);
                        this.addChat('system', 'System', `${name} is too far away to hear.`);
                    }
                }
            }

            // Bot 2 (dual-bot only)
            if (isDualBot && this.mcBot2 && this.activeCharacterIds[1]) {
                const playerEntity2 = findPlayer(this.mcBot2.bot);
                const dist2 = playerEntity2
                    ? playerEntity2.position.distanceTo(this.mcBot2.bot.entity.position)
                    : Infinity;
                if (proximityLogTick % 6 === 0) {
                    console.log(`[Proximity] ${this.assistantName2 ?? 'Bot2'}: ${dist2 === Infinity ? 'not visible' : `${dist2.toFixed(1)} blocks`} (${dist2 <= PROXIMITY_RANGE ? 'in range' : 'OUT OF RANGE'})`);
                }
                const inRange2 = dist2 <= PROXIMITY_RANGE;
                if (inRange2 !== this.bot2InRange) {
                    this.bot2InRange = inRange2;
                    const name2 = this.assistantName2 ?? 'Bot2';
                    if (inRange2) {
                        console.log(`[Proximity] ${name2} back in range — rejoining`);
                        void this.voxta.addChatParticipant(this.activeCharacterIds[1]);
                        this.addChat('system', 'System', `${name2} is back in range.`);
                        this.queueNote(`${name2} rejoined — back within range of the player.`);
                    } else {
                        console.log(`[Proximity] ${name2} out of range — removing`);
                        void this.voxta.removeChatParticipant(this.activeCharacterIds[1]);
                        this.addChat('system', 'System', `${name2} is too far away to hear.`);
                    }
                }
            }
            proximityLogTick++;
        }, 5000);

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
                    this.flushHuntBatch2?.();

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
                    if (getCurrentCombatTarget(bot)) {
                        console.log(`[Bot] Combat still active (${getCurrentCombatTarget(bot)}), NOT overriding with follow`);
                    } else if (getBotMode(bot) === 'guard') {
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
            // All bot usernames — so the event bridge ignores chat from any of our bots
            new Set([
                config.mc.username,
                ...(isDualBot && uiConfig.secondMcUsername ? [uiConfig.secondMcUsername] : []),
            ]),
        );

        // ---- 3b. Register MC event bridge for bot 2 (dual-bot mode) ----
        // Bot 2 gets its own damage/death/auto-defense/auto-eat listeners,
        // but chat bridging is skipped (bot 1's bridge handles it for both).
        if (isDualBot && this.mcBot2) {
            const bot2 = this.mcBot2.bot;
            this.eventBridge2 = new McEventBridge(
                bot2,
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
                            console.log(`[Bot2 >>] event: "${text.substring(0, 80)}"`);
                            void this.voxta.sendEvent(text);
                        }
                    },
                    onUrgentEvent: (text) => {
                        if (!this.voxta?.sessionId) return;
                        this.addChat('event', 'Event', text);
                        this.audioPipeline.interrupt();
                        this.audioPipeline.fireAckNow();
                        this.emit('stop-audio');
                        void this.voxta.interrupt();
                        this.isReplying = false;
                        this.currentReply = '';
                        console.log(`[Bot2 >>] event (urgent): "${text.substring(0, 80)}"`);
                        void this.voxta.sendEvent(text);
                    },
                    onPlayerChat: () => {
                        // No-op — bot 1's bridge handles chat bridging
                    },
                    getSettings: () => this.settings,
                    getAssistantName: () => this.assistantName2 ?? 'Bot2',
                    isReplying: () => this.isReplying,
                },
                () => this.followingPlayer,
                async (botInstance, mobName) => {
                    const vehicleCheck = (botInstance as unknown as { vehicle: { id: number } | null }).vehicle;
                    if (vehicleCheck) {
                        console.log(`[Bot2] Skipping auto-defense against ${mobName} — mounted on vehicle`);
                        return;
                    }
                    const botName = this.assistantName2 ?? 'Bot2';
                    console.log(`[Bot2] Auto-defense started against ${mobName}`);
                    try {
                        const result = await executeAction(
                            botInstance,
                            'mc_attack',
                            [{ name: 'entity_name', value: mobName }],
                            this.names,
                        );
                        const isNoise = result.startsWith('Already fighting')
                            || result.startsWith('Stopped fighting')
                            || result.startsWith('Died while fighting');
                        if (!result) {
                            this.addChat('note', 'Note', 'Creeper exploded nearby');
                            this.queueNote('Creeper exploded nearby');
                        } else if (!isNoise) {
                            this.addChat('note', 'Note', `${botName}: ${result}`);
                            this.queueNote(`${botName}: ${result}`);
                        }
                        console.log(`[Bot2] Auto-defense attack result: ${result}`);
                    } catch (err) {
                        console.log(`[Bot2] Auto-defense attack failed:`, err);
                    } finally {
                        this.eventBridge2?.clearLastAttacker();
                        console.log(`[Bot2] Auto-defense finished`);
                        if (getCurrentCombatTarget(botInstance)) {
                            console.log(`[Bot2] Combat still active, NOT overriding with follow`);
                        } else if (this.followingPlayer && this.mcBot2) {
                            const playerToFollow = this.followingPlayer;
                            const mcBot2Ref = this.mcBot2;
                            setTimeout(() => {
                                if (this.followingPlayer !== playerToFollow) return;
                                const resumeResult = resumeFollowPlayer(mcBot2Ref.bot, playerToFollow, this.names);
                                console.log(`[Bot2] Resumed following after defense: ${resumeResult}`);
                            }, 150);
                        }
                    }
                },
                new Set([
                    config.mc.username,
                    ...(uiConfig.secondMcUsername ? [uiConfig.secondMcUsername] : []),
                ]),
                true, // skipChatBridging — bot 1's bridge handles chat for both
            );
        }

        // Auto-follow: companion(s) should follow the player by default on spawn
        // Small delay to let pathfinder initialize after bot spawn
        if (this.playerMcUsername) {
            this.followingPlayer = this.playerMcUsername;
            const playerName = this.playerMcUsername;
            const botsToFollow = [this.mcBot.bot];
            if (isDualBot && this.mcBot2) botsToFollow.push(this.mcBot2.bot);
            console.log(`[Bot] Auto-following ${playerName} on spawn (${botsToFollow.length} bot(s))`);
            setTimeout(() => {
                for (const botInstance of botsToFollow) {
                    executeAction(
                        botInstance,
                        'mc_follow_player',
                        [{ name: 'player_name', value: playerName }],
                        this.names,
                    ).catch((err) => {
                        console.log(`[Bot] Auto-follow failed for ${botInstance.username}, retrying in 2s:`, err);
                        setTimeout(() => {
                            if (!this.mcBot || this.followingPlayer !== playerName) return;
                            void executeAction(
                                botInstance,
                                'mc_follow_player',
                                [{ name: 'player_name', value: playerName }],
                                this.names,
                            );
                        }, 2000);
                    });
                }
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
                this.activeCharacterIds,
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
                        void this.voxta.updateContext(
                            'minecraft-bot1',
                            contextStrings.map((text) => ({ text })),
                            this.getEnabledActions(),
                        );
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

    /**
     * Creates the aggro/hunt/guard mode scan loop for a bot.
     * Extracted so bot 1 and bot 2 can each have their own independent loop with isolated state.
     */
    private createModeScanLoop(
        bot: MineflayerBot,
        isBotActive: () => boolean,
        label: string,
        getAssistantName: () => string,
    ): { loop: ReturnType<typeof setInterval>; flush: () => void } {
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
            const botName = getAssistantName();
            const summary = entries.map(([mob, count]) => `${count} ${mob}${count > 1 ? 's' : ''}`).join(', ');
            const verb = modeBatchLabel === 'hunt' ? 'Hunted' : 'Defeated';
            this.queueNote(`${botName}: ${verb} ${summary} in ${modeBatchLabel} mode.`);
            console.log(`[${label}] ${modeBatchLabel} batch note: ${verb} ${summary}`);
            for (const key of Object.keys(modeKillCounts)) {
                modeKillCounts[key] = 0;
            }
        };

        // Farm animals that the hunt mode will target
        const HUNTABLE_ANIMALS = ['pig', 'cow', 'mooshroom', 'sheep', 'chicken', 'rabbit'];
        let huntCooldownUntil = 0; // Post-kill cooldown to let the bot settle

        let patrolPauseUntil = 0;
        const loop = setInterval(() => {
            if (!isBotActive()) return;
            const mode = getBotMode(bot);
            if (mode === 'passive') return;
            if (isAutoDefending(bot) || isActionBusy(bot)) return;
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

                if (nearestHostile && !getCurrentCombatTarget(bot)) {
                    const mobName = nearestHostile.name ?? 'unknown';
                    console.log(`[${label}] Aggro mode: attacking ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                    setAutoDefending(bot, true);
                    this.addChat('action', 'Action', `${getAssistantName()} fighting ${mobName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names)
                        .then((result) => {
                            console.log(`[${label}] Aggro attack result: ${result}`);

                            // Only batch successful kills, send failures immediately
                            if (result.toLowerCase().includes('defeated')) {
                                this.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
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
                                this.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                                this.queueNote(`${getAssistantName()}: ${result}`);
                            }

                            // Set cooldown for split mobs
                            if (SPLIT_MOBS.includes(mobName)) {
                                aggroCooldowns[mobName] = Date.now() + 5000;
                                console.log(`[${label}] Aggro: ${mobName} split cooldown set for 5s`);
                            }
                        })
                        .catch((err) => console.log(`[${label}] Aggro attack failed:`, err))
                        .finally(() => {
                            setAutoDefending(bot, false);
                            console.log(`[${label}] Aggro: combat ended, scheduling follow resume in 2s`);
                            // Wait 2s before resuming follow — if another fight starts
                            // in that window, the scan will pick it up and this timer
                            // becomes irrelevant (the new fight sets its own goal).
                            setTimeout(() => {
                                const combatTarget = getCurrentCombatTarget(bot);
                                const defending = isAutoDefending(bot);
                                console.log(`[${label}] Aggro: follow resume check — following=${this.followingPlayer}, combatTarget=${combatTarget}, defending=${defending}`);
                                if (this.followingPlayer && !combatTarget && !defending) {
                                    void executeAction(
                                        bot,
                                        'mc_follow_player',
                                        [{ name: 'player_name', value: this.followingPlayer }],
                                        this.names,
                                    ).then((r) => console.log(`[${label}] Aggro: resumed following after kill: ${r}`));
                                } else {
                                    console.log(`[${label}] Aggro: skipped follow resume (busy or no player)`);
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

                if (nearestAnimal && !getCurrentCombatTarget(bot)) {
                    const animalName = nearestAnimal.name ?? 'unknown';
                    console.log(`[${label}] Hunt mode: targeting ${animalName} (${nearestDist.toFixed(1)} blocks)`);
                    setAutoDefending(bot, true);
                    this.addChat('action', 'Action', `${getAssistantName()} hunting ${animalName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: animalName }], this.names)
                        .then((result) => {
                            console.log(`[${label}] Hunt attack result: ${result}`);

                            if (result.toLowerCase().includes('defeated')) {
                                this.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                                modeBatchLabel = 'hunt';
                                modeKillCounts[animalName] = (modeKillCounts[animalName] ?? 0) + 1;
                                if (modeBatchTimer) clearTimeout(modeBatchTimer);
                                modeBatchTimer = setTimeout(flushModeBatch, 5000);
                            } else if (!result.startsWith('Stopped fighting') && !result.startsWith('Died while fighting')) {
                                this.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                                this.queueNote(`${getAssistantName()}: ${result}`);
                            }
                        })
                        .catch((err) => console.log(`[${label}] Hunt attack failed:`, err))
                        .finally(() => {
                            setAutoDefending(bot, false);
                            // 1.5-second cooldown before hunting the next animal
                            huntCooldownUntil = Date.now() + 1500;
                            console.log(`[${label}] Hunt: kill ended, scheduling follow resume in 2s`);
                            setTimeout(() => {
                                const combatTarget = getCurrentCombatTarget(bot);
                                const defending = isAutoDefending(bot);
                                console.log(`[${label}] Hunt: follow resume check — following=${this.followingPlayer}, combatTarget=${combatTarget}, defending=${defending}`);
                                if (this.followingPlayer && !combatTarget && !defending) {
                                    void executeAction(
                                        bot,
                                        'mc_follow_player',
                                        [{ name: 'player_name', value: this.followingPlayer }],
                                        this.names,
                                    ).then((r) => console.log(`[${label}] Hunt: resumed following after kill: ${r}`));
                                } else {
                                    console.log(`[${label}] Hunt: skipped follow resume (busy or no player)`);
                                }
                            }, 2000);
                        });
                }
                return;
            }

            // ---- Guard mode: patrol area + attack hostiles ----
            if (mode === 'guard') {
                const center = getGuardCenter(bot);
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

                if (nearestHostile && !getCurrentCombatTarget(bot)) {
                    const mobName = nearestHostile.name ?? 'unknown';
                    console.log(`[${label}] Guard mode: engaging ${mobName} (${nearestDist.toFixed(1)} blocks)`);
                    patrolTarget = null;
                    setAutoDefending(bot, true);
                    this.addChat('action', 'Action', `${getAssistantName()} defending area from ${mobName}!`);
                    void executeAction(bot, 'mc_attack', [{ name: 'entity_name', value: mobName }], this.names)
                        .then((result) => {
                            this.addChat('note', 'Note', `${getAssistantName()}: ${result}`);
                            this.queueNote(`${getAssistantName()}: ${result}`);
                            console.log(`[${label}] Guard attack result: ${result}`);
                        })
                        .catch((err) => console.log(`[${label}] Guard attack failed:`, err))
                        .finally(() => setAutoDefending(bot, false));
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
                console.log(`[${label}] Patrol: walking to (${patrolTarget.x.toFixed(0)}, ${patrolTarget.z.toFixed(0)}) — ${distToCenter.toFixed(1)} from center`);

                // Walk to patrol point
                const { GoalNear } = require('mineflayer-pathfinder').goals;
                bot.pathfinder.setGoal(new GoalNear(patrolTarget.x, center.y, patrolTarget.z, 1));
            }
        }, 2000);

        return { loop, flush: flushModeBatch };
    }

    /**
     * Creates a mounted steering loop for a bot.
     * Horse movement is client-side in MC — the client sends vehicle_move packets.
     * Extracted so bot 1 and bot 2 can each have their own independent steering loop.
     */
    private createMountedSteeringLoop(
        bot: MineflayerBot,
        isBotActive: () => boolean,
    ): ReturnType<typeof setInterval> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcClient = (bot as any)._client;
        let lastSteerLog = 0;
        return setInterval(() => {
            if (!isBotActive() || !this.followingPlayer) return;
            if (isActionBusy(bot) || this.autoDismounting) return;
            const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
            if (!vehicle) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const vehicleEntity = (vehicle as any);
            const vehicleName: string = (vehicleEntity.displayName ?? vehicleEntity.name ?? '').toLowerCase();
            if (vehicleName.includes('boat')) return; // Boat steering not yet implemented

            const player = findPlayerEntity(bot, this.followingPlayer, this.names);
            if (!player) return;
            const playerVehicle = (player as unknown as { vehicle: { position: typeof bot.entity.position } | null }).vehicle;
            const targetPos = playerVehicle ? playerVehicle.position : player.position;
            const vPos = vehicleEntity.position;
            if (!vPos) return;
            const dist = vPos.distanceTo(targetPos);
            if (dist < 5) {
                mcClient.write('player_input', {
                    inputs: { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false },
                });
                return;
            }

            const dx = targetPos.x - vPos.x;
            const dz = targetPos.z - vPos.z;
            const yaw = -Math.atan2(dx, dz);
            const yawDeg = yaw * (180 / Math.PI);

            let speedAttr = 0.225;
            if (vehicleEntity.attributes?.['minecraft:generic.movement_speed']) {
                speedAttr = vehicleEntity.attributes['minecraft:generic.movement_speed'].value ?? 0.225;
            } else if (vehicleEntity.attributes?.['generic.movementSpeed']) {
                speedAttr = vehicleEntity.attributes['generic.movementSpeed'].value ?? 0.225;
            }
            const blocksPerSec = speedAttr * 100;
            const moveStep = Math.min(blocksPerSec * 0.05, 2.0);

            const Vec3 = require('vec3');
            const isBlocked = (x: number, z: number, baseY: number): boolean => {
                try {
                    const floorY = Math.floor(baseY);
                    let groundLevel = floorY - 1;
                    for (let y = floorY + 2; y >= floorY - 3; y--) {
                        const b = bot.blockAt(new Vec3(x, y, z));
                        if (b && b.boundingBox === 'block') { groundLevel = y; break; }
                    }
                    if ((groundLevel + 1) - baseY > 1.5) return true;
                    const standY = groundLevel + 1;
                    for (let dy = 0; dy <= 2; dy++) {
                        const b = bot.blockAt(new Vec3(x, standY + dy, z));
                        if (b && b.boundingBox === 'block') return true;
                    }
                } catch { /* world not loaded */ }
                return false;
            };

            let moveYaw = yaw;
            let moveYawDeg = yawDeg;
            let foundClear = false;
            for (const offset of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2]) {
                const tryYaw = yaw + offset;
                if (!isBlocked(vPos.x + (-Math.sin(tryYaw) * moveStep), vPos.z + (Math.cos(tryYaw) * moveStep), vPos.y)) {
                    moveYaw = tryYaw;
                    moveYawDeg = moveYaw * (180 / Math.PI);
                    foundClear = true;
                    break;
                }
            }

            if (!foundClear) {
                mcClient.write('look', { yaw: yawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
                return;
            }

            const newX = vPos.x + (-Math.sin(moveYaw) * moveStep);
            const newZ = vPos.z + (Math.cos(moveYaw) * moveStep);
            let newY = vPos.y;
            let shouldJump = false;
            try {
                const searchY = Math.floor(vPos.y);
                for (let y = searchY + 2; y >= searchY - 4; y--) {
                    const b = bot.blockAt(new Vec3(newX, y, newZ));
                    if (b && b.boundingBox === 'block') {
                        const yDiff = (y + 1) - vPos.y;
                        if (yDiff >= 0.5 && yDiff <= 1.5) { shouldJump = true; newY = y + 1; }
                        else { newY = vPos.y + Math.max(-0.5, Math.min(0.5, yDiff)); }
                        break;
                    }
                }
            } catch { /* world not loaded */ }

            mcClient.write('look', { yaw: moveYawDeg, pitch: 0, flags: { onGround: true, hasHorizontalCollision: false } });
            mcClient.write('player_input', {
                inputs: { forward: true, backward: false, left: false, right: false, jump: shouldJump, shift: false, sprint: false },
            });
            mcClient.write('vehicle_move', { x: newX, y: newY, z: newZ, yaw: moveYawDeg, pitch: 0, onGround: !shouldJump });

            const now = Date.now();
            if (now - lastSteerLog > 2000) {
                lastSteerLog = now;
                console.log(`[MC Steer] Riding: dist=${dist.toFixed(1)}, speed=${blocksPerSec.toFixed(1)}b/s, step=${moveStep.toFixed(2)}, y=${newY.toFixed(1)}, pos=(${newX.toFixed(1)}, ${newZ.toFixed(1)})`);
            }
        }, 50);
    }

    /**
     * Creates a follow watchdog for a bot.
     * Detects when pathfinder silently stops and uses escalating recovery strategies.
     * Extracted so bot 1 and bot 2 can each have their own independent watchdog.
     */
    private createFollowWatchdog(
        bot: MineflayerBot,
        isBotActive: () => boolean,
        label: string,
    ): ReturnType<typeof setInterval> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcClient = (bot as any)._client;
        let lastPos = bot.entity.position.clone();
        let stuckCount = 0;
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
                if (playerMountedVehicleId !== vehicleEntityId) {
                    playerMountedVehicleId = vehicleEntityId;
                    console.log(`[${label}] Player mounted ${vName} (id=${vehicleEntityId})`);
                    if (!isActionBusy(bot)) resumeFollowPlayer(bot, this.followingPlayer, this.names);
                }
            } else if (playerMountedVehicleId === vehicleEntityId) {
                console.log(`[${label}] Player dismounted ${vName} (id=${vehicleEntityId})`);
                playerMountedVehicleId = null;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (player as any).vehicle = null;
                if (!isActionBusy(bot)) resumeFollowPlayer(bot, this.followingPlayer, this.names);
            }
        });

        return setInterval(() => {
            if (!isBotActive() || !this.followingPlayer) return;
            if (getBotMode(bot) === 'guard') return;
            if (isAutoDefending(bot)) { console.log(`[${label}] Watchdog skip: auto-defending`); return; }
            if (isActionBusy(bot)) { console.log(`[${label}] Watchdog skip: action busy`); return; }

            const vehicle = (bot as unknown as { vehicle: { id: number } | null }).vehicle;
            if (vehicle) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const vn = ((vehicle as any).displayName ?? (vehicle as any).name ?? 'vehicle').toLowerCase();
                console.log(`[${label}] Watchdog skip: bot is mounted (${vn})`);
                return;
            }

            const pos = bot.entity.position;
            if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;

            const player = findPlayerEntity(bot, this.followingPlayer, this.names);
            if (!player) return;

            const playerVehicleEntity = playerMountedVehicleId ? bot.entities[playerMountedVehicleId] : null;
            const targetPos = playerVehicleEntity ? playerVehicleEntity.position : player.position;
            const distToPlayer = pos.distanceTo(targetPos);
            const moved = pos.distanceTo(lastPos);
            lastPos = pos.clone();

            if (distToPlayer < 5) {
                stuckCount = 0;
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                return;
            }
            if (moved > 0.5) { stuckCount = 0; return; }

            stuckCount++;
            if (stuckCount <= 1) {
                console.log(`[${label}] Watchdog: stuck ${distToPlayer.toFixed(1)} blocks from player, moved ${moved.toFixed(2)} — re-setting goal (tier 1)`);
                resumeFollowPlayer(bot, this.followingPlayer, this.names);
            } else if (stuckCount === 2) {
                console.log(`[${label}] Watchdog: still stuck — resetting pathfinder movements (tier 2)`);
                const freshMovements = new (require('mineflayer-pathfinder').Movements)(bot);
                freshMovements.canDig = true;
                freshMovements.allow1by1towers = true;
                bot.pathfinder.setMovements(freshMovements);
                resumeFollowPlayer(bot, this.followingPlayer, this.names);
            } else {
                console.log(`[${label}] Watchdog: pathfinder failed — manual walking toward player (tier 3, dist=${distToPlayer.toFixed(1)})`);
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
                void bot.lookAt(targetPos.offset(0, 1.6, 0));
                bot.setControlState('forward', true);
                bot.setControlState('sprint', true);
            }
        }, 5000);
    }

    /** Stop the current chat session + MC bot, but keep the Voxta connection alive */
    async stopSession(): Promise<void> {
        if (this.perceptionLoop) {
            clearInterval(this.perceptionLoop);
            this.perceptionLoop = null;
        }
        if (this.perceptionLoop2) {
            clearInterval(this.perceptionLoop2);
            this.perceptionLoop2 = null;
        }
        if (this.followWatchdog) {
            clearInterval(this.followWatchdog);
            this.followWatchdog = null;
        }
        if (this.followWatchdog2) {
            clearInterval(this.followWatchdog2);
            this.followWatchdog2 = null;
        }
        if (this.mountedSteeringLoop) {
            clearInterval(this.mountedSteeringLoop);
            this.mountedSteeringLoop = null;
        }
        if (this.mountedSteeringLoop2) {
            clearInterval(this.mountedSteeringLoop2);
            this.mountedSteeringLoop2 = null;
        }
        if (this.modeScanLoop) {
            clearInterval(this.modeScanLoop);
            this.modeScanLoop = null;
        }
        if (this.modeScanLoop2) {
            clearInterval(this.modeScanLoop2);
            this.modeScanLoop2 = null;
        }
        if (this.proximityLoop) {
            clearInterval(this.proximityLoop);
            this.proximityLoop = null;
        }
        this.bot1InRange = true;
        this.bot2InRange = true;
        if (this.spatialLoop) {
            clearInterval(this.spatialLoop);
            this.spatialLoop = null;
        }
        if (this.eventBridge) {
            this.eventBridge.destroy();
            this.eventBridge = null;
        }
        if (this.eventBridge2) {
            this.eventBridge2.destroy();
            this.eventBridge2 = null;
        }

        // Clear companion references before disconnecting
        if (this.mcBot) this.mcBot.setCompanion(null);
        if (this.mcBot2) this.mcBot2.setCompanion(null);

        if (this.mcBot) {
            try {
                this.mcBot.bot.chat('Goodbye!');
                this.mcBot.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.mcBot = null;
        }

        if (this.mcBot2) {
            try {
                this.mcBot2.disconnect();
            } catch {
                // Ignore disconnect errors
            }
            this.mcBot2 = null;
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
        this.assistantName2 = null;
        this.activeCharacterId = null;
        this.activeCharacterIds = [];
        this.currentReply = '';
        this.followingPlayer = null;
        this.isReplying = false;
        this.pendingNotes = [];
        this.pendingEvents = [];
        this.characterBotMap.clear();
        this.lastSpeakingSlot = 1;

        this.updateStatus({
            ...this.status,
            mc: 'disconnected',
            mc2: 'disconnected',
            voxta: this.voxta ? 'connected' : 'disconnected',
            position: null,
            health: null,
            food: null,
            position2: null,
            health2: null,
            food2: null,
            currentAction: null,
            assistantName: null,
            assistantName2: null,
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
            position2: null,
            health2: null,
            food2: null,
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
        this.flushHuntBatch2?.();

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
            // Multi-bot routing
            getCharacterBotMap: () => this.characterBotMap,
            getBotBySlot: (slot) => (slot === 2 ? this.mcBot2?.bot ?? null : this.mcBot?.bot ?? null),
            getAssistantNameBySlot: (slot) => (slot === 2 ? this.assistantName2 : this.assistantName),
            getLastSpeakingSlot: () => this.lastSpeakingSlot,
            setLastSpeakingSlot: (slot) => { this.lastSpeakingSlot = slot; },

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
            setSkinUrlForSlot: (url, slot) => {
                if (slot === 2) {
                    this.mcBot2?.setSkinUrl(url);
                } else {
                    this.mcBot?.setSkinUrl(url);
                }
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
                // Echo from the last-speaking bot's slot
                const echoBot = this.lastSpeakingSlot === 2 ? this.mcBot2 : this.mcBot;
                if (echoBot && this.settings.enableBotChatEcho) {
                    const maxLen = 250;
                    for (let i = 0; i < text.length; i += maxLen) {
                        echoBot.bot.chat(text.substring(i, i + maxLen));
                    }
                }
            },

            // Audio pipeline
            audioPipeline: this.audioPipeline,
        });
    }
}
