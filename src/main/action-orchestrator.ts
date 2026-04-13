import type { Bot } from 'mineflayer';
import type { NameRegistry } from '../bot/name-registry';
import type { ActionCategory, McAction } from '../bot/minecraft/action-definitions';
import { MINECRAFT_ACTIONS } from '../bot/minecraft/action-definitions';
import { executeAction, setFishCaughtCallback } from '../bot/minecraft/action-dispatcher';
import { isActionBusy, getCurrentActivity, setBuildProgressCallback, setCraftProgressCallback } from '../bot/minecraft/actions';
import { isAutoDefending, getBotMode, setBotMode } from '../bot/minecraft/actions/action-state.js';
import type { VoxtaClient } from '../bot/voxta/client';
import type { ServerActionMessage } from '../bot/voxta/types';
import type { McSettings, ChatMessage } from '../shared/ipc-types';
import { getVehicle } from '../bot/minecraft/mineflayer-types';

// ---- Constants ----
const DEFAULT_VOICE_CHANCE = 50;       // Fallback voice chance when no category matches
const LOG_PREVIEW_LENGTH = 80;         // Truncation length for log messages
const GO_TO_ENTITY_LINGER_MS = 3000;   // Pause at entity before resuming follow

/** Keywords indicating an action failed — AI must acknowledge */
const FAILURE_KEYWORDS = ['cannot', 'failed', 'unknown', 'no ', 'not a block', 'not a ', 'need ', 'missing', 'too far'];

/** Result patterns that should never trigger a voiced reply */
const ALWAYS_SILENT_PATTERNS = [
    'nowhere in sight', 'no entity name provided', 'no player name provided',
    'no block name', 'no item', 'too tough to kill', 'barely got away',
    'stopped fighting', 'died while fighting', 'reached the', 'cannot find',
    'failed to eat', 'not edible', 'ate some', 'nothing to eat',
    'checked inventory but has no',
];

/** Actions that clear follow state when triggered */
const FOLLOW_CLEARING_ACTIONS = ['mc_stop', 'mc_go_home', 'mc_go_to'];

/** Actions that should NOT trigger a follow resume after completion */
const NO_RESUME_ACTIONS = new Set([
    'mc_none', 'mc_follow_player', 'mc_stop', 'mc_go_home', 'mc_go_to', 'mc_set_mode', 'mc_mount',
]);

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
    const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);
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
    if (actionDef?.isLongRunning && isActionBusy(bot) && getCurrentActivity(bot)) {
        console.log(`[Bot] Ignoring duplicate ${actionName} — already busy with: ${getCurrentActivity(bot)}`);
        return;
    }

    // Skip AI-generated combat actions only when auto-defense is actively fighting.
    if (actionDef?.isCombat && isAutoDefending(bot)) {
        console.log(`[Bot] Ignoring ${actionName} — auto-defense is actively fighting`);
        return;
    }

    // Reentrance guard: only one real action per user turn.
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

    updateFollowState(actionName, action, bot, callbacks);
    setupLongRunningCallbacks(actionName, action, bot, callbacks);

    void executeAction(bot, actionName, action.arguments, names).then(async (result) => {
        const botName = callbacks.getAssistantName();
        callbacks.updateCurrentAction(null);

        // Clear callbacks when done
        if (actionName === 'mc_fish') setFishCaughtCallback(bot, null);
        if (actionName === 'mc_build') setBuildProgressCallback(null);
        if (actionName === 'mc_craft') setCraftProgressCallback(null);

        await maybeResumeFollow(actionName, bot, names, callbacks);

        if (handleQuickActionResult(result, actionName, actionDef, botName, callbacks)) return;
        if (!result) return; // Aborted actions return empty — nothing to report

        routeActionResult(result, actionName, actionDef, botName, callbacks);
    });
}

// ---- Extracted helpers ----

