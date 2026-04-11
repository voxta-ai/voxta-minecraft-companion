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

/** Callbacks the event bridge setup uses to interact with BotEngine state */
export interface EventBridgeCallbacks {
    getVoxta(): VoxtaClient | null;
    getSettings(): McSettings;
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
                    console.log(`[${label} >>] event: "${text.substring(0, 80)}"`);
                    void callbacks.getVoxta()?.sendEvent(text);
                }
            },
            onUrgentEvent: (text) => {
                if (!callbacks.getVoxta()?.sessionId) return;
                callbacks.addChat('event', 'Event', text);
                // Interrupt current speech and server reply
                callbacks.audioPipeline.interrupt();
                callbacks.audioPipeline.fireAckNow();
                callbacks.emit('stop-audio');
                void callbacks.getVoxta()?.interrupt();
                callbacks.setIsReplying(false);
                callbacks.setCurrentReply('');
                // Send the urgent event immediately
                console.log(`[${label} >>] event (urgent): "${text.substring(0, 80)}"`);
                void callbacks.getVoxta()?.sendEvent(text);
            },
            onPlayerChat: slot === 1
                ? (text) => {
                    if (!callbacks.getVoxta()?.sessionId) return;
                    console.log(`[User >>] MC chat: "${text}"`);
                    resetActionFired();
                    callbacks.flushHuntBatch(1);
                    callbacks.flushHuntBatch(2);

                    if (callbacks.isReplying()) {
                        // Interrupt the current speech first, then send it after server settles
                        console.log('[User >>] MC chat during speech — interrupting first');
                        callbacks.audioPipeline.interrupt();
                        callbacks.audioPipeline.fireAckNow();
                        callbacks.setIsReplying(false);
                        callbacks.setCurrentReply('');
                        callbacks.clearPendingEvents();
                        // Give the server time to process the interrupt before sending
                        setTimeout(() => {
                            void callbacks.getVoxta()?.sendMessage(text);
                        }, 300);
                    } else {
                        void callbacks.getVoxta()?.sendMessage(text);
                    }
                }
                : () => {
                    // No-op — bot 1's bridge handles chat bridging
                },
            getSettings: () => callbacks.getSettings(),
            getAssistantName: () => callbacks.getAssistantName(slot) ?? label,
            isReplying: () => callbacks.isReplying(),
        },
        () => callbacks.getFollowingPlayer(),
        async (botInstance, mobName) => {
            // Skip auto-defense while mounted — can't fight from horseback
            const vehicleCheck = (botInstance as unknown as { vehicle: { id: number } | null }).vehicle;
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
                // Don't send redundant notes — "Already fighting" is noise,
                // "Stopped fighting" and "Died while fighting" are covered by the death event.
                const isNoise = result.startsWith('Already fighting')
                    || result.startsWith('Stopped fighting')
                    || result.startsWith('Died while fighting');
                if (!result) {
                    // Empty = creeper explosion — environmental note, no bot attribution
                    callbacks.addChat('note', 'Note', 'Creeper exploded nearby');
                    callbacks.queueNote('Creeper exploded nearby');
                } else if (!isNoise) {
                    callbacks.addChat('note', 'Note', `${botName}: ${result}`);
                    callbacks.queueNote(`${botName}: ${result}`);
                }
                console.log(`[${label}] Auto-defense attack result: ${result}`);
            } catch (err) {
                console.log(`[${label}] Auto-defense attack failed:`, err);
            } finally {
                // Return the bridge reference so caller can clear attacker
                console.log(
                    `[${label}] Auto-defense finished, followingPlayer=${callbacks.getFollowingPlayer()}, mcBot=${!!callbacks.getMcBot(slot)}`,
                );
                // Don't resume follow if combat is still active — another mc_attack is
                // running with GoalFollow(target). Overwriting it with GoalFollow(player)
                // would cause the bot to stop fighting and just absorb arrows.
                if (getCurrentCombatTarget(botInstance)) {
                    console.log(`[${label}] Combat still active (${getCurrentCombatTarget(botInstance)}), NOT overriding with follow`);
                } else if (getBotMode(botInstance) === 'guard') {
                    console.log(`[${label}] Guard mode — staying at post, not following`);
                } else if (callbacks.getFollowingPlayer() && callbacks.getMcBot(slot)) {
                    // Small delay: pathfinder.stop() in combat sets an internal
                    // "stopPathing" flag that takes one tick to clear. Without
                    // this delay, setGoal(null)+setGoal(follow) races with the
                    // async path reset and the bot appears stuck.
                    const playerToFollow = callbacks.getFollowingPlayer()!;
                    const mcBotRef = callbacks.getMcBot(slot);
                    setTimeout(() => {
                        if (callbacks.getFollowingPlayer() !== playerToFollow) return; // state changed
                        if (!mcBotRef) return;
                        const resumeResult = resumeFollowPlayer(mcBotRef.bot, playerToFollow, names);
                        console.log(`[${label}] Resumed following after defense: ${resumeResult}`);
                    }, 150);
                } else {
                    console.log(
                        `[${label}] NOT resuming follow — followingPlayer=${callbacks.getFollowingPlayer()}, mcBot=${!!callbacks.getMcBot(slot)}`,
                    );
                }
            }
        },
        botUsernames,
        skipChatBridging,
    );
}
