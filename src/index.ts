import { loadConfig } from './config.js';
import { createMinecraftBot } from './minecraft/bot.js';
import { readWorldState, buildContextStrings } from './minecraft/perception.js';
import { MINECRAFT_ACTIONS, executeAction } from './minecraft/actions.js';
import { VoxtaClient } from './voxta/client.js';
import type { ServerMessage, ServerActionMessage, ServerWelcomeMessage, ServerReplyChunkMessage } from './voxta/types.js';

async function main(): Promise<void> {
    const config = loadConfig();

    console.log('=== Voxta Minecraft Companion ===');
    console.log(`MC: ${config.mc.host}:${config.mc.port} as "${config.mc.username}" (v${config.mc.version})`);
    console.log(`Voxta: ${config.voxta.url}`);
    console.log('');

    // ---- 1. Connect Mineflayer bot to Minecraft ----
    console.log('[Startup] Connecting to Minecraft...');
    const mcBot = createMinecraftBot(config);
    await mcBot.connect();
    console.log('[Startup] Minecraft bot ready!');

    const bot = mcBot.bot;

    // ---- 2. Connect to Voxta ----
    console.log('[Startup] Connecting to Voxta...');
    const voxta = new VoxtaClient(config);

    let assistantId: string | null = null;
    let currentReply = '';

    voxta.onMessage((message: ServerMessage) => {
        switch (message.$type) {
            case 'welcome': {
                const welcome = message as ServerWelcomeMessage;
                if (welcome.assistant) {
                    assistantId = welcome.assistant.id;
                }
                break;
            }
            case 'replyChunk': {
                const chunk = message as ServerReplyChunkMessage;
                currentReply += chunk.text;
                break;
            }
            case 'replyEnd': {
                if (currentReply.trim()) {
                    // Bot speaks the AI reply in Minecraft chat
                    const chatMessage = currentReply.trim();
                    // MC chat has a 256 char limit, split long messages
                    const maxLen = 250;
                    for (let i = 0; i < chatMessage.length; i += maxLen) {
                        const chunk = chatMessage.substring(i, i + maxLen);
                        bot.chat(chunk);
                    }
                    console.log(`[AI → MC] ${chatMessage}`);
                }
                currentReply = '';
                break;
            }
            case 'action': {
                const action = message as ServerActionMessage;
                console.log(`[AI Action] ${action.value}`, action.arguments ?? '');

                void executeAction(bot, action.value, action.arguments).then((result) => {
                    console.log(`[AI Action Result] ${result}`);
                });
                break;
            }
        }
    });

    await voxta.connect();

    // Wait for authentication
    await waitForCondition(() => voxta.authenticated, 15000, 'Voxta authentication');

    // ---- 3. Register app ----
    await voxta.registerApp();

    // ---- 4. Start chat ----
    if (assistantId) {
        console.log(`[Startup] Starting chat with assistant (${assistantId})...`);
        await voxta.startChat(assistantId);

        // Wait for session to be established
        await waitForCondition(() => voxta.sessionId !== null, 15000, 'Chat session');
        console.log(`[Startup] Chat session active: ${voxta.sessionId}`);
    } else {
        console.warn('[Startup] No assistant character configured in Voxta. Please set one up in the Voxta UI.');
        console.warn('[Startup] The bot will still run but won\'t have AI chat until a character is assigned.');
    }

    // ---- 5. Register MC actions with Voxta ----
    await voxta.updateContext(
        [{ text: 'The user is playing Minecraft. You are their AI companion bot inside the game world. You can see the world around you and perform actions.' }],
        MINECRAFT_ACTIONS,
    );
    console.log(`[Startup] Registered ${MINECRAFT_ACTIONS.length} Minecraft actions with Voxta`);

    // ---- 6. Start perception loop ----
    let lastContextHash = '';

    const perceptionLoop = setInterval(() => {
        if (!voxta.sessionId) return;

        try {
            const state = readWorldState(bot, config.perception.entityRange);
            const contextStrings = buildContextStrings(state);
            const contextHash = contextStrings.join('|');

            // Only push when context actually changed
            if (contextHash !== lastContextHash) {
                lastContextHash = contextHash;
                void voxta.updateContext(
                    contextStrings.map((text) => ({ text })),
                );
            }
        } catch (err) {
            // Perception can fail during respawn/chunk loading — silently retry
        }
    }, config.perception.intervalMs);

    // ---- 7. Bridge MC chat → Voxta ----
    bot.on('chat', (username, message) => {
        if (username === bot.username) return; // Ignore own messages
        if (!voxta.sessionId) return;

        console.log(`[MC → AI] <${username}> ${message}`);
        void voxta.sendMessage(`[${username} says in Minecraft chat]: ${message}`);
    });

    bot.on('whisper', (username, message) => {
        if (username === bot.username) return;
        if (!voxta.sessionId) return;

        console.log(`[MC → AI] <${username} whispers> ${message}`);
        void voxta.sendMessage(`[${username} whispers in Minecraft]: ${message}`);
    });

    // ---- 8. Announce arrival ----
    bot.chat('Hello! I\'m your Voxta AI companion. Talk to me!');

    // ---- Graceful shutdown ----
    const shutdown = async (): Promise<void> => {
        console.log('\n[Shutdown] Shutting down...');
        clearInterval(perceptionLoop);
        bot.chat('Goodbye!');
        mcBot.disconnect();
        await voxta.disconnect();
        process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    console.log('');
    console.log('=== Companion is running! ===');
    console.log('Press Ctrl+C to stop.');
}

async function waitForCondition(
    condition: () => boolean,
    timeoutMs: number,
    label: string,
): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout waiting for ${label} (${timeoutMs}ms)`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
