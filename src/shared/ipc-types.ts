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
    type: 'player' | 'ai' | 'system' | 'action';
    sender: string;
    text: string;
}

export interface ActionToggle {
    name: string;
    description: string;
    enabled: boolean;
    category: 'movement' | 'combat' | 'communication';
}

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

    // Main → Renderer
    STATUS_CHANGED: 'bot:status-changed',
    CHAT_MESSAGE: 'bot:chat-message',
    ACTION_TRIGGERED: 'bot:action-triggered',
    CHARACTERS_AVAILABLE: 'bot:characters-available',
} as const;
