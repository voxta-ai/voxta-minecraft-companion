import { EventEmitter } from 'events';
import { createMinecraftBot } from '../bot/minecraft/bot';
import { readWorldState, buildContextStrings } from '../bot/minecraft/perception';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, initHomePosition } from '../bot/minecraft/action-dispatcher';
import { loadCustomBlueprints } from '../bot/minecraft/blueprints';
import { dismountEntity } from '../bot/minecraft/actions';
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
import {
    registerPluginChannel,
    sendAudioData,
    sendRegisterHost,
    sendSetDistance,
    sendStopAudio,
    extractPcmFromWav,
} from './plugin-channel';
import { McEventBridge } from '../bot/minecraft/events';
import type { Bot as MineflayerBot } from 'mineflayer';
import { setFollowDistance, getVehicle } from '../bot/minecraft/mineflayer-types';

// Extracted modules
import {
    fetchCharacterDetails,
    loadScenarios as loadScenariosApi,
    loadChats as loadChatsApi,
    favoriteChat as favoriteChatApi,
    deleteChat as deleteChatApi,
    humanizeError,
} from './bot-engine-voxta';
import { createModeScanLoop, createMountedSteeringLoop, createFollowWatchdog } from './bot-engine-movement';
import type { MovementCallbacks } from './bot-engine-movement';
import { createPerceptionLoop, createSpatialLoop, createProximityLoop } from './bot-engine-loops';
import type { LoopCallbacks } from './bot-engine-loops';
import { createEventBridge } from './bot-engine-events';
import type { EventBridgeCallbacks } from './bot-engine-events';

// Centralized constants
const CLIENT_NAME = 'Voxta.Minecraft';
const CLIENT_VERSION = '0.2.0';
const AUTH_TIMEOUT_MS = 15000;   // Max wait for Voxta authentication
const AUTH_POLL_MS = 200;        // Polling interval during auth wait
const SESSION_TIMEOUT_MS = 15000; // Max wait for chat session to start
const SESSION_POLL_MS = 200;     // Polling interval during session wait
const LOG_PREVIEW_LENGTH = 80;   // Truncation length for log messages
const CONTEXT_KEY_BOT1 = 'minecraft-bot1';

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

/** Per-bot state that is duplicated for each bot slot */
interface BotSlot {
    mcBot: MinecraftBot | null;
    perceptionLoop: ReturnType<typeof setInterval> | null;
    followWatchdog: ReturnType<typeof setInterval> | null;
    mountedSteeringLoop: ReturnType<typeof setInterval> | null;
    modeScanLoop: ReturnType<typeof setInterval> | null;
    eventBridge: McEventBridge | null;
    assistantName: string | null;
    flushHuntBatch: (() => void) | null;
    inRange: boolean;
}

function createEmptySlot(): BotSlot {
    return {
        mcBot: null,
        perceptionLoop: null,
        followWatchdog: null,
        mountedSteeringLoop: null,
        modeScanLoop: null,
        eventBridge: null,
        assistantName: null,
        flushHuntBatch: null,
        inRange: true,
    };
}

export class BotEngine extends EventEmitter {
    private readonly botSlots: [BotSlot, BotSlot] = [createEmptySlot(), createEmptySlot()];
    private voxta: VoxtaClient | null = null;
    private autoDismounting = false;
    private proximityLoop: ReturnType<typeof setInterval> | null = null;
    private spatialLoop: ReturnType<typeof setInterval> | null = null;
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
    private isPaused = false;
    /** User's pause intent — survives server's transient chatPaused:false during message processing */
    private userWantsPause = false;
    private pendingNotes: string[] = [];
    private pendingEvents: string[] = [];
    private followingPlayer: string | null = null; // Track who we're following to resume after tasks
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
        paused: false,
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

    /** Access a bot slot by 1-based index (matches callback APIs) */
    private slot(n: 1 | 2): BotSlot { return this.botSlots[n - 1]; }

    // ---- Utilities ----