/** Update follow state based on the action being executed */
function updateFollowState(
    actionName: string,
    action: ServerActionMessage,
    bot: Bot,
    callbacks: ActionOrchestratorCallbacks,
): void {
    if (actionName === 'mc_follow_player') {
        const playerArg = action.arguments?.find((a) => a.name.toLowerCase() === 'player_name');
        // Strip LLM type annotations like 'string="Lapiro' → 'Lapiro'
        let rawVal = playerArg?.value ?? '';
        const eqIdx = rawVal.lastIndexOf('=');
        if (eqIdx >= 0) rawVal = rawVal.slice(eqIdx + 1);
        rawVal = rawVal.replace(/"/g, '').trim();
        callbacks.setFollowingPlayer(rawVal || null);
        // AI explicitly chose "follow player" — switch out of guard/hunt so the
        // mode scan doesn't immediately override with a new attack target.
        if (getBotMode(bot) === 'guard' || getBotMode(bot) === 'hunt') {
            const prevMode = getBotMode(bot);
            console.log(`[Bot] mc_follow_player: auto-switching from ${prevMode} to passive`);
            setBotMode(bot, 'passive');
            callbacks.addChat('note', 'Note', `Exited ${prevMode} mode to follow ${rawVal}.`);
        }
    } else if (FOLLOW_CLEARING_ACTIONS.includes(actionName)) {
        callbacks.setFollowingPlayer(null);
    }
}

/** Notify AI and wire up progress callbacks for long-running actions */
function setupLongRunningCallbacks(
    actionName: string,
    action: ServerActionMessage,
    bot: Bot,
    callbacks: ActionOrchestratorCallbacks,
): void {
    if (actionName === 'mc_fish') {
        const botName = callbacks.getAssistantName();
        const fishMsg = `${botName} is now casting the fishing rod and fishing.`;
        callbacks.addChat('note', 'Note', fishMsg);
        callbacks.queueNote(`${fishMsg} ${botName} is the one holding the rod and waiting for a bite.`);
        setFishCaughtCallback(bot, (itemName, count) => {
            const fishBotName = callbacks.getAssistantName();
            const msg = `${fishBotName} caught ${count} ${itemName} while fishing!`;
            const voiceChance = getVoiceChance(callbacks.getSettings(), 'survival');
            const roll = Math.random() * 100;
            if (roll < voiceChance && !callbacks.isReplying()) {
                console.log(`[Bot >>] event: "${msg.substring(0, LOG_PREVIEW_LENGTH)}"`);
                callbacks.addChat('event', 'Event', msg);
                void callbacks.getVoxta()?.sendEvent(msg);
            } else {
                callbacks.addChat('note', 'Note', msg);
                callbacks.queueNote(msg);
            }
        });
    }

    if (actionName === 'mc_craft') {
        const botName = callbacks.getAssistantName();
        setCraftProgressCallback((progressMsg) => {
            const fullMsg = `${botName}: ${progressMsg}`;
            callbacks.addChat('note', 'Note', fullMsg);
            callbacks.queueNote(fullMsg);
        });
    }

    if (actionName === 'mc_go_home') {
        const botName = callbacks.getAssistantName();
        const msg = `${botName} is heading home to the bed where the respawn point is set.`;
        callbacks.addChat('note', 'Note', msg);
        callbacks.queueNote(msg);
    }

    if (actionName === 'mc_mine_block') {
        const botName = callbacks.getAssistantName();
        const blockArg = action.arguments?.find((a) => a.name === 'block_type')?.value ?? 'blocks';
        const countArg = action.arguments?.find((a) => a.name === 'count')?.value;
        const countMsg = countArg ? ` (${countArg} requested)` : '';
        const msg = `${botName} starts mining ${blockArg}${countMsg}.`;
        callbacks.addChat('note', 'Note', msg);
        callbacks.queueNote(msg);
    }

    if (actionName === 'mc_build') {
        const botName = callbacks.getAssistantName();
        const structureArg = action.arguments?.find((a) => a.name === 'structure')?.value ?? 'shelter';
        const msg = `${botName} starts building a ${structureArg}.`;
        callbacks.addChat('note', 'Note', msg);
        callbacks.queueNote(msg);
        setBuildProgressCallback((progressMsg) => {
            const buildBotName = callbacks.getAssistantName();
            const noteText = `${buildBotName}: ${progressMsg}`;
            callbacks.addChat('note', 'Note', noteText);
            callbacks.queueNote(noteText);
        });
    }
}

/** Resume following the player after a task action completes */
async function maybeResumeFollow(
    actionName: string,
    bot: Bot,
    names: NameRegistry,
    callbacks: ActionOrchestratorCallbacks,
): Promise<void> {
    const followingPlayer = callbacks.getFollowingPlayer();
    const isMounted = !!getVehicle(bot);
    const shouldResume =
        followingPlayer &&
        !isMounted &&
        getBotMode(bot) !== 'guard' &&
        !NO_RESUME_ACTIONS.has(actionName);
    console.log(
        `[Bot] Action done: ${actionName}, followingPlayer: ${followingPlayer}, shouldResume: ${!!shouldResume}`,
    );
    if (actionName === 'mc_follow_player') {
        console.log(`[Bot] Pathfinder goal after follow: ${!!bot.pathfinder.goal}`);
    }
    if (shouldResume) {
        if (actionName === 'mc_go_to_entity') {
            await new Promise((r) => setTimeout(r, GO_TO_ENTITY_LINGER_MS));
        }
        const resumeResult = await executeAction(
            bot,
            'mc_follow_player',
            [{ name: 'player_name', value: followingPlayer ?? '' }],
            names,
        );
        console.log(`[Bot] Resumed following: ${resumeResult}`);
    }
}

/** Handle quick action results — returns true if handled (caller should return early) */
function handleQuickActionResult(
    result: string,
    actionName: string,
    actionDef: McAction | undefined,
    botName: string,
    callbacks: ActionOrchestratorCallbacks,
): boolean {
    if (!actionDef?.isQuick) return false;
    if (!result) return true;
    const isQuickFailure = FAILURE_KEYWORDS.some((kw) => result.toLowerCase().includes(kw));
    if (isQuickFailure) {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.queueNote(`[ACTION FAILED: ${actionName}] ${botName}: ${result}`);
    } else {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
    }
    return true;
}

/** Route a completed action result: decide if it's voiced, silent, or queued */
function routeActionResult(
    result: string,
    actionName: string,
    actionDef: McAction | undefined,
    botName: string,
    callbacks: ActionOrchestratorCallbacks,
): void {
    const isFailure = FAILURE_KEYWORDS.some((kw) => result.toLowerCase().includes(kw));
    const hasTrades = result.includes('Their trades:');
    const voxta = callbacks.getVoxta();
    const timing = callbacks.getSettings().actionInferenceTiming;

    // Transactional actions (give, toss, store, equip) — silent note unless failed
    if (actionDef?.isSilentResult && !isFailure) {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.queueNote(`${botName}: ${result}`);
        return;
    }

    // Noise that should never trigger a voiced reply
    if (ALWAYS_SILENT_PATTERNS.some((p) => result.toLowerCase().includes(p))) {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.queueNote(`${botName}: ${result}`);
        return;
    }

    if (timing === 'user') {
        routeUserTimingResult(result, actionName, actionDef, botName, isFailure, hasTrades, callbacks);
    } else if (isFailure && !callbacks.isReplying()) {
        callbacks.addChat('event', 'Event', `${botName}: ${result}`);
        console.log(`[Bot >>] event (failure): "${result.substring(0, LOG_PREVIEW_LENGTH)}"`);
        void voxta?.sendEvent(`[ACTION FAILED: ${actionName}] ${botName}: ${result}`, false);
    } else {
        routeAfterTimingResult(result, actionName, actionDef, botName, hasTrades, voxta, callbacks);
    }
}

/** Route result when actionInferenceTiming is 'user' */
function routeUserTimingResult(
    result: string,
    actionName: string,
    actionDef: McAction | undefined,
    botName: string,
    isFailure: boolean,
    hasTrades: boolean,
    callbacks: ActionOrchestratorCallbacks,
): void {
    const noteText = `[ACTION ${isFailure ? 'FAILED' : 'COMPLETE'}: ${actionName}] ${botName}: ${result}`;
    const alwaysVoiced = isFailure || hasTrades;
    const voiceChance = alwaysVoiced ? 100 : getVoiceChance(callbacks.getSettings(), actionDef?.category);
    const roll = Math.random() * 100;
    if (roll < voiceChance) {
        callbacks.addChat('event', 'Event', `${botName}: ${result}`);
        callbacks.queueEvent(noteText);
    } else {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.sendNoteNow(noteText);
    }
}

/** Route result when actionInferenceTiming is 'after' (default) */
function routeAfterTimingResult(
    result: string,
    actionName: string,
    actionDef: McAction | undefined,
    botName: string,
    hasTrades: boolean,
    voxta: VoxtaClient | null,
    callbacks: ActionOrchestratorCallbacks,
): void {
    // Wall builds are quick defensive placements — always a silent note.
    if (actionName === 'mc_build' && result.toLowerCase().includes('wall')) {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.queueNote(`${botName}: ${result}`);
        return;
    }
    const alwaysVoiced = hasTrades || actionName === 'mc_build';
    const voiceChance = alwaysVoiced ? 100 : getVoiceChance(callbacks.getSettings(), actionDef?.category);
    const roll = Math.random() * 100;
    if (roll < voiceChance && !callbacks.isReplying()) {
        callbacks.addChat('event', 'Event', `${botName}: ${result}`);
        console.log(`[Bot >>] event (action result): "${result.substring(0, LOG_PREVIEW_LENGTH)}"`);
        void voxta?.sendEvent(`[ACTION COMPLETE: ${actionName}] ${botName}: ${result}`);
    } else {
        callbacks.addChat('note', 'Note', `${botName}: ${result}`);
        callbacks.queueNote(`${botName}: ${result}`);
    }
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
            return DEFAULT_VOICE_CHANCE;
    }
}
