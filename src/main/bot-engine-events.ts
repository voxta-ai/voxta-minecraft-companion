import type { Bot as MineflayerBot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { VoxtaClient } from '../bot/voxta/client';
import type { McSettings } from '../shared/ipc-types';
import type { AudioPipeline } from './audio-pipeline';
import type { MinecraftBot } from '../bot/minecraft/bot';
import { McEventBridge } from '../bot/minecraft/events';
import { executeAction, resumeFollowPlayer } from '../bot/minecraft/action-dispatcher';
import { getCurrentCombatTarget, getBotMode } from '../bot/minecraft/actions';
import { resetActionFired } from './action-orchestrator';
import { getVehicle } from '../bot/minecraft/mineflayer-types';

const LOG_PREVIEW_LENGTH = 80;
const INTERRUPT_SETTLE_DELAY_MS = 300; // Delay after interrupt before sending new message
const FOLLOW_RESUME_DELAY_MS = 150;    // Delay for pathfinder to clear before resuming follow

/** Callbacks the event bridge setup uses to interact with BotEngine state */
export interface EventBridgeCallbacks {
    getVoxta(): VoxtaClient | null;
    getSettings(): McSettings;
    getPlayerMcUsername(): string | null;
    getFollowingPlayer(): string | null;
    isReplying(): boolean;
    getAssistantName(slot: 1 | 2): string | null;
    getMcBot(slot: 1 | 2): MinecraftBot | null;
    addChat(type: 'player' | 'event' | 'note' | 'system', sender: string, text: string): void;
    queueNote(text: string): void;
    audioPipeline: AudioPipeline;
    emit(event: string, ...args: unknown[]): void;
    setIsReplying(value: boolean): void;
    setCurrentReply(text: string): void;
    clearPendingEvents(): void;
    flushHuntBatch(slot: 1 | 2): void;
}

// ---- Extracted callback handlers ----

/** Short reply constraints for urgent combat reactions */
const URGENT_CONSTRAINTS = { maxNewTokens: 30, maxSentences: 1 };

/** Handle urgent events: interrupt current speech, then send immediately */
function handleUrgentEvent(
    text: string,
    label: string,
    callbacks: EventBridgeCallbacks,
): void {
    if (!callbacks.getVoxta()?.sessionId) return;
    callbacks.addChat('event', 'Event', text);
    callbacks.audioPipeline.interrupt();
    callbacks.audioPipeline.fireAckNow();
    callbacks.emit('stop-audio');
    void callbacks.getVoxta()?.interrupt();
    callbacks.setIsReplying(false);
    callbacks.setCurrentReply('');
    console.log(`[${label} >>] event (urgent): "${text.substring(0, LOG_PREVIEW_LENGTH)}"`);
    void callbacks.getVoxta()?.sendEvent(text, true, URGENT_CONSTRAINTS);
}

/** Handle player chat from MC: interrupt if speaking, then forward to Voxta */
function handlePlayerChat(
    mcUsername: string,
    text: string,
    callbacks: EventBridgeCallbacks,
): void {
    if (!callbacks.getVoxta()?.sessionId) return;

    // If the sender is NOT the user, send as an event so the AI knows who's talking
    const playerMcUsername = callbacks.getPlayerMcUsername();
    if (playerMcUsername && mcUsername.toLowerCase() !== playerMcUsername.toLowerCase()) {
        console.log(`[Other >>] MC chat from ${mcUsername}: "${text}"`);
        void callbacks.getVoxta()?.sendEvent(`${mcUsername} says: ${text}`);
        return;
    }

    console.log(`[User >>] MC chat: "${text}"`);
    resetActionFired();
    callbacks.flushHuntBatch(1);
    callbacks.flushHuntBatch(2);

    if (callbacks.isReplying()) {
        console.log('[User >>] MC chat during speech — interrupting first');
        callbacks.audioPipeline.interrupt();
        callbacks.audioPipeline.fireAckNow();
        callbacks.setIsReplying(false);
        callbacks.setCurrentReply('');
        callbacks.clearPendingEvents();
        setTimeout(() => {
            void callbacks.getVoxta()?.sendMessage(text);
        }, INTERRUPT_SETTLE_DELAY_MS);
    } else {
        void callbacks.getVoxta()?.sendMessage(text);
    }
}

/** Auto-defense: execute attack, report result, and resume follow after combat ends */
async function handleAutoDefense(
    botInstance: MineflayerBot,
    mobName: string,
    slot: 1 | 2,
    names: NameRegistry,
    callbacks: EventBridgeCallbacks,
): Promise<void> {
    const label = slot === 1 ? 'Bot' : 'Bot2';
    const vehicleCheck = getVehicle(botInstance);
    if (vehicleCheck) {
        console.log(`[${label}] Skipping auto-defense against ${mobName} — mounted on vehicle`);
        return;
    }
    const botName = callbacks.getAssistantName(slot) ?? label;
    console.log(`[${label}] Auto-defense started against ${mobName}, followingPlayer=${callbacks.getFollowingPlayer()}`);
    try {
        const result = await executeAction(
            botInstance,
            'mc_attack',
            [{ name: 'entity_name', value: mobName }],
            names,
        );
        const isNoise = result.startsWith('Already fighting')
            || result.startsWith('Stopped fighting')
            || result.startsWith('Died while fighting');
        // When aggro/hunt/guard mode is active, those systems report kills via
        // their own batched handleCombatResult — skip here to avoid duplicates
        const mode = getBotMode(botInstance);
        const modeHandlesReporting = mode !== 'passive';
        if (!result) {
            callbacks.addChat('note', 'Note', 'Creeper exploded nearby');
            callbacks.queueNote('Creeper exploded nearby');
        } else if (!isNoise && !modeHandlesReporting) {
            callbacks.addChat('note', 'Note', `${botName}: ${result}`);
            callbacks.queueNote(`${botName}: ${result}`);
        }
        console.log(`[${label}] Auto-defense attack result: ${result}`);
    } catch (err) {
        console.log(`[${label}] Auto-defense attack failed:`, err);
    } finally {
        resumeFollowAfterDefense(botInstance, slot, label, names, callbacks);
    }
}

/** Resume following the player after auto-defense ends (if appropriate) */
function resumeFollowAfterDefense(
    botInstance: MineflayerBot,
    slot: 1 | 2,
    label: string,
    names: NameRegistry,
    callbacks: EventBridgeCallbacks,
): void {
    console.log(
        `[${label}] Auto-defense finished, followingPlayer=${callbacks.getFollowingPlayer()}, mcBot=${!!callbacks.getMcBot(slot)}`,
    );
    if (getCurrentCombatTarget(botInstance)) {
        console.log(`[${label}] Combat still active (${getCurrentCombatTarget(botInstance)}), NOT overriding with follow`);
    } else if (getBotMode(botInstance) === 'guard') {
        console.log(`[${label}] Guard mode — staying at post, not following`);
    } else if (callbacks.getFollowingPlayer() && callbacks.getMcBot(slot)) {
        const playerToFollow = callbacks.getFollowingPlayer()!;
        const mcBotRef = callbacks.getMcBot(slot);
        setTimeout(() => {
            if (callbacks.getFollowingPlayer() !== playerToFollow) return;
            if (!mcBotRef) return;
            const resumeResult = resumeFollowPlayer(mcBotRef.bot, playerToFollow, names);
            console.log(`[${label}] Resumed following after defense: ${resumeResult}`);
        }, FOLLOW_RESUME_DELAY_MS);
    } else {
        console.log(
            `[${label}] NOT resuming follow — followingPlayer=${callbacks.getFollowingPlayer()}, mcBot=${!!callbacks.getMcBot(slot)}`,
        );
    }
}

// ---- Main factory ----

/**
 * Creates and wires up a McEventBridge for a bot slot.
 * Bot 1 handles chat bridging for both bots; bot 2 skips it.
 */
export function createEventBridge(
    bot: MineflayerBot,
    slot: 1 | 2,
    names: NameRegistry,
    botUsernames: Set<string>,
    callbacks: EventBridgeCallbacks,
): McEventBridge {
    const label = slot === 1 ? 'Bot' : 'Bot2';
    const skipChatBridging = slot === 2;

    return new McEventBridge(
        bot,
        names,
        {
            onChat: (type, sender, text) => {
                if (!callbacks.getVoxta()?.sessionId) return;
                callbacks.addChat(type as 'player' | 'event' | 'note' | 'system', sender, text);
            },
            onNote: (text) => {
                if (!callbacks.getVoxta()?.sessionId) return;
                callbacks.queueNote(text);
            },
            onEvent: (text) => {
                if (!callbacks.getVoxta()?.sessionId) return;
                callbacks.addChat('event', 'Event', text);
                if (callbacks.isReplying()) {
                    callbacks.queueNote(text);
                } else {
                    console.log(`[${label} >>] event: "${text.substring(0, LOG_PREVIEW_LENGTH)}"`);
                    void callbacks.getVoxta()?.sendEvent(text);
                }
            },
            onUrgentEvent: (text) => handleUrgentEvent(text, label, callbacks),
            onPlayerChat: slot === 1
                ? (mcUsername, text) => handlePlayerChat(mcUsername, text, callbacks)
                : () => {},
            getSettings: () => callbacks.getSettings(),
            getAssistantName: () => callbacks.getAssistantName(slot) ?? label,
            isReplying: () => callbacks.isReplying(),
        },
        () => callbacks.getFollowingPlayer(),
        (botInstance, mobName) => handleAutoDefense(botInstance, mobName, slot, names, callbacks),
        botUsernames,
        skipChatBridging,
    );
}
