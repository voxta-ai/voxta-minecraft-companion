// ============================================================
// IPC channel types shared between main, preload, and renderer
// ============================================================

import type { ActionCategory } from '../bot/minecraft/action-definitions';

// Phase 1: connect to Voxta only
export interface VoxtaConnectConfig {
    voxtaUrl: string;
    voxtaApiKey: string;
}

// Phase 1 response
export interface VoxtaInfo {
    userName: string;
    characters: CharacterInfo[];
    defaultAssistantId: string | null;
}

// Phase 2: launch the MC bot + start chat
export interface BotConfig {
    mcHost: string;
    mcPort: number;
    mcUsername: string;
    mcVersion: string;
    playerMcUsername: string;
    characterId: string;
    scenarioId: string | null;
    chatId: string | null;
    perceptionIntervalMs: number;
    entityRange: number;
    // Second bot (optional — dual-bot mode)
    secondMcUsername?: string;
    secondCharacterId?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BotStatus {
    mc: ConnectionStatus;
    mc2: ConnectionStatus;
    voxta: ConnectionStatus;
    position: { x: number; y: number; z: number } | null;
    health: number | null;
    food: number | null;
    position2: { x: number; y: number; z: number } | null;
    health2: number | null;
    food2: number | null;
    currentAction: string | null;
    assistantName: string | null;
    assistantName2: string | null;
    sessionId: string | null;
    paused: boolean;
}

export interface ChatMessage {
    id: string;
    timestamp: number;
    type: 'player' | 'ai' | 'system' | 'action' | 'event' | 'note';
    sender: string;
    text: string;
    repeatCount?: number;
    badge?: string;
}

export interface ActionToggle {
    name: string;
    description: string;
    enabled: boolean;
    category: ActionCategory;
}

// ---- Settings (Toggle Groups) ----

export type VisionMode = 'off' | 'screen' | 'eyes';
export type ActionInferenceTiming = 'user' | 'afterChar';

export interface McSettings {
    // Events — AI reacts with a reply
    enableEventDamage: boolean;
    enableEventDeath: boolean;
    enableEventUnderAttack: boolean;
    enableEventPlayerNearby: boolean;
    enableEventMobNearby: boolean;

    // Notes — AI sees as context, no reply
    enableNoteItemPickup: boolean;
    enableNoteWeather: boolean;
    enableNoteTime: boolean;
    enableNoteChat: boolean;

    // Voice chance (0-100%) — probability that action results trigger a voiced reply
    voiceChanceMovement: number;
    voiceChanceSurvival: number;
    voiceChanceCombat: number;
    voiceChanceInteraction: number;

    // Bot behavior
    enableBotChatEcho: boolean;
    enableAutoLook: boolean;
    enableAutoDefense: boolean;
    enableAutoTorch: boolean;
    visionMode: VisionMode;
    actionInferenceTiming: ActionInferenceTiming;

    // Action inference system prompt addon
    actionInferencePrompt: string;

