import type { Bot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { ActionCategory } from '../bot/minecraft/action-definitions';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, setFishCaughtCallback } from '../bot/minecraft/action-dispatcher';
import { isActionBusy, getCurrentActivity } from '../bot/minecraft/actions';
import { isAutoDefending, getBotMode, setBotMode } from '../bot/minecraft/actions/action-state.js';
import type { VoxtaClient } from '../bot/voxta/client';
import type { ServerActionMessage } from '../bot/voxta/types';
import type { McSettings, ChatMessage } from '../shared/ipc-types';

export interface ActionOrchestratorCallbacks {
    getAssistantName(): string;
    getSettings(): McSettings;
    isReplying(): boolean;
    getFollowingPlayer(): string | null;
    setFollowingPlayer(player: string | null): void;
    addChat(type: ChatMessage['type'], sender: string, text: string, badge?: string): void;
    updateCurrentAction(action: string | null): void;
    queueNote(text: string): void;
    /** Send a note immediately, bypassing the isReplying queue */
    sendNoteNow(text: string): void;
    /** Queue an event to be sent after the current reply finishes */
    queueEvent(text: string): void;
    getVoxta(): VoxtaClient | null;
}

/**
 * Handles action execution, follow-resume logic, and voice-chance
 * feedback. Extracted from BotEngine to keep the orchestration
 * logic self-contained.
 */

// Reentrance guard: only one action per user turn. Resets when the user
// sends a new message (voice, text, or MC chat). Prevents action result →
// AI reply → new action inference → spam loops.
let actionFiredThisTurn = false;

/** Call when the user sends a new message (voice/text/MC chat) */
export function resetActionFired(): void {
    actionFiredThisTurn = false;
}

