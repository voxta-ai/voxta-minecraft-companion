// ============================================================
// IPC channel types shared between main, preload, and renderer
// ============================================================

export interface BotConfig {
    mcHost: string;
    mcPort: number;
    mcUsername: string;
    mcVersion: string;
    playerMcUsername: string;
    voxtaUrl: string;
    voxtaApiKey: string;
    perceptionIntervalMs: number;
    entityRange: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BotStatus {
    mc: ConnectionStatus;
    voxta: ConnectionStatus;
    position: { x: number; y: number; z: number } | null;
    health: number | null;
    currentAction: string | null;
    assistantName: string | null;
    sessionId: string | null;
}

export interface ChatMessage {
    id: string;
    timestamp: number;
    type: 'player' | 'ai' | 'system' | 'action' | 'event';
    sender: string;
    text: string;
}

export interface ActionToggle {
    name: string;
    description: string;
    enabled: boolean;
    category: 'movement' | 'combat' | 'communication';
}

// ---- Settings (Toggle Groups) ----

export interface McSettings {
    // Actions — what the AI can command
    enableFollowPlayer: boolean;
    enableGoTo: boolean;
    enableLookAt: boolean;
    enableStop: boolean;
    enableMineBlock: boolean;
    enableAttack: boolean;
    enableSay: boolean;
    enableEquip: boolean;
    enableGiveItem: boolean;
    enableCollectItems: boolean;

    // Events — AI reacts with a reply
    enableEventDamage: boolean;
    enableEventDeath: boolean;
    enableEventUnderAttack: boolean;
    enableEventPlayerNearby: boolean;
    enableEventMobNearby: boolean;

    // Telemetry — AI sees as notes, no reply
    enableTelemetryItemPickup: boolean;
    enableTelemetryActionResults: boolean;
    enableTelemetryWeather: boolean;
    enableTelemetryTime: boolean;
    enableTelemetryChat: boolean;
}

export const DEFAULT_SETTINGS: McSettings = {
    enableFollowPlayer: true,
    enableGoTo: true,
    enableLookAt: true,
    enableStop: true,
    enableMineBlock: true,
    enableAttack: true,
    enableSay: true,
    enableEquip: true,
    enableGiveItem: true,
    enableCollectItems: true,

    enableEventDamage: true,
    enableEventDeath: true,
    enableEventUnderAttack: true,
    enableEventPlayerNearby: false,
    enableEventMobNearby: false,

    enableTelemetryItemPickup: true,
    enableTelemetryActionResults: true,
    enableTelemetryWeather: false,
    enableTelemetryTime: false,
    enableTelemetryChat: true,
};

export interface CharacterInfo {
    id: string;
    name: string;
}

// ---- IPC Channels ----

export const IPC_CHANNELS = {
    // Renderer → Main
    CONNECT: 'bot:connect',
    DISCONNECT: 'bot:disconnect',
    START_CHAT: 'bot:start-chat',
    SEND_MESSAGE: 'bot:send-message',
    GET_STATUS: 'bot:get-status',
    TOGGLE_ACTION: 'bot:toggle-action',
    GET_ACTIONS: 'bot:get-actions',
    UPDATE_SETTINGS: 'bot:update-settings',

    // Main → Renderer
    STATUS_CHANGED: 'bot:status-changed',
    CHAT_MESSAGE: 'bot:chat-message',
    ACTION_TRIGGERED: 'bot:action-triggered',
    CHARACTERS_AVAILABLE: 'bot:characters-available',
} as const;