    // Audio effects
    enableSpatialAudio: boolean;
    spatialNearDistance: number;  // Full volume within this range (blocks)
    spatialMaxDistance: number;   // Silent beyond this range (blocks)
    enableReverb: boolean;
    reverbAmount: number;         // 0-100 wet/dry mix
    reverbDecay: number;          // 0-100 decay length
    enableEcho: boolean;
    echoDelay: number;            // 100-500 ms
    echoDecay: number;            // 0-100 feedback amount
}

export const DEFAULT_SETTINGS: McSettings = {
    enableEventDamage: true,
    enableEventDeath: true,
    enableEventUnderAttack: true,
    enableEventPlayerNearby: false,
    enableEventMobNearby: false,

    enableNoteItemPickup: true,
    enableNoteWeather: false,
    enableNoteTime: false,
    enableNoteChat: true,

    voiceChanceMovement: 20,
    voiceChanceSurvival: 50,
    voiceChanceCombat: 50,
    voiceChanceInteraction: 30,

    enableBotChatEcho: true,
    enableAutoLook: true,
    enableAutoDefense: true,
    enableAutoTorch: true,
    visionMode: 'off',
    actionInferenceTiming: 'afterChar',

    actionInferencePrompt: 'Before selecting eat, give, or equip actions, check the inventory in the updated context. Only eat, give, or equip items that are currently listed in the inventory.',

    enableSpatialAudio: false,
    spatialNearDistance: 5,
    spatialMaxDistance: 32,
    enableReverb: false,
    reverbAmount: 30,
    reverbDecay: 50,
    enableEcho: false,
    echoDelay: 200,
    echoDecay: 30,
};

export interface CharacterInfo {
    id: string;
    name: string;
    /** True if the character has Minecraft Companion app configuration */
    hasMcConfig: boolean;
}

export interface ChatListItem {
    id: string;
    title: string | null;
    created: string;
    lastSession: string | null;
    lastSessionTimestamp: string | null;
    favorite: boolean;
    scenarioId: string | null;
}

export interface ScenarioInfo {
    id: string;
    name: string;
    /** The app client this scenario is built for (e.g. 'Voxta.Minecraft') */
    client: string | null;
}

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastMessage {
    id: string;
    type: ToastType;
    message: string;
    durationMs?: number;
}

// ---- Audio Playback IPC ----

export interface AudioChunk {
    url: string;
    messageId: string;
    startIndex: number;
    endIndex: number;
    isNarration?: boolean;
}

export interface AudioPlaybackEvent {
    messageId: string;
    startIndex: number;
    endIndex: number;
    duration: number;
    isNarration?: boolean;
}

// ---- Audio Input IPC ----

export interface RecordingStartEvent {
    sessionId: string;
    voxtaBaseUrl: string;
    voxtaApiKey: string | null;
}

// ---- Spatial Audio ----

export interface SpatialPosition {
    botX: number;
    botY: number;
    botZ: number;
    playerX: number;
    playerY: number;
    playerZ: number;
    playerYaw: number;
}

// ---- Server Manager ----

export type ServerState = 'not-installed' | 'idle' | 'starting' | 'running' | 'stopping' | 'error';

// ---- Tunnel Manager ----

export type TunnelState = 'not-installed' | 'installing' | 'idle' | 'starting' | 'claim-needed' | 'running' | 'stopping' | 'error';

export interface TunnelStatus {
    state: TunnelState;
    tunnelUrl: string | null;
    claimUrl: string | null;
    error?: string;
}

export interface ServerStatus {
    state: ServerState;
    port: number;
    error?: string;
}

export interface ServerConsoleLine {
    timestamp: number;
    text: string;
    level: 'info' | 'warn' | 'error';
}

export interface SetupProgress {
    step: number;
    totalSteps: number;
    label: string;
    bytesDownloaded?: number;
    bytesTotal?: number;
}

export interface PluginInfo {
    name: string;
    fileName: string;
    fileSize: number;
    installed: boolean;
    /** Hangar origin tracking (only present for plugins installed via Hangar) */
    hangarOwner?: string;
    hangarSlug?: string;
    installedVersion?: string;
}

export interface PluginUpdateInfo {
    fileName: string;
    hangarOwner: string;
    hangarSlug: string;
    installedVersion: string;
    latestVersion: string;
    latestChannel: { name: string; color: string };
    compatible: boolean;
    supportedMcVersions: string[];
}

export interface CatalogPlugin {
    id: string;
    name: string;
    description: string;
    downloadUrl: string;
    fileName: string;
}

// ---- Hangar Plugin Store ----

export interface HangarSearchResult {
    pagination: { count: number; limit: number; offset: number };
    result: HangarProject[];
}

export interface HangarProject {
    name: string;
    description: string;
    namespace: { owner: string; slug: string };
    stats: { downloads: number; recentDownloads: number; stars: number };
    category: string;
    lastUpdated: string;
    avatarUrl: string;
    mainPageContent?: string | null;
    supportedPlatforms?: Record<string, string[]>;
}

export interface HangarProjectDetail extends HangarProject {
    mainPageContent: string | null;
    settings: {
        links: Array<{ id: number; type: string; title: string; links: Array<{ name: string; url: string }> }>;
        tags: string[];
        license: { name: string; url: string; type: string } | null;
        keywords: string[];
    };
}

export interface HangarVersion {
    name: string;
    description: string;
    stats: { totalDownloads: number };
    channel: { name: string; color: string };
    downloads: Record<string, {
        fileInfo: { name: string; sizeBytes: number } | null;
        externalUrl: string | null;
        downloadUrl: string | null;
    }>;
    platformDependencies: Record<string, string[]>;
}

export interface WorldInfo {
    name: string;
    directory: string;
    isActive: boolean;
    sizeBytes: number;
    backupCount: number;
}

export interface WorldBackup {
    id: string;
    worldName: string;
    timestamp: number;
    sizeBytes: number;
}

export type ServerProperties = Record<string, string>;

export interface ServerConfig {
    memoryMb: number;
    autoStart: boolean;
}

// ---- Player Management ----

export interface WhitelistEntry {
    uuid: string;
    name: string;
}

export interface OpsEntry {
    uuid: string;
    name: string;
    level: number;
    bypassesPlayerLimit: boolean;
}

// ---- Console Log ----

export type ConsoleLogLevel = 'log' | 'warn' | 'error';

export interface ConsoleLogEntry {
    timestamp: number;
    level: ConsoleLogLevel;
    text: string;
}

// ---- Inspector Data ----

export interface InspectorAction {
    name: string;
    description: string;
    layer?: string;
}

export interface InspectorContext {
    contextKey?: string;
    name: string;
    text: string;
}

export interface InspectorData {
    contexts: InspectorContext[];
    actions: InspectorAction[];
}

// ---- IPC Channels ----

export const IPC_CHANNELS = {
    // Renderer → Main
    CONNECT_VOXTA: 'bot:connect-voxta',
    LAUNCH_BOT: 'bot:launch-bot',
    DISCONNECT: 'bot:disconnect',
    STOP_SESSION: 'bot:stop-session',
    SEND_MESSAGE: 'bot:send-message',
    GET_STATUS: 'bot:get-status',
    TOGGLE_ACTION: 'bot:toggle-action',
    GET_ACTIONS: 'bot:get-actions',
    UPDATE_SETTINGS: 'bot:update-settings',
    CYCLE_VISION_WINDOW: 'bot:cycle-vision-window',
    LOAD_CHATS: 'bot:load-chats',
    LOAD_SCENARIOS: 'bot:load-scenarios',
    FAVORITE_CHAT: 'bot:favorite-chat',
    DELETE_CHAT: 'bot:delete-chat',
    REFRESH_CHARACTERS: 'bot:refresh-characters',
    PAUSE_CHAT: 'bot:pause-chat',

    // Main → Renderer
    STATUS_CHANGED: 'bot:status-changed',
    CHAT_MESSAGE: 'bot:chat-message',
    CLEAR_CHAT: 'bot:clear-chat',
    INSPECTOR_UPDATE: 'bot:inspector-update',
    ACTION_TRIGGERED: 'bot:action-triggered',
    TOAST: 'bot:toast',
    PLAY_AUDIO: 'bot:play-audio',
    STOP_AUDIO: 'bot:stop-audio',
    RECORDING_START: 'bot:recording-start',
    RECORDING_STOP: 'bot:recording-stop',
    SPEECH_PARTIAL: 'bot:speech-partial',
    SPATIAL_POSITION: 'bot:spatial-position',

    // Renderer → Main (audio ack)
    AUDIO_STARTED: 'bot:audio-started',
    AUDIO_COMPLETE: 'bot:audio-complete',
    LOG: 'bot:log',
    CONSOLE_LOG: 'bot:console-log',

    // Server Manager: Renderer → Main
    SERVER_GET_INSTALLED_VERSION: 'server:get-installed-version',
    SERVER_GET_VERSIONS: 'server:get-versions',
    SERVER_SETUP: 'server:setup',
    SERVER_IS_INSTALLED: 'server:is-installed',
    SERVER_START: 'server:start',
    SERVER_STOP: 'server:stop',
    SERVER_SEND_COMMAND: 'server:send-command',
    SERVER_GET_STATUS: 'server:get-status',
    SERVER_GET_PROPERTIES: 'server:get-properties',
    SERVER_SAVE_PROPERTIES: 'server:save-properties',
    SERVER_GET_PLUGINS: 'server:get-plugins',
    SERVER_GET_CATALOG: 'server:get-catalog',
    SERVER_INSTALL_PLUGIN: 'server:install-plugin',
    SERVER_REMOVE_PLUGIN: 'server:remove-plugin',
    SERVER_HANGAR_SEARCH: 'server:hangar-search',
    SERVER_HANGAR_PROJECT: 'server:hangar-project',
    SERVER_HANGAR_VERSIONS: 'server:hangar-versions',
    SERVER_HANGAR_INSTALL: 'server:hangar-install',
    SERVER_CHECK_PLUGIN_UPDATES: 'server:check-plugin-updates',
    SERVER_GET_WORLDS: 'server:get-worlds',
    SERVER_SET_ACTIVE_WORLD: 'server:set-active-world',
    SERVER_RENAME_WORLD: 'server:rename-world',
    SERVER_DELETE_WORLD: 'server:delete-world',
    SERVER_CREATE_WORLD: 'server:create-world',
    SERVER_GET_CONFIG: 'server:get-config',
    SERVER_SAVE_CONFIG: 'server:save-config',
    SERVER_BACKUP_WORLD: 'server:backup-world',
    SERVER_GET_BACKUPS: 'server:get-backups',
    SERVER_RESTORE_BACKUP: 'server:restore-backup',
    SERVER_DELETE_BACKUP: 'server:delete-backup',
    SERVER_GET_WHITELIST: 'server:get-whitelist',
    SERVER_ADD_WHITELIST: 'server:add-whitelist',
    SERVER_REMOVE_WHITELIST: 'server:remove-whitelist',
    SERVER_GET_OPS: 'server:get-ops',
    SERVER_ADD_OP: 'server:add-op',
    SERVER_REMOVE_OP: 'server:remove-op',

    // Server Manager: Main → Renderer
    SERVER_STATUS_CHANGED: 'server:status-changed',
    SERVER_CONSOLE_LINE: 'server:console-line',
    SERVER_SETUP_PROGRESS: 'server:setup-progress',

    // Tunnel Manager: Renderer → Main
    TUNNEL_GET_STATUS: 'tunnel:get-status',
    TUNNEL_IS_INSTALLED: 'tunnel:is-installed',
    TUNNEL_INSTALL: 'tunnel:install',
    TUNNEL_START: 'tunnel:start',
    TUNNEL_STOP: 'tunnel:stop',
    TUNNEL_SET_URL: 'tunnel:set-url',

    // Tunnel Manager: Main → Renderer
    TUNNEL_STATUS_CHANGED: 'tunnel:status-changed',
} as const;
