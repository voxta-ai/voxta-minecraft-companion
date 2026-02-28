// ============================================================
// Voxta WebSocket protocol types — minimal subset for the
// Minecraft companion. Modeled after the C# and TS sources in
// src/common/Voxta.Model and src/web/libs/voxta-client.
// ============================================================

// ---- Shared ----

export interface ContextDefinition {
    text: string;
    name?: string;
    disabled?: boolean;
    flagsFilter?: string;
    roleFilter?: string;
}

export type FunctionArgumentType = 'Undefined' | 'String' | 'Integer' | 'Double' | 'Boolean';

export interface FunctionArgumentDefinition {
    name: string;
    type: FunctionArgumentType;
    description?: string;
    required?: boolean;
}

export interface ActionEffect {
    setFlags?: string[];
    clearFlags?: string[];
}

export type FunctionTiming = 'AfterUserMessage' | 'BeforeAssistantMessage' | 'AfterAssistantMessage' | 'Manual' | 'Button' | 'AfterAnyMessage';

export interface ScenarioAction {
    name: string;
    description: string;
    disabled: boolean;
    layer: string;
    arguments: FunctionArgumentDefinition[];
    timing?: FunctionTiming;
    effect: ActionEffect;
    shortDescription?: string;
    cancelReply?: boolean;
    finalLayer?: boolean;
    once?: boolean;
    flagsFilter?: string;
}

export interface ActionInvocationArgument {
    name: string;
    value: string;
}

// ---- Client → Server messages ----

export interface ClientAuthenticateMessage {
    $type: 'authenticate';
    client: string;
    clientVersion?: string;
    scope: string[];
    capabilities: {
        audioOutput?: string;
        acceptedAudioContentTypes?: string[];
        audioInput?: string;
        visionCapture?: string;
        visionSources?: string[];
    };
}

export interface ClientRegisterAppMessage {
    $type: 'registerApp';
    clientVersion?: string;
    iconBase64Url?: string;
    label?: string;
}

export interface ClientStartChatMessage {
    $type: 'startChat';
    characterId?: string;
    chatId?: string;
    scenarioId?: string;
}

export interface ClientSendMessage {
    $type: 'send';
    sessionId: string;
    text?: string;
    doReply?: boolean;
    doUserActionInference?: boolean;
    doCharacterActionInference?: boolean;
}

export interface ClientUpdateContextMessage {
    $type: 'updateContext';
    sessionId: string;
    contextKey?: string;
    contexts?: ContextDefinition[];
    actions?: ScenarioAction[];
    variables?: Record<string, unknown>;
    setFlags?: string[];
    enableRoles?: Record<string, boolean>;
}

export interface ClientInterruptMessage {
    $type: 'interrupt';
    sessionId: string;
}

export interface ClientSpeechPlaybackStartMessage {
    $type: 'speechPlaybackStart';
    sessionId: string;
    messageId: string;
    startIndex: number;
    endIndex: number;
    duration: number;
    isNarration?: boolean;
}

export interface ClientSpeechPlaybackCompleteMessage {
    $type: 'speechPlaybackComplete';
    sessionId: string;
    messageId: string;
}

export type ClientMessage =
    | ClientAuthenticateMessage
    | ClientRegisterAppMessage
    | ClientStartChatMessage
    | ClientSendMessage
    | ClientUpdateContextMessage
    | ClientInterruptMessage
    | ClientSpeechPlaybackStartMessage
    | ClientSpeechPlaybackCompleteMessage;

// ---- Server → Client messages ----

export interface ServerWelcomeMessage {
    $type: 'welcome';
    user: { name: string };
    characters?: Array<{ id: string; name: string }>;
    assistant?: { id: string; name: string };
}

export interface ServerAuthenticationRequiredMessage {
    $type: 'authenticationRequired';
}

export interface ServerChatStartingMessage {
    $type: 'chatStarting';
}

export interface ServerChatStartedMessage {
    $type: 'chatStarted';
    chatId: string;
    sessionId: string;
    characters: Array<{ id: string; name: string }>;
}

export interface ServerReplyStartMessage {
    $type: 'replyStart';
    sessionId: string;
    messageId: string;
    senderId: string;
}

export interface ServerReplyChunkMessage {
    $type: 'replyChunk';
    sessionId: string;
    messageId: string;
    senderId: string;
    startIndex: number;
    endIndex: number;
    text: string;
    audioUrl: string;
    isNarration: boolean;
}

export interface ServerReplyEndMessage {
    $type: 'replyEnd';
    sessionId: string;
    messageId: string;
    senderId: string;
}

export interface ServerActionMessage {
    $type: 'action';
    sessionId: string;
    value: string;
    arguments?: ActionInvocationArgument[];
}

export interface ServerErrorMessage {
    $type: 'error';
    message: string;
    details?: string;
}

export interface ServerVisionCaptureRequestMessage {
    $type: 'visionCaptureRequest';
    sessionId: string;
    visionCaptureRequestId: string;
    source: string;
}

export type ServerMessage =
    | ServerWelcomeMessage
    | ServerAuthenticationRequiredMessage
    | ServerChatStartingMessage
    | ServerChatStartedMessage
    | ServerReplyStartMessage
    | ServerReplyChunkMessage
    | ServerReplyEndMessage
    | ServerActionMessage
    | ServerErrorMessage
    | ServerVisionCaptureRequestMessage
    | { $type: string;[key: string]: unknown };
