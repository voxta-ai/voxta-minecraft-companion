import * as signalR from '@microsoft/signalr';
import type { CompanionConfig } from '../config.js';
import type {
    ClientMessage,
    ClientStartChatMessage,
    ContextDefinition,
    ScenarioAction,
    ServerMessage,
    ServerWelcomeMessage,
    ServerChatStartedMessage,
    ServerActionMessage,
    ServerReplyChunkMessage,
    ServerReplyEndMessage,
} from './types.js';

type MessageHandler = (message: ServerMessage) => void;

export class VoxtaClient {
    private connection: signalR.HubConnection;
    private handlers: MessageHandler[] = [];
    private _sessionId: string | null = null;
    private _authenticated = false;

    get sessionId(): string | null {
        return this._sessionId;
    }

    get authenticated(): boolean {
        return this._authenticated;
    }

    constructor(private config: CompanionConfig) {
        const hubOptions: signalR.IHttpConnectionOptions = {};
        if (config.voxta.apiKey) {
            hubOptions.accessTokenFactory = () => config.voxta.apiKey;
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
        });

        this.connection.onreconnected(() => {
            console.log('[Voxta] Reconnected, re-authenticating...');
            void this.authenticate();
        });

        this.connection.onclose(() => {
            console.log('[Voxta] Connection closed');
            this._authenticated = false;
        });
    }

    onMessage(handler: MessageHandler): void {
        this.handlers.push(handler);
    }

    private handleMessage(message: ServerMessage): void {
        if (message.$type === 'welcome') {
            this._authenticated = true;
            const welcome = message as ServerWelcomeMessage;
            console.log(`[Voxta] Welcome, ${welcome.user.name}!`);
            if (welcome.assistant) {
                console.log(`[Voxta] Assistant: ${welcome.assistant.name} (${welcome.assistant.id})`);
            }
        } else if (message.$type === 'authenticationRequired') {
            console.log('[Voxta] Authentication required — please create a profile in Voxta first.');
        } else if (message.$type === 'chatStarted') {
            const started = message as ServerChatStartedMessage;
            this._sessionId = started.sessionId;
            console.log(`[Voxta] Chat started (session: ${started.sessionId})`);
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
            label: 'Minecraft Companion',
        });
        console.log('[Voxta] App registered');
    }

    async startChat(characterId: string, chatId?: string): Promise<void> {
        const message: ClientStartChatMessage = {
            $type: 'startChat',
            characterId,
            chatId,
        };
        await this.send(message);
    }

    async sendMessage(text: string): Promise<void> {
        if (!this._sessionId) {
            console.warn('[Voxta] Cannot send message — no active session');
            return;
        }
        await this.send({
            $type: 'send',
            sessionId: this._sessionId,
            text,
            doReply: true,
            doUserActionInference: true,
            doCharacterActionInference: true,
        });
    }

    /** Send a non-intrusive note — AI sees it but does NOT reply, not shown as user message */
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

    /** Send an event that triggers the AI to reply, not shown as user message */
    async sendEvent(text: string): Promise<void> {
        if (!this._sessionId) return;
        await this.send({
            $type: 'send',
            sessionId: this._sessionId,
            text: `/event ${text}`,
            doReply: true,
            doUserActionInference: false,
            doCharacterActionInference: true,
        });
    }

    async updateContext(
        contexts: ContextDefinition[],
        actions?: ScenarioAction[],
    ): Promise<void> {
        if (!this._sessionId) {
            return;
        }
        await this.send({
            $type: 'updateContext',
            sessionId: this._sessionId,
            contextKey: 'minecraft',
            contexts,
            actions,
        });
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

    async disconnect(): Promise<void> {
        await this.connection.stop();
    }
}
