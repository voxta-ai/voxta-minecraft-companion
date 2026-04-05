import type {
    ServerActionMessage,
    ServerReplyChunkMessage,
    ServerWelcomeMessage,
    ServerVisionCaptureRequestMessage,
    ServerRecordingRequestMessage,
    ServerMessage,
} from '../bot/voxta/types';
import type { ChatMessage, McSettings, RecordingStartEvent, InspectorData } from '../shared/ipc-types';
import type { AudioPipeline } from './audio-pipeline';
import type { VoxtaClient } from '../bot/voxta/client';
import type { Bot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { CharacterInfo } from '../shared/ipc-types';
import { handleVisionCaptureRequest } from './vision-capture';
import { handleActionMessage } from './action-orchestrator';

// ---- Context passed to each handler ----

export interface MessageHandlerContext {
    // State accessors
    getVoxta(): VoxtaClient | null;
    getVoxtaUrl(): string | null;
    getVoxtaApiKey(): string | null;
    getAssistantName(): string | null;
    getSettings(): McSettings;
    isReplying(): boolean;
    getMcBot(): Bot | null;
    getNames(): NameRegistry;
    getFollowingPlayer(): string | null;

    // State mutators
    setAssistantName(name: string | null): void;
    setVoxtaUserName(name: string | null): void;
    setDefaultAssistantId(id: string | null): void;
    setCharacters(chars: CharacterInfo[]): void;
    setCurrentReply(text: string): void;
    appendCurrentReply(text: string): void;
    getCurrentReply(): string;
    setIsReplying(value: boolean): void;
    setFollowingPlayer(player: string | null): void;

    // Actions
    addChat(type: ChatMessage['type'], sender: string, text: string, badge?: string): void;
    updateStatus(patch: Record<string, unknown>): void;
    flushPendingNotes(): void;
    flushPendingEvents(): void;
    queueNote(text: string): void;
    queueEvent(text: string): void;
    emit(event: string, ...args: unknown[]): void;
    mcChatEcho(text: string): void;

    // Audio pipeline
    audioPipeline: AudioPipeline;
}

// ---- Individual handler types ----

type MessageHandler = (message: ServerMessage, ctx: MessageHandlerContext) => void;

// ---- Handler implementations ----

function handleWelcome(message: ServerMessage, ctx: MessageHandlerContext): void {
    const welcome = message as ServerWelcomeMessage;
    ctx.setCharacters((welcome.characters ?? []).map((c) => ({ id: c.id, name: c.name })));
    ctx.setVoxtaUserName(welcome.user?.name ?? null);
    if (welcome.assistant) {
        ctx.setDefaultAssistantId(welcome.assistant.id);
    }
}

function handleChatStarting(_message: ServerMessage, ctx: MessageHandlerContext): void {
    ctx.emit('clear-chat');
}

function handleChatStarted(message: ServerMessage, ctx: MessageHandlerContext): void {
    const started = message as {
        messages?: Array<{
            senderId: string;
            role: string;
            text: string;
            name?: string;
        }>;
        characters?: Array<{ id: string; name: string }>;
    };

    // Set the assistant name from the server's authoritative character data
    if (started.characters?.length) {
        const assistantChar = started.characters[0];
        ctx.setAssistantName(assistantChar.name);
    }

    if (started.messages && started.messages.length > 0) {
        for (const m of started.messages) {
            if (!m.text?.trim()) continue;
            if (m.role === 'User') {
                ctx.addChat('player', m.name ?? 'You', m.text);
            } else if (m.role === 'Assistant') {
                const char = started.characters?.find((c) => c.id === m.senderId);
                ctx.addChat('ai', char?.name ?? ctx.getAssistantName() ?? 'AI', m.text);
            }
        }
        console.log(`[Server] chatStarted — loaded ${started.messages.length} old messages`);
    }
}

function handleReplyStart(_message: ServerMessage, ctx: MessageHandlerContext): void {
    ctx.audioPipeline.resetChain();
}

function handleReplyGenerating(_message: ServerMessage, ctx: MessageHandlerContext): void {
    console.log('[<< AI] generating reply...');
    ctx.setIsReplying(true);
}

function handleReplyChunk(message: ServerMessage, ctx: MessageHandlerContext): void {
    const chunk = message as ServerReplyChunkMessage;
    ctx.appendCurrentReply(chunk.text);
    console.log(`[<< AI] "${chunk.text.substring(0, 60)}..."`);

    const voxta = ctx.getVoxta();
    if (voxta) {
        ctx.audioPipeline.processReplyChunk(
            chunk,
            voxta,
            ctx.getVoxtaUrl() ?? 'http://localhost:5384',
            ctx.getVoxtaApiKey(),
        );
    }
}

function handleReplyEnd(message: ServerMessage, ctx: MessageHandlerContext): void {
    const currentReply = ctx.getCurrentReply();
    console.log(`[<< AI] reply complete (${currentReply.trim().length} chars)`);

    if (currentReply.trim()) {
        const chatText = currentReply.trim();
        ctx.addChat('ai', ctx.getAssistantName() ?? 'AI', chatText);
        ctx.mcChatEcho(chatText);
    }

    ctx.setCurrentReply('');
    ctx.setIsReplying(false);
    ctx.flushPendingNotes();
    ctx.flushPendingEvents();

    // Sentinel: set a callback that fires when all pending chunks complete
    const endMsg = message as { messageId?: string; sessionId?: string };
    const endMsgId = endMsg.messageId;
    const voxta = ctx.getVoxta();
    if (endMsgId && voxta?.sessionId) {
        ctx.audioPipeline.setSentinel(() => {
            console.log(`[<< AI] playback complete for ${endMsgId}`);
            void voxta.speechPlaybackComplete(endMsgId);
        });
    }
}

function handleReplyCancelled(_message: ServerMessage, ctx: MessageHandlerContext): void {
    const currentReply = ctx.getCurrentReply();
    console.log(`[<< AI] reply cancelled (${currentReply.length} chars buffered)`);

    if (currentReply.trim()) {
        ctx.addChat('ai', ctx.getAssistantName() ?? 'AI', currentReply.trim());
    }
    ctx.setCurrentReply('');
    ctx.setIsReplying(false);
    ctx.flushPendingNotes();
    ctx.flushPendingEvents();
    ctx.audioPipeline.fireAckNow();
}

function handleAction(message: ServerMessage, ctx: MessageHandlerContext): void {
    const bot = ctx.getMcBot();
    if (!bot) return;

    handleActionMessage(message as ServerActionMessage, bot, ctx.getNames(), {
        getAssistantName: () => ctx.getAssistantName() ?? 'Bot',
        getSettings: () => ctx.getSettings(),
        isReplying: () => ctx.isReplying(),
        getFollowingPlayer: () => ctx.getFollowingPlayer(),
        setFollowingPlayer: (p) => ctx.setFollowingPlayer(p),
        addChat: (type, sender, text, badge) => ctx.addChat(type, sender, text, badge),
        updateCurrentAction: (a) => ctx.updateStatus({ currentAction: a }),
        queueNote: (text) => ctx.queueNote(text),
        sendNoteNow: (text) => {
            const voxta = ctx.getVoxta();
            if (voxta) {
                console.log(`[Bot >>] note (immediate): "${text.substring(0, 80)}"`);
                void voxta.sendNote(text);
            }
        },
        queueEvent: (text) => {
            console.log(`[Bot >>] queuing event for after reply: "${text.substring(0, 80)}"`);
            ctx.queueEvent(text);
        },
        getVoxta: () => ctx.getVoxta(),
    });
}

function handleInterruptSpeech(_message: ServerMessage, ctx: MessageHandlerContext): void {
    console.log('[Server] interruptSpeech — stopping audio playback');
    ctx.audioPipeline.interrupt();
    ctx.emit('stop-audio');
}

function handleChatFlow(message: ServerMessage): void {
    const state = (message as { state?: string }).state;
    console.log(`[Server] chatFlow: ${state}`);
}

function handleSpeechRecognitionStart(_message: ServerMessage, ctx: MessageHandlerContext): void {
    console.log('[User >>] speaking... (stopping audio)');
    ctx.audioPipeline.interrupt();
    ctx.emit('stop-audio');
    ctx.audioPipeline.fireAckNow();
}

function handleSpeechRecognitionEnd(message: ServerMessage, ctx: MessageHandlerContext): void {
    const text = (message as { text?: string }).text;
    console.log(`[User >>] said: "${text ?? '(empty)'}"`);
    if (text) {
        ctx.addChat('player', `You (voice)`, text);
        void ctx.getVoxta()?.sendMessage(text);
    }
}

function handleVisionCaptureRequestMsg(message: ServerMessage, ctx: MessageHandlerContext): void {
    if (ctx.getSettings().visionMode === 'off') {
        console.log('[Vision] Capture request received but vision is disabled in settings');
        return;
    }
    const visionReq = message as ServerVisionCaptureRequestMessage;
    const baseUrl = (ctx.getVoxtaUrl() ?? 'http://localhost:5384/hub').replace(/\/hub\/?$/, '');
    console.log(`[Vision] Received capture request: ${visionReq.visionCaptureRequestId} (source: ${visionReq.source})`);
    void handleVisionCaptureRequest(visionReq, baseUrl, ctx.getVoxtaApiKey(), ctx.getSettings().visionMode);
}

function handleRecordingRequest(message: ServerMessage, ctx: MessageHandlerContext): void {
    const req = message as ServerRecordingRequestMessage;
    const baseUrl = (ctx.getVoxtaUrl() ?? 'http://localhost:5384/hub').replace(/\/hub\/?$/, '');
    if (req.enabled) {
        console.log('[Recording] Server requested recording START');
        const event: RecordingStartEvent = {
            sessionId: req.sessionId,
            voxtaBaseUrl: baseUrl,
            voxtaApiKey: ctx.getVoxtaApiKey(),
        };
        ctx.emit('recording-start', event);
    } else {
        console.log('[Recording] Server requested recording STOP');
        ctx.emit('recording-stop');
    }
}

function handleContextUpdated(message: ServerMessage, ctx: MessageHandlerContext): void {
    const msgData = message as {
        contexts?: Array<{ contextKey: string; name: string; text: string }>;
        actions?: Array<{ name: string; description: string; layer?: string }>;
    };
    const inspectorData: InspectorData = {
        contexts: (msgData.contexts ?? []).map((c) => ({ name: c.name, text: c.text })),
        actions: (msgData.actions ?? []).map((a) => ({ name: a.name, description: a.description, layer: a.layer })),
    };
    ctx.emit('inspector-update', inspectorData);
}

// ---- Handler registry ----
// Adding a new message type = adding one entry here + one handler function above.

const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
    welcome: handleWelcome,
    chatStarting: handleChatStarting,
    chatStarted: handleChatStarted,
    replyStart: handleReplyStart,
    replyGenerating: handleReplyGenerating,
    replyChunk: handleReplyChunk,
    replyEnd: handleReplyEnd,
    replyCancelled: handleReplyCancelled,
    action: handleAction,
    interruptSpeech: handleInterruptSpeech,
    chatFlow: handleChatFlow,
    speechRecognitionStart: handleSpeechRecognitionStart,
    speechRecognitionEnd: handleSpeechRecognitionEnd,
    visionCaptureRequest: handleVisionCaptureRequestMsg,
    recordingRequest: handleRecordingRequest,
    contextUpdated: handleContextUpdated,
};

// Quiet message types — don't log these to avoid console noise
const QUIET_MESSAGES = new Set(['replyChunk', 'speechRecognitionPartial', 'memoryUpdated', 'contextUpdated']);

/**
 * Route a Voxta server message to the appropriate handler.
 * Unknown message types are silently ignored (future-proof).
 */
export function dispatchVoxtaMessage(message: ServerMessage, ctx: MessageHandlerContext): void {
    const msgType = message.$type;

    // Trace incoming messages (skip noisy ones)
    if (!QUIET_MESSAGES.has(msgType)) {
        console.log(`[Server] ${msgType}`);
    }

    const handler = MESSAGE_HANDLERS[msgType];
    if (handler) {
        handler(message, ctx);
    }
}
