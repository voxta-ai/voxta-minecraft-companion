import * as signalR from '@microsoft/signalr';
import { MinecraftCompanionIconBase64Url } from './minecraft-icon.js';
import type { CompanionConfig } from '../config.js';
import type {
    ClientMessage,
    ClientStartChatMessage,
    ContextDefinition,
    ScenarioAction,
    ServerMessage,
    ServerWelcomeMessage,
    ServerChatStartedMessage,
} from './types.js';

type MessageHandler = (message: ServerMessage) => void;

export class VoxtaClient {
    private connection: signalR.HubConnection;
    private handlers: MessageHandler[] = [];
    private closeHandlers: Array<() => void> = [];
    private reconnectingHandlers: Array<() => void> = [];
    private reconnectedHandlers: Array<() => void> = [];
    private _sessionId: string | null = null;
    private _chatId: string | null = null;
    private _authenticated = false;
    private _characterAppConfigs: Map<string, Record<string, string>> = new Map();

    get sessionId(): string | null {
        return this._sessionId;
    }

    get chatId(): string | null {
        return this._chatId;
    }

    get authenticated(): boolean {
        return this._authenticated;
    }

    get characterAppConfigs(): Map<string, Record<string, string>> {
        return this._characterAppConfigs;
    }

    /** Convenience getter — app config of the first (primary) character */
    get characterAppConfig(): Record<string, string> | undefined {
        return this._characterAppConfigs.values().next().value;
    }

    constructor(private config: CompanionConfig) {
        const hubOptions: signalR.IHttpConnectionOptions = {};
        if (config.voxta.apiKey) {
            console.log(`[Voxta] API key present (${config.voxta.apiKey.length} chars)`);
            hubOptions.accessTokenFactory = () => config.voxta.apiKey;
        } else {
            console.log('[Voxta] No API key configured');
        }

        this.connection = new signalR.HubConnectionBuilder()
            .withUrl(config.voxta.url, hubOptions)
            .withAutomaticReconnect([1000, 1000, 2000, 2000, 5000, 5000, 5000, 10000, 10000, 10000])
            .configureLogging(signalR.LogLevel.Information)
            .build();

        this.connection.on('ReceiveMessage', (message: ServerMessage) => {
            this.handleMessage(message);
        });

        this.connection.onreconnecting(() => {
            console.log('[Voxta] Reconnecting...');
            this._authenticated = false;
            this._sessionId = null;
            for (const handler of this.reconnectingHandlers) handler();
        });

        this.connection.onreconnected(() => {
            console.log('[Voxta] Reconnected, re-authenticating...');
            void this.authenticate();
            for (const handler of this.reconnectedHandlers) handler();
        });

        this.connection.onclose(() => {
            console.log('[Voxta] Connection closed');
            this._authenticated = false;
            this._sessionId = null;
            this._chatId = null;
            for (const handler of this.closeHandlers) handler();
        });
    }

    onMessage(handler: MessageHandler): void {
        this.handlers.push(handler);
    }

    onClose(handler: () => void): void {
        this.closeHandlers.push(handler);
    }

    onReconnecting(handler: () => void): void {
        this.reconnectingHandlers.push(handler);
    }

    onReconnected(handler: () => void): void {
        this.reconnectedHandlers.push(handler);
    }

    private handleMessage(message: ServerMessage): void {
        if (message.$type === 'welcome') {
            this._authenticated = true;
            const welcome = message as ServerWelcomeMessage;
            console.log(`[Voxta] Welcome, ${welcome.user.name}!`);
            if (welcome.assistant) {
                console.log(`[Voxta] Default assistant: ${welcome.assistant.name} (${welcome.assistant.id})`);
            }
        } else if (message.$type === 'authenticationRequired') {
            console.log('[Voxta] Authentication required — please create a profile in Voxta first.');
        } else if (message.$type === 'chatStarted') {
            const started = message as ServerChatStartedMessage;
            this._sessionId = started.sessionId;
            this._chatId = started.chatId;
            // Capture each character's app configuration (e.g. skin asset) keyed by character ID
            this._characterAppConfigs.clear();
            for (const char of started.characters) {
                if (char.appConfiguration) {
                    this._characterAppConfigs.set(char.id, char.appConfiguration);
                    if (char.appConfiguration.skin) {
                        console.log(`[Voxta] Character ${char.name} skin asset: ${char.appConfiguration.skin}`);
                    }
                }
            }
            console.log(`[Voxta] Chat started (session: ${started.sessionId}, chat: ${started.chatId})`);
            // Enable inspector so contextUpdated includes contexts & actions
            void this.send({ $type: 'inspect', enabled: true, sessionId: started.sessionId });
        } else if (message.$type === 'error') {
            console.error(`[Voxta] Error: ${(message as { message: string }).message}`);
        }

        for (const handler of this.handlers) {
            handler(message);
        }
    }