    /** Log Voxta send errors (notes, events, context updates) without crashing */
    private logSendError(label: string, err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Voxta] ${label} failed: ${msg}`);
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

    private updateStatus(patch: Partial<BotStatus>): void {
        Object.assign(this.status, patch);
        this.emit('status-changed', this.getStatus());
    }

    /** Queue a note — sent immediately if AI is idle, queued if AI is speaking */
    private queueNote(text: string): void {
        if (this.isReplying) {
            console.log(`[Bot >>] note (queued): "${text.substring(0, LOG_PREVIEW_LENGTH)}"`);
            this.pendingNotes.push(text);
        } else {
            console.log(`[Bot >>] note: "${text.substring(0, LOG_PREVIEW_LENGTH)}"`);
            void this.voxta?.sendNote(text).catch((e) => this.logSendError('sendNote', e));
        }
    }

    /** Flush all queued notes after AI finishes speaking */
    private flushPendingNotes(): void {
        if (!this.voxta || this.pendingNotes.length === 0) return;
        console.log(`[Bot >>] flushing ${this.pendingNotes.length} queued note(s)`);
        for (const note of this.pendingNotes) {
            console.log(`[Bot >>] note (flushed): "${note.substring(0, LOG_PREVIEW_LENGTH)}"`);
            void this.voxta.sendNote(note).catch((e) => this.logSendError('sendNote', e));
        }
        this.pendingNotes = [];
    }

    /** Flush queued events — triggers voiced AI replies for action results */
    private flushPendingEvents(): void {
        if (!this.voxta || this.pendingEvents.length === 0) return;
        // Only send the most recent event to avoid spamming multiple replies
        const event = this.pendingEvents[this.pendingEvents.length - 1];
        console.log(`[Bot >>] event (deferred): "${event.substring(0, LOG_PREVIEW_LENGTH)}"`);
        void this.voxta.sendEvent(event).catch((e) => this.logSendError('sendEvent', e));
        this.pendingEvents = [];
    }

    // ---- Public API ----

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
            CONTEXT_KEY_BOT1,
            [
                {
                    text: 'The user is playing Minecraft. You are their AI companion bot inside the game world. You can see the world around you and perform actions.',
                },
            ],
            this.getEnabledActions(),
        ).catch((e) => this.logSendError('updateContext', e));
    }

    updateSettings(newSettings: McSettings): void {
        const timingChanged = this.settings.actionInferenceTiming !== newSettings.actionInferenceTiming;
        const distanceChanged = this.settings.spatialMaxDistance !== newSettings.spatialMaxDistance;
        this.settings = { ...newSettings };
        if (timingChanged) {
            this.pushActionsToVoxta();
        }
        // Sync maxDistance to SVC voice bridge plugin channel
        if (distanceChanged) {
            for (const s of this.botSlots) {
                if (s.mcBot) sendSetDistance(s.mcBot.bot, newSettings.spatialMaxDistance);
            }
        }
    }

    /** Register the voxta:audio plugin channel and wire up audio forwarding to SVC */
    private setupPluginChannel(bot: MineflayerBot, playerMcUsername: string | undefined): void {
        try {
            console.log(`[PluginChannel] Setting up voice bridge for ${bot.username}...`);
            registerPluginChannel(bot);

            // Tell the server-side plugin which player is the host (excluded from SVC audio)
            if (playerMcUsername) {
                console.log(`[PluginChannel] Will register host exclusion for "${playerMcUsername}" in 1s`);
                setTimeout(() => {
                    try {
                        sendRegisterHost(bot, playerMcUsername);
                    } catch (err) {
                        console.error('[PluginChannel] Failed to send host registration:', err);
                    }
                }, 1000);
            } else {
                console.warn('[PluginChannel] No playerMcUsername provided — host exclusion will not be set');
            }

            // Sync current distance setting
            sendSetDistance(bot, this.settings.spatialMaxDistance);

            // Wire up audio forwarding: when AudioPipeline downloads a WAV chunk,
            // also send the raw PCM through the plugin channel for the SVC bridge
            let forwardedChunks = 0;
            this.audioPipeline.setRawAudioCallback((wavBuffer: Buffer) => {
                try {
                    const { pcm, sampleRate } = extractPcmFromWav(wavBuffer);
                    sendAudioData(bot, pcm, sampleRate);
                    forwardedChunks++;
                    if (forwardedChunks === 1) {
                        console.log('[PluginChannel] First audio chunk forwarded to SVC bridge successfully');
                    }
                } catch (err) {
                    console.error(
                        `[PluginChannel] Failed to forward audio chunk #${forwardedChunks + 1}:`,
                        err instanceof Error ? err.message : err,
                    );
                }
            });

            console.log(`[PluginChannel] Voice bridge setup complete for ${bot.username}`);
        } catch (err) {
            // Non-fatal — SVC bridge is optional, bot works fine without it
            console.warn(
                '[PluginChannel] Failed to setup voice bridge (SVC plugin may not be installed):',
                err instanceof Error ? err.message : err,
            );
        }
    }

    // ---- Callback builders for extracted modules ----

    private buildMovementCallbacks(): MovementCallbacks {
        return {
            getFollowingPlayer: () => this.followingPlayer,
            getNames: () => this.names,
            isAutoDismounting: () => this.autoDismounting,
            addChat: (type, sender, text) => this.addChat(type, sender, text),
            queueNote: (text) => this.queueNote(text),
        };
    }

    private buildLoopCallbacks(): LoopCallbacks {
        return {
            getVoxta: () => this.voxta,
            getPlayerMcUsername: () => this.playerMcUsername,
            getFollowingPlayer: () => this.followingPlayer,
            getNames: () => this.names,
            getEnabledActions: () => this.getEnabledActions(),
            isBotInRange: (slot) => this.slot(slot).inRange,
            setBotInRange: (slot, inRange) => { this.slot(slot).inRange = inRange; },
            getActiveCharacterIds: () => this.activeCharacterIds,
            getAssistantName: (slot) => this.slot(slot).assistantName,
            getLastSpeakingSlot: () => this.lastSpeakingSlot,
            getMcBot: (slot) => this.slot(slot).mcBot?.bot ?? null,
            updateStatus: (patch) => this.updateStatus(patch),
            addChat: (type, sender, text) => this.addChat(type, sender, text),
            queueNote: (text) => this.queueNote(text),
            emit: (event, data) => this.emit(event as BotEngineEvent, data),
        };
    }

    private buildEventBridgeCallbacks(): EventBridgeCallbacks {
        return {
            getVoxta: () => this.voxta,
            getSettings: () => this.settings,
            getFollowingPlayer: () => this.followingPlayer,
            isReplying: () => this.isReplying,
            getAssistantName: (slot) => this.slot(slot).assistantName,
            getMcBot: (slot) => this.slot(slot).mcBot,
            addChat: (type, sender, text) => this.addChat(type, sender, text),
            queueNote: (text) => this.queueNote(text),
            audioPipeline: this.audioPipeline,
            emit: (event, ...args) => this.emit(event as BotEngineEvent, ...args),
            setIsReplying: (value) => { this.isReplying = value; },
            setCurrentReply: (text) => { this.currentReply = text; },
            clearPendingEvents: () => { this.pendingEvents = []; },
            flushHuntBatch: (slot) => { this.slot(slot).flushHuntBatch?.(); },
        };
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
            this.clearAllLoops();
            this.emit('stop-audio');

            // Auto-resume the chat if we had an active session
            if (this.activeCharacterId && this.botSlots[0].mcBot) {
                this.addChat('system', 'System', 'Voxta reconnected — resuming chat...');
                this.toast('info', 'Reconnected to Voxta — resuming chat...');
                void this.autoResumeChat();
            } else {
                this.updateStatus({
                    voxta: 'connected',
                    sessionId: null,
                    paused: false,
                    assistantName: null,
                    currentAction: null,
                });
                this.isPaused = false;
                this.userWantsPause = false;
                this.addChat('system', 'System', 'Voxta reconnected — start a new chat to continue.');
                this.toast('warning', 'Reconnected to Voxta — start a new chat to continue.');
            }
        });

        this.voxta.onClose(() => {
            // Full teardown — server is gone
            this.clearAllLoops();
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
        } catch (err) {
            const message = humanizeError(err, 'Voxta connection');
            this.updateStatus({ voxta: 'error' });
            this.addChat('system', 'System', `Voxta connection failed: ${message}`);
            this.toast('error', message);
            throw err;
        }

        // Wait for auth
        const authStart = Date.now();
        while (!this.voxta.authenticated && Date.now() - authStart < AUTH_TIMEOUT_MS) {
            await new Promise((r) => setTimeout(r, AUTH_POLL_MS));
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
        this.characters = await fetchCharacterDetails(this.voxtaUrl, this.voxtaApiKey);

        const userName = this.voxtaUserName ?? 'Player';
        this.addChat('system', 'System', `Welcome, ${userName}! ${this.characters.length} character(s) available.`);

        return {
            userName,
            characters: this.characters,
            defaultAssistantId: this.defaultAssistantId,
        };
    }

    /** Re-fetch character details (MC config) without reconnecting */
    async refreshCharacters(): Promise<VoxtaInfo> {
        if (this.voxtaUrl) {
            this.characters = await fetchCharacterDetails(this.voxtaUrl, this.voxtaApiKey);
        }
        return {
            userName: this.voxtaUserName ?? 'Player',
            characters: this.characters,
            defaultAssistantId: this.defaultAssistantId,
        };
    }

    async loadScenarios(): Promise<ScenarioInfo[]> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        return loadScenariosApi(this.voxtaUrl, this.voxtaApiKey);
    }

    async loadChats(characterId: string): Promise<ChatListItem[]> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        return loadChatsApi(this.voxtaUrl, this.voxtaApiKey, characterId);
    }

    async favoriteChat(chatId: string, favorite: boolean): Promise<void> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        return favoriteChatApi(this.voxtaUrl, this.voxtaApiKey, chatId, favorite);
    }

    async deleteChat(chatId: string): Promise<void> {
        if (!this.voxtaUrl) throw new Error('Must connect to Voxta first');
        return deleteChatApi(this.voxtaUrl, this.voxtaApiKey, chatId);
    }

    // ---- Phase 2: Launch MC bot + start chat ----

    async launchBot(uiConfig: BotConfig): Promise<void> {
        if (!this.voxta) throw new Error('Must connect to Voxta first');

        this.resetSessionState();
        const config = this.buildCompanionConfig(uiConfig);

        // 1. Connect Minecraft bots
        if (!await this.connectPrimaryBot(config, uiConfig)) return;
        const isDualBot = !!(uiConfig.secondMcUsername && uiConfig.secondCharacterId);
        if (isDualBot) await this.connectSecondaryBot(config, uiConfig);

        // 2. Auto-dismount from previous session + resolve characters/names
        void this.autoDismountOnSpawn(this.botSlots[0].mcBot!.bot);
        this.resolvePlayersAndNames(this.botSlots[0].mcBot!.bot, uiConfig, config, isDualBot);

        // 3. Read initial world state and start Voxta chat
        const initialContextStrings = this.readInitialWorldContext(this.botSlots[0].mcBot!.bot, config);
        await this.startVoxtaChat(uiConfig, isDualBot, initialContextStrings);

        // 4. Start all loops and register event bridges
        this.startAllLoops(this.botSlots[0].mcBot!.bot, config, isDualBot, initialContextStrings);
        this.registerEventBridges(this.botSlots[0].mcBot!.bot, config, isDualBot, uiConfig);

        // 5. Auto-follow player on spawn
        this.setupAutoFollow();
    }

    private resetSessionState(): void {
        this.followingPlayer = null;
        this.isReplying = false;
        this.currentReply = '';
        this.pendingNotes = [];
        this.pendingEvents = [];
    }

    private buildCompanionConfig(uiConfig: BotConfig): CompanionConfig {
        this.playerMcUsername = uiConfig.playerMcUsername || null;
        this.activeScenarioId = uiConfig.scenarioId;
        return {
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
    }

    /** Connect the primary MC bot. Returns false if connection failed (caller should abort). */
    private async connectPrimaryBot(config: CompanionConfig, uiConfig: BotConfig): Promise<boolean> {
        this.updateStatus({ mc: 'connecting' });
        this.addChat('system', 'System', `Connecting to MC ${config.mc.host}:${config.mc.port}...`);
        try {
            this.botSlots[0].mcBot = createMinecraftBot(config);
            await this.botSlots[0].mcBot.connect();
            initHomePosition(this.botSlots[0].mcBot.bot, config.mc.host, config.mc.port);
            loadCustomBlueprints();
            this.setupPluginChannel(this.botSlots[0].mcBot.bot, uiConfig.playerMcUsername);
            this.updateStatus({ mc: 'connected' });
            this.addChat('system', 'System', `Minecraft bot spawned as ${config.mc.username}`);
            this.toast('success', `Bot "${config.mc.username}" joined the Minecraft server!`);
            return true;
        } catch (err) {
            const message = humanizeError(err, 'Minecraft connection');
            this.updateStatus({ mc: 'error' });
            this.addChat('system', 'System', `MC connection failed: ${message}`);
            this.toast('error', message);
            return false;
        }
    }

    /** Connect the optional second MC bot and wire dual-bot spacing. Non-fatal on failure. */
    private async connectSecondaryBot(config: CompanionConfig, uiConfig: BotConfig): Promise<void> {
        this.updateStatus({ mc2: 'connecting' });
        const config2: CompanionConfig = {
            ...config,
            mc: { ...config.mc, username: uiConfig.secondMcUsername! },
        };
        try {
            this.botSlots[1].mcBot = createMinecraftBot(config2);
            await this.botSlots[1].mcBot.connect();
            initHomePosition(this.botSlots[1].mcBot.bot, config2.mc.host, config2.mc.port);
            this.setupPluginChannel(this.botSlots[1].mcBot.bot, uiConfig.playerMcUsername);
            this.updateStatus({ mc2: 'connected' });
            this.addChat('system', 'System', `Minecraft bot 2 spawned as ${config2.mc.username}`);
            this.toast('success', `Bot "${config2.mc.username}" joined the Minecraft server!`);
        } catch (err) {
            const message = humanizeError(err, 'Minecraft connection (bot 2)');
            this.updateStatus({ mc2: 'error' });
            this.addChat('system', 'System', `MC bot 2 connection failed: ${message}`);
            this.toast('error', message);
            // Continue with single-bot mode — don't abort the whole session
            this.botSlots[1].mcBot = null;
            return;
        }

        // Wire dual-bot spacing: each bot's pathfinder treats the other as
        // high-cost terrain. Bot 1 at 3 blocks, bot 2 at 5 — natural spacing.
        this.botSlots[0].mcBot!.setCompanion(this.botSlots[1].mcBot.bot);
        this.botSlots[1].mcBot.setCompanion(this.botSlots[0].mcBot!.bot);
        setFollowDistance(this.botSlots[0].mcBot!.bot, 3);
        setFollowDistance(this.botSlots[1].mcBot.bot, 5);
    }

    /** Fire-and-forget: dismount if the MC server remembers a vehicle from previous session */
    private async autoDismountOnSpawn(bot: MineflayerBot): Promise<void> {
        await new Promise((r) => setTimeout(r, 3000));
        const v = getVehicle(bot);
        console.log(`[MC] Auto-dismount check: vehicle=${v ? 'yes (id=' + v.id + ')' : 'no'}`);
        if (!v) return;

        this.autoDismounting = true;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const vehicle = getVehicle(bot);
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
    }

    /** Resolve character names, auto-detect player username, and populate the name registry */
    private resolvePlayersAndNames(
        bot: MineflayerBot,
        uiConfig: BotConfig,
        config: CompanionConfig,
        isDualBot: boolean,
    ): void {
        const character = this.characters.find((c) => c.id === uiConfig.characterId);
        this.botSlots[0].assistantName = character?.name ?? 'AI';
        this.activeCharacterId = uiConfig.characterId;

        if (isDualBot && uiConfig.secondCharacterId) {
            const char2 = this.characters.find((c) => c.id === uiConfig.secondCharacterId);
            this.botSlots[1].assistantName = char2?.name ?? 'AI2';
        } else {
            this.botSlots[1].assistantName = null;
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
        if (this.botSlots[0].assistantName && config.mc.username) {
            this.names.register(this.botSlots[0].assistantName, config.mc.username);
        }
        if (this.botSlots[1].assistantName && uiConfig.secondMcUsername) {
            this.names.register(this.botSlots[1].assistantName, uiConfig.secondMcUsername);
        }
    }

    /** Read initial world state for chat context. Returns labeled context strings. */
    private readInitialWorldContext(bot: MineflayerBot, config: CompanionConfig): string[] {
        try {
            const initialState = readWorldState(bot, config.perception.entityRange);
            const rawStrings = buildContextStrings(initialState, this.names, this.botSlots[0].assistantName);
            const contextStrings = rawStrings.map((s) => `[${this.botSlots[0].assistantName}] ${s}`);
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
            return contextStrings;
        } catch (err) {
            // Perception can fail during initial chunk loading
            console.error('[Perception] Initial context failed:', err);
            this.toast('warning', 'World perception failed during startup — context may be incomplete until next update.');
            return [];
        }
    }

    /** Start a Voxta chat session and wait for the session ID */
    private async startVoxtaChat(
        uiConfig: BotConfig,
        isDualBot: boolean,
        initialContextStrings: string[],
    ): Promise<void> {
        const characterIds = [uiConfig.characterId];
        if (isDualBot && uiConfig.secondCharacterId) {
            characterIds.push(uiConfig.secondCharacterId);
        }
        this.activeCharacterIds = characterIds;

        await this.voxta!.startChat(
            characterIds,
            uiConfig.chatId ?? undefined,
            uiConfig.scenarioId ?? undefined,
            {
                contextKey: CONTEXT_KEY_BOT1,
                contexts: initialContextStrings.map((text) => ({ text })),
                actions: this.getEnabledActions(),
            },
        );

        const chatStart = Date.now();
        while (!this.voxta!.sessionId && Date.now() - chatStart < SESSION_TIMEOUT_MS) {
            await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
        }

        this.updateStatus({
            sessionId: this.voxta!.sessionId,
            assistantName: this.botSlots[0].assistantName,
            assistantName2: this.botSlots[1].assistantName,
        });

        const sessionMsg = isDualBot && this.botSlots[1].assistantName
            ? `Chat started with ${this.botSlots[0].assistantName} & ${this.botSlots[1].assistantName}`
            : `Chat started with ${this.botSlots[0].assistantName}`;
        this.addChat('system', 'System', sessionMsg);
    }

    /** Create and wire up all perception, movement, spatial, and mode scan loops */
    private startAllLoops(
        bot: MineflayerBot,
        config: CompanionConfig,
        isDualBot: boolean,
        initialContextStrings: string[],
    ): void {
        const loopCallbacks = this.buildLoopCallbacks();
        const movementCallbacks = this.buildMovementCallbacks();

        const bot2 = this.botSlots[1].mcBot;
        const labels = ['Bot', 'Bot2'] as const;

        // Perception loops
        this.botSlots[0].perceptionLoop = createPerceptionLoop(
            bot, 1, config.perception.intervalMs, config.perception.entityRange,
            this.botSlots[0].assistantName ?? 'Bot', initialContextStrings, loopCallbacks,
        );
        if (isDualBot && bot2) {
            this.botSlots[1].perceptionLoop = createPerceptionLoop(
                bot2.bot, 2, config.perception.intervalMs, config.perception.entityRange,
                this.botSlots[1].assistantName ?? 'AI2', [], loopCallbacks,
            );
        }

        // Spatial audio
        this.spatialLoop = createSpatialLoop(loopCallbacks);

        // Mounted steering + Follow watchdog + Mode scan — both bots
        this.botSlots[0].mountedSteeringLoop = createMountedSteeringLoop(
            bot, () => !!this.botSlots[0].mcBot,
            isDualBot && bot2 ? bot2.bot : null,
            movementCallbacks,
        );
        this.botSlots[0].followWatchdog = createFollowWatchdog(bot, () => !!this.botSlots[0].mcBot, labels[0], movementCallbacks);

        if (isDualBot && bot2) {
            this.botSlots[1].mountedSteeringLoop = createMountedSteeringLoop(
                bot2.bot, () => !!this.botSlots[1].mcBot, bot,
                movementCallbacks,
            );
            this.botSlots[1].followWatchdog = createFollowWatchdog(bot2.bot, () => !!this.botSlots[1].mcBot, labels[1], movementCallbacks);
        }

        // Mode scan loops — both bots
        for (let i = 0; i < 2; i++) {
            const s = this.botSlots[i];
            if (!s.mcBot) continue;
            const { loop, flush } = createModeScanLoop(
                s.mcBot.bot, () => !!this.botSlots[i].mcBot, labels[i],
                () => this.botSlots[i].assistantName ?? labels[i],
                movementCallbacks,
            );
            s.modeScanLoop = loop;
            s.flushHuntBatch = flush;
        }

        // Proximity loop
        for (const s of this.botSlots) s.inRange = true;
        this.proximityLoop = createProximityLoop(isDualBot, loopCallbacks);
    }

    /** Create MC event bridges for bot 1 (and bot 2 if dual-bot mode) */
    private registerEventBridges(
        bot: MineflayerBot,
        config: CompanionConfig,
        isDualBot: boolean,
        uiConfig: BotConfig,
    ): void {
        const eventBridgeCallbacks = this.buildEventBridgeCallbacks();
        const botUsernames = new Set([
            config.mc.username,
            ...(isDualBot && uiConfig.secondMcUsername ? [uiConfig.secondMcUsername] : []),
        ]);

        this.botSlots[0].eventBridge = createEventBridge(bot, 1, this.names, botUsernames, eventBridgeCallbacks);

        if (isDualBot && this.botSlots[1].mcBot) {
            this.botSlots[1].eventBridge = createEventBridge(this.botSlots[1].mcBot.bot, 2, this.names, botUsernames, eventBridgeCallbacks);
        }
    }

    /** Auto-follow: companion(s) follow the player by default on spawn */
    private setupAutoFollow(): void {
        if (!this.playerMcUsername || !this.botSlots[0].mcBot) return;

        this.followingPlayer = this.playerMcUsername;
        const playerName = this.playerMcUsername;
        const botsToFollow = this.botSlots
            .filter((s) => s.mcBot)
            .map((s) => s.mcBot!.bot);
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
                        if (!this.slot(1).mcBot || this.followingPlayer !== playerName) return;
                        void executeAction(
                            botInstance,
                            'mc_follow_player',
                            [{ name: 'player_name', value: playerName }],
                            this.names,
                        ).catch((retryErr) => console.log(`[Bot] Auto-follow retry also failed:`, retryErr));
                    }, 2000);
                });
            }
        }, 1000);
    }

    /** Auto-resume a chat session after Voxta reconnection */
    private async autoResumeChat(): Promise<void> {
        if (!this.voxta || !this.activeCharacterId || !this.slot(1).mcBot) return;

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
            const bot = this.slot(1).mcBot!.bot;
            let initialContextStrings: string[] = [];
            try {
                const state = readWorldState(bot, 32);
                initialContextStrings = buildContextStrings(state, this.names, this.botSlots[0].assistantName);
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
            while (!this.voxta.sessionId && Date.now() - chatStart < SESSION_TIMEOUT_MS) {
                await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
            }

            this.updateStatus({
                sessionId: this.voxta.sessionId,
                assistantName: this.botSlots[0].assistantName,
                currentAction: null,
            });

            this.addChat('system', 'System', `Chat resumed with ${this.botSlots[0].assistantName}`);
            this.toast('success', `Chat resumed with ${this.botSlots[0].assistantName}!`);

            // Restart perception loop
            const loopCallbacks = this.buildLoopCallbacks();
            this.slot(1).perceptionLoop = createPerceptionLoop(
                bot, 1, 3000, 32,
                this.slot(1).assistantName ?? 'Bot', initialContextStrings, loopCallbacks,
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.addChat('system', 'System', `Auto-resume failed: ${message}`);
            this.toast('error', `Failed to resume chat: ${message}`);
        }
    }

    // ---- Loop cleanup ----

    /** Clear all interval loops — used during reconnection and session teardown */
    private clearAllLoops(): void {
        for (const s of this.botSlots) {
            for (const key of ['perceptionLoop', 'followWatchdog', 'mountedSteeringLoop', 'modeScanLoop'] as const) {
                if (s[key]) { clearInterval(s[key]); s[key] = null; }
            }
        }
        if (this.proximityLoop) { clearInterval(this.proximityLoop); this.proximityLoop = null; }
        if (this.spatialLoop) { clearInterval(this.spatialLoop); this.spatialLoop = null; }
    }

    /** Stop the current chat session and MC bot but keep the Voxta connection alive */
    async stopSession(): Promise<void> {
        this.clearAllLoops();

        // Destroy event bridges, stop audio, clear companions, disconnect bots
        this.audioPipeline.setRawAudioCallback(null);
        for (const s of this.botSlots) {
            if (s.eventBridge) { s.eventBridge.destroy(); s.eventBridge = null; }
            if (s.mcBot) {
                try { sendStopAudio(s.mcBot.bot); } catch { /* bot may already be gone */ }
                s.mcBot.setCompanion(null);
            }
        }

        if (this.botSlots[0].mcBot) {
            try { this.botSlots[0].mcBot.disconnect(); } catch { /* ignore */ }
        }
        if (this.botSlots[1].mcBot) {
            try { this.botSlots[1].mcBot.disconnect(); } catch { /* ignore */ }
        }

        // Clear all per-slot state
        for (const s of this.botSlots) {
            s.mcBot = null;
            s.assistantName = null;
            s.flushHuntBatch = null;
            s.inRange = true;
        }

        // End the Voxta chat session but keep the SignalR connection
        if (this.voxta?.sessionId) {
            try { await this.voxta.endSession(); } catch { /* session may already be closed */ }
        }

        // Reset session-related state
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
            paused: false,
        });
        this.isPaused = false;
        this.userWantsPause = false;

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
        for (const s of this.botSlots) s.flushHuntBatch?.();

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
            getAssistantName: () => this.slot(1).assistantName,
            getSettings: () => this.settings,
            isReplying: () => this.isReplying,
            getMcBot: () => this.slot(1).mcBot?.bot ?? null,
            getNames: () => this.names,
            getFollowingPlayer: () => this.followingPlayer,
            // Multi-bot routing
            getCharacterBotMap: () => this.characterBotMap,
            getBotBySlot: (slot) => this.slot(slot).mcBot?.bot ?? null,
            getAssistantNameBySlot: (slot) => this.slot(slot).assistantName,
            getLastSpeakingSlot: () => this.lastSpeakingSlot,
            setLastSpeakingSlot: (slot) => { this.lastSpeakingSlot = slot; },

            // State mutators
            setAssistantName: (name) => {
                this.slot(1).assistantName = name;
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
                this.slot(slot).mcBot?.setSkinUrl(url);
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
                    console.log(`[Bot >>] event (immediate, reply done): "${text.substring(0, LOG_PREVIEW_LENGTH)}"`);
                    void this.voxta?.sendEvent(text).catch((e) => this.logSendError('sendEvent', e));
                }
            },
            emit: (event, ...args) => this.emit(event as BotEngineEvent, ...args),
            mcChatEcho: (text) => {
                // Echo from the last-speaking bot's slot
                const echoBot = this.slot(this.lastSpeakingSlot).mcBot;
                if (echoBot && this.settings.enableBotChatEcho) {
                    const maxLen = 250;
                    for (let i = 0; i < text.length; i += maxLen) {
                        echoBot.bot.chat(text.substring(i, i + maxLen));
                    }
                }
            },
            setPaused: (paused) => { this.isPaused = paused; },
            isPaused: () => this.userWantsPause,
            getVoxtaClient: () => this.voxta,

            // Audio pipeline
            audioPipeline: this.audioPipeline,
        });
    }

    /** Pause or resume multi-character auto-continuation */
    async pauseChat(pause: boolean): Promise<void> {
        this.userWantsPause = pause;
        await this.voxta?.pauseChat(pause);
    }
}