export function handleActionMessage(
    action: ServerActionMessage,
    bot: Bot,
    names: NameRegistry,
    callbacks: ActionOrchestratorCallbacks,
): void {
    const actionName = action.value?.trim() ?? '';
    const timing = callbacks.getSettings().actionInferenceTiming;
    console.log(
        `[<< AI] action (${timing}): ${actionName}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`,
    );

    // Ignore empty actions (AI sometimes sends action () with no name)
    if (!actionName) {
        callbacks.updateCurrentAction(null);
        return;
    }

    // Ignore duplicate long-running actions — the LLM sometimes re-triggers the same
    // action when the user says "keep going" or "you're doing great", which would abort
    // the current operation and restart from scratch.
    const LONG_RUNNING_ACTIONS = ['mc_mine_block', 'mc_fish', 'mc_craft', 'mc_cook'];
    if (LONG_RUNNING_ACTIONS.includes(actionName) && isActionBusy() && getCurrentActivity()) {
        console.log(`[Bot] Ignoring duplicate ${actionName} — already busy with: ${getCurrentActivity()}`);
        return;
    }

    // Skip AI-generated combat actions only when auto-defense is actively fighting.
    // We do NOT block based on mode alone — the user may explicitly ask the bot to
    // attack a specific target (e.g. "kill that pig") even while hunt/guard is active.
    const COMBAT_ACTIONS = ['mc_attack', 'mc_go_to_entity'];
    if (COMBAT_ACTIONS.includes(actionName) && isAutoDefending()) {
        console.log(`[Bot] Ignoring ${actionName} — auto-defense is actively fighting`);
        return;
    }

    // Reentrance guard: only one real action per user turn.
    // mc_none is exempt (it's a no-op that doesn't cause feedback loops).
    if (actionName !== 'mc_none' && actionFiredThisTurn) {
        console.log(`[Bot] Ignoring ${actionName} — action already fired this turn`);
        return;
    }
    if (actionName !== 'mc_none') {
        actionFiredThisTurn = true;
    }

    const timingLabel = timing === 'user' ? 'before reply' : 'after reply';
    callbacks.updateCurrentAction(actionName);
    callbacks.addChat(
        'action',
        'Action',
        `${actionName}(${action.arguments?.map((a) => `${a.name}=${a.value}`).join(', ') ?? ''})`,
        timingLabel,
    );

    // Track follow state
    if (actionName === 'mc_follow_player') {
        const playerArg = action.arguments?.find((a) => a.name.toLowerCase() === 'player_name');
        // Strip LLM type annotations like 'string="Lapiro' → 'Lapiro'
        let rawVal = playerArg?.value ?? '';
        const eqIdx = rawVal.lastIndexOf('=');
        if (eqIdx >= 0) rawVal = rawVal.slice(eqIdx + 1);
        rawVal = rawVal.replace(/"/g, '').trim();
        callbacks.setFollowingPlayer(rawVal || null);
        // AI explicitly chose "follow player" — switch out of hunt/guard so the
        // mode scan doesn't immediately override with a new attack target.
        if (getBotMode() !== 'passive') {
            const prevMode = getBotMode();
            console.log(`[Bot] mc_follow_player: auto-switching from ${prevMode} to passive`);
            setBotMode('passive');
            callbacks.addChat('note', 'Note', `Exited ${prevMode} mode to follow ${rawVal}.`);
        }
    } else if (actionName === 'mc_stop' || actionName === 'mc_go_home' || actionName === 'mc_go_to') {
        callbacks.setFollowingPlayer(null);
    }

    // Notify AI about long-running actions so it knows what's happening
    if (actionName === 'mc_fish') {
        const botName = callbacks.getAssistantName();
        const fishMsg = `${botName} is now casting the fishing rod and fishing.`;
        callbacks.addChat('note', 'Note', fishMsg);
        callbacks.queueNote(`${fishMsg} ${botName} is the one holding the rod and waiting for a bite.`);
        // Set a per-catch callback using the survival voice chance slider
        setFishCaughtCallback((itemName, count) => {
            const fishBotName = callbacks.getAssistantName();
            const msg = `${fishBotName} caught ${count} ${itemName} while fishing!`;
            const voiceChance = getVoiceChance(callbacks.getSettings(), 'survival');
            const roll = Math.random() * 100;
            if (roll < voiceChance && !callbacks.isReplying()) {
                void callbacks.getVoxta()?.sendEvent(msg);
            } else {
                callbacks.queueNote(msg);
            }
            callbacks.addChat('note', 'Note', msg);
        });
    }

    // Notify AI that the bot is heading home to its bed/respawn point
    if (actionName === 'mc_go_home') {
        const botName = callbacks.getAssistantName();
        const msg = `${botName} is heading home to the bed where the respawn point is set.`;
        callbacks.addChat('note', 'Note', msg);
        callbacks.queueNote(msg);
    }

    // Notify AI that the bot started mining
    if (actionName === 'mc_mine_block') {
        const botName = callbacks.getAssistantName();
        const blockArg = action.arguments?.find((a) => a.name === 'block_type')?.value ?? 'blocks';
        const countArg = action.arguments?.find((a) => a.name === 'count')?.value;
        const countMsg = countArg ? ` (${countArg} requested)` : '';
        const msg = `${botName} starts mining ${blockArg}${countMsg}.`;
        callbacks.addChat('note', 'Note', msg);
        callbacks.queueNote(msg);
    }

    void executeAction(bot, actionName, action.arguments, names).then(async (result) => {
        const botName = callbacks.getAssistantName();
        callbacks.updateCurrentAction(null);

        // Clear fishing callback when done
        if (actionName === 'mc_fish') {
            setFishCaughtCallback(null);
        }

        // Resume the following if we were following before this action (silent — UI only)
        const followingPlayer = callbacks.getFollowingPlayer();
        const shouldResume =
            followingPlayer &&
            getBotMode() !== 'guard' &&
            actionName !== 'mc_follow_player' &&
            actionName !== 'mc_stop' &&
            actionName !== 'mc_go_home' &&
            actionName !== 'mc_go_to' &&
            actionName !== 'mc_set_mode';
        console.log(
            `[Bot] Action done: ${actionName}, followingPlayer: ${followingPlayer}, shouldResume: ${!!shouldResume}`,
        );
        if (actionName === 'mc_follow_player') {
            console.log(`[Bot] Pathfinder goal after follow: ${!!bot.pathfinder.goal}`);
        }
        if (shouldResume) {
            // Linger at the entity for 3s before returning to the player
            if (actionName === 'mc_go_to_entity') {
                await new Promise((r) => setTimeout(r, 3000));
            }
            const resumeResult = await executeAction(
                bot,
                'mc_follow_player',
                [{ name: 'player_name', value: followingPlayer ?? '' }],
                names,
            );
            console.log(`[Bot] Resumed following: ${resumeResult}`);
        }

        // Look up action metadata to decide if we should report the result
        const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);
        const failureKeywords = ['cannot', 'failed', 'unknown', 'no ', 'not a block', 'not a ', 'need ', 'missing', 'too far'];
        if (actionDef?.isQuick) {
            if (!result) return;
            const isQuickFailure = failureKeywords.some((kw) => result.toLowerCase().includes(kw));
            if (isQuickFailure) {
                // Quick action failed — AI must know so it doesn't hallucinate success
                callbacks.addChat('note', 'Note', `${botName}: ${result}`);
                callbacks.queueNote(`[ACTION FAILED: ${actionName}] ${botName}: ${result}`);
            } else {
                // Quick action succeeded — show in chat only, no AI note needed
                callbacks.addChat('note', 'Note', `${botName}: ${result}`);
            }
            return;
        }
        if (!result) return; // Aborted actions return empty — nothing to report

        // Detect action failures — these must always trigger an AI reply
        // so the AI acknowledges the error instead of hallucinating success
        const isFailure = failureKeywords.some((kw) => result.toLowerCase().includes(kw));
        const voxta = callbacks.getVoxta();
        const timing = callbacks.getSettings().actionInferenceTiming;

        // Transactional actions (give, toss, store, equip) — the AI already announced
        // them in its reply, so the result is always a silent note, never a voiced event.
        const ALWAYS_SILENT_ACTIONS = ['mc_give_item', 'mc_toss', 'mc_store_item', 'mc_take_item', 'mc_equip'];
        if (ALWAYS_SILENT_ACTIONS.includes(actionName) && !isFailure) {
            callbacks.addChat('note', 'Note', `${botName}: ${result}`);
            callbacks.queueNote(`${botName}: ${result}`);
            return;
        }

        if (timing === 'user') {
            // With user action inference, the server generates a reply simultaneously.
            const noteText = `[ACTION ${isFailure ? 'FAILED' : 'COMPLETE'}: ${actionName}] ${botName}: ${result}`;

            // Apply voice chance — if it passes, queue an event to trigger a
            // follow-up voiced reply once the current reply finishes.
            // Only send ONE of note or event, never both (avoids duplicate in LLM context).
            const voiceChance = isFailure ? 100 : getVoiceChance(callbacks.getSettings(), actionDef?.category);
            const roll = Math.random() * 100;
            if (roll < voiceChance) {
                callbacks.addChat('event', 'Event', `${botName}: ${result}`);
                callbacks.queueEvent(noteText);
            } else {
                callbacks.addChat('note', 'Note', `${botName}: ${result}`);
                callbacks.sendNoteNow(noteText);
            }
        } else if (isFailure && !callbacks.isReplying()) {
            // Failures always voiced — AI must acknowledge what went wrong
            // Disable action inference so hints like "kill spiders" don't auto-trigger actions
            callbacks.addChat('event', 'Event', `${botName}: ${result}`);
            void voxta?.sendEvent(`[ACTION FAILED: ${actionName}] ${botName}: ${result}`, false);
        } else {
            // Voice chance roll — like an Elite Dangerous probability system
            const voiceChance = getVoiceChance(callbacks.getSettings(), actionDef?.category);
            const roll = Math.random() * 100;
            if (roll < voiceChance && !callbacks.isReplying()) {
                // Voiced: send it as an event so the AI replies about the result
                callbacks.addChat('event', 'Event', `${botName}: ${result}`);
                void voxta?.sendEvent(`[ACTION COMPLETE: ${actionName}] ${botName}: ${result}`);
            } else {
                // Silent: AI sees it but stays quiet — single note, no duplicate
                callbacks.addChat('note', 'Note', `${botName}: ${result}`);
                callbacks.queueNote(`${botName}: ${result}`);
            }
        }
    });
}

/** Get the voice chance (0-100) for an action category */
function getVoiceChance(settings: McSettings, category?: ActionCategory): number {
    switch (category) {
        case 'movement':
            return settings.voiceChanceMovement;
        case 'survival':
            return settings.voiceChanceSurvival;
        case 'combat':
            return settings.voiceChanceCombat;
        case 'interaction':
            return settings.voiceChanceInteraction;
        default:
            return 50;
    }
}