    async connect(): Promise<void> {
        console.log(`[Voxta] Connecting to ${this.config.voxta.url}...`);
        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                await this.connection.start();
                console.log('[Voxta] Connected');
                break;
            } catch {
                if (attempt < 29) {
                    console.log(`[Voxta] Connection attempt ${attempt + 1} failed, retrying...`);
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                } else {
                    throw new Error('[Voxta] Failed to connect after 30 attempts');
                }
            }
        }

        await this.authenticate();
    }

    private async authenticate(): Promise<void> {
        await this.send({
            $type: 'authenticate',
            client: this.config.voxta.clientName,
            clientVersion: this.config.voxta.clientVersion,
            scope: ['role:app'],
            capabilities: {
                audioOutput: 'Url',
                audioInput: 'WebSocketStream',
                visionCapture: 'PostImage',
                visionSources: ['Screen'],
            },
        });
    }

    async send(message: ClientMessage): Promise<void> {
        try {
            await this.connection.send('SendMessage', message);
        } catch (e) {
            console.error('[Voxta] Error sending message:', e);
        }
    }

    async registerApp(): Promise<void> {
        await this.send({
            $type: 'registerApp',
            clientVersion: this.config.voxta.clientVersion,
            iconBase64Url: MinecraftCompanionIconBase64Url,
            label: 'Minecraft Companion',
            characterForm: {
                fields: [
                    {
                        $type: 'bool',
                        name: 'enabled',
                        label: 'Minecraft Ready',
                        text: 'Mark this character as designed for Minecraft gameplay',
                        defaultValue: false,
                    },
                    {
                        $type: 'asset',
                        name: 'skin',
                        label: 'Minecraft Skin',
                        text: 'A 64×64 skin PNG for the bot in Minecraft (requires SkinsRestorer on the server)',
                        contentTypes: ['image/*'],
                        noneLabel: 'Default (Steve)',
                    },
                ],
            },
        });
        console.log('[Voxta] App registered');
    }

    async startChat(
        characterIds: string[],
        chatId?: string,
        scenarioId?: string,
        initialContext?: { contextKey: string; contexts: ContextDefinition[]; actions?: ScenarioAction[] },
    ): Promise<void> {
        const message: ClientStartChatMessage = {
            $type: 'startChat',
            // Use the array form for multi-char sessions, single-char form for backward compat
            ...(characterIds.length === 1
                ? { characterId: characterIds[0] }
                : { characterIds }),
            chatId,
            scenarioId,
            contextKey: initialContext?.contextKey,
            contexts: initialContext?.contexts,
            actions: initialContext?.actions,
        };
        await this.send(message);
    }

    async sendMessage(text: string): Promise<void> {
        if (!this._sessionId) {
            console.warn('[Voxta] Cannot send message — no active session');
            return;
        }
        // Match VoxtaTalk: only send doReply + doCharacterActionInference.
        // User vs afterChar timing is controlled by the action's `timing` field
        // in the scenario definition, NOT by a doUserActionInference flag.
        await this.send({
            $type: 'send',
            sessionId: this._sessionId,
            text,
            doReply: true,
            doCharacterActionInference: true,
        });
    }

    /** Send a non-intrusive note — AI sees it but does NOT reply, not shown as a user message */
    async sendNote(text: string): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'send',
            sessionId: this._sessionId,
            text: `/note ${text}`,
            doReply: false,
            doUserActionInference: false,
            doCharacterActionInference: false,
        });
    }

    /** Send an event that triggers the AI to reply, not shown as a user message */
    async sendEvent(text: string, doActionInference = true): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'send',
            sessionId: this._sessionId,
            text: `/event ${text}`,
            doReply: true,
            doUserActionInference: false,
            doCharacterActionInference: doActionInference,
        });
    }

    async updateContext(contextKey: string, contexts: ContextDefinition[], actions?: ScenarioAction[]): Promise<void> {
        if (!this._sessionId) {
            return;
        }
        await this.send({
            $type: 'updateContext',
            sessionId: this._sessionId,
            contextKey,
            contexts,
            actions,
        });
    }

    /** Add a character to the active session (proximity re-join) */
    async addChatParticipant(characterId: string): Promise<void> {
        if (!this._sessionId) return;
        await this.send({ $type: 'addChatParticipant', sessionId: this._sessionId, characterId });
    }

    /** Remove a character from the active session (proximity silence) */
    async removeChatParticipant(characterId: string): Promise<void> {
        if (!this._sessionId) return;
        await this.send({ $type: 'removeChatParticipant', sessionId: this._sessionId, characterId });
    }

    /** Tell the server we started playing a speech chunk */
    async speechPlaybackStart(
        messageId: string,
        startIndex: number,
        endIndex: number,
        duration: number,
        isNarration?: boolean,
    ): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'speechPlaybackStart',
            sessionId: this._sessionId,
            messageId,
            startIndex,
            endIndex,
            duration,
            isNarration,
        });
    }

    /** Tell the server we finished playing a speech chunk */
    async speechPlaybackComplete(messageId: string): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'speechPlaybackComplete',
            sessionId: this._sessionId,
            messageId,
        });
    }

    /** Tell the server to interrupt the currently playing reply */
    async interrupt(): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'interrupt',
            sessionId: this._sessionId,
        });
    }

    /** End the current chat session without closing the SignalR connection */
    async endSession(): Promise<void> {
        if (this._sessionId) {
            await this.send({
                $type: 'stopChat',
                sessionId: this._sessionId,
            });
            this._sessionId = null;
        }
    }

    async disconnect(): Promise<void> {
        await this.connection.stop();
    }
}
