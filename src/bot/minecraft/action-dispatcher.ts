import type { Bot } from 'mineflayer';
import type { ActionInvocationArgument } from '../voxta/types.js';
import type { NameRegistry } from '../name-registry';
import { MINECRAFT_ACTIONS } from './action-definitions';
import { getArg } from './actions';
import {
    resetActionAbort,
    setActionBusy,
    getCurrentActivity,
    setCurrentActivity,
    getCurrentCombatTarget,
    setBotMode,
    setGuardCenter,
} from './actions';
import {
    followPlayer,
    goTo,
    goHome,
    goToEntity,
    collectItems,
    attackEntity,
    lookAtPlayer,
    mineBlock,
    craftItem,
    cookFood,
    fishAction,
    equipItem,
    eatFood,
    giveItem,
    tossItem,
    useHeldItem,
    storeItem,
    takeItem,
    inspectContainer,
    sleepInBed,
    setHomeBed,
    placeBlock,
    buildStructure,
    mountEntity,
    dismountEntity,
} from './actions';

// Re-export so existing consumers keep working
export { MINECRAFT_ACTIONS } from './action-definitions';
export {
    isActionBusy,
    isPickupSuppressed,
    getCurrentActivity,
    setCurrentActivity,
    getCurrentCombatTarget,
    setFishCaughtCallback,
    getHomePosition,
    initHomePosition,
    getBotMode,
    setBotMode,
    getGuardCenter,
    setGuardCenter,
} from './actions/action-state.js';
export { resumeFollowPlayer } from './actions/movement.js';

// ---- Pre-flight checks ----

/** Return an early-exit message if the action should be skipped, or null to proceed */
function checkPreconditions(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
): string | null {
    // Block all actions while building — only stop and none are allowed.
    // Auto-defense (scan loop) still fires because it directly calls
    // attack functions, not through AI action inference.
    const activity = getCurrentActivity(bot);
    if (activity?.startsWith('building') && actionName !== 'mc_stop' && actionName !== 'mc_none') {
        console.log(`[MC Action] Blocked ${actionName} — building in progress`);
        return '';
    }

    // If we're already fighting this exact target (e.g. auto-defense), skip entirely
    // — don't abort the ongoing fight just to restart the same attack.
    if (actionName === 'mc_attack') {
        const attackTarget = (getArg(args, 'entity_name') ?? 'enemy').toLowerCase();
        if (getCurrentCombatTarget(bot) && getCurrentCombatTarget(bot) === attackTarget) {
            return `Already fighting ${attackTarget}`;
        }
    }

    return null;
}

/** Cancel running actions before starting a new physical one */
function preparePhysicalAction(bot: Bot): void {
    resetActionAbort(bot);
    try {
        bot.stopDigging();
    } catch {
        /* may not be digging */
    }
    // Retract fishing rod if actively fishing
    if (getCurrentActivity(bot) === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
        bot.activateItem();
    }
}

// ---- Category dispatchers ----
// Each returns the action result, or null if the action doesn't belong to its category.

function dispatchMovementAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> | null {
    switch (actionName) {
        case 'mc_follow_player': {
            const followTarget = getArg(args, 'player_name') ?? 'player';
            setCurrentActivity(bot, `following ${followTarget}`);
            // Mode cancellation (guard/hunt → passive) is handled by the
            // orchestrator for AI-chosen actions. We do NOT cancel here
            // because the scan loop also calls mc_follow_player internally
            // to resume following after a kill — cancelling would break the mode.
            return followPlayer(bot, getArg(args, 'player_name'), names);
        }
        case 'mc_go_to': {
            const gx = getArg(args, 'x'),
                gy = getArg(args, 'y'),
                gz = getArg(args, 'z');
            setCurrentActivity(bot, `navigating to ${gx ?? '?'},${gy ?? '?'},${gz ?? '?'}`);
            return goTo(bot, gx, gy, gz);
        }
        case 'mc_go_home':
            setCurrentActivity(bot, 'heading home');
            return goHome(bot);
        case 'mc_go_to_entity': {
            const entityArg = getArg(args, 'entity_name') ?? 'entity';
            setCurrentActivity(bot, `approaching ${entityArg}`);
            return goToEntity(bot, getArg(args, 'entity_name'));
        }
        default:
            return null;
    }
}

function dispatchCombatAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> | null {
    switch (actionName) {
        case 'mc_attack': {
            const attackTarget = getArg(args, 'entity_name') ?? 'enemy';
            setCurrentActivity(bot, `fighting ${attackTarget}`);
            return attackEntity(bot, getArg(args, 'entity_name'), names);
        }
        case 'mc_look_at':
            return lookAtPlayer(bot, getArg(args, 'player_name'), names);
        default:
            return null;
    }
}

function dispatchResourceAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
): Promise<string> | null {
    switch (actionName) {
        case 'mc_mine_block': {
            const blockArg = getArg(args, 'block_type') ?? 'blocks';
            setCurrentActivity(bot, `mining ${blockArg}`);
            return mineBlock(bot, getArg(args, 'block_type'), getArg(args, 'count'));
        }
        case 'mc_craft': {
            const craftTarget = getArg(args, 'item_name') ?? 'item';
            setCurrentActivity(bot, `crafting ${craftTarget}`);
            return craftItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
        }
        case 'mc_cook':
            setCurrentActivity(bot, 'cooking');
            return cookFood(bot, getArg(args, 'item_name'));
        case 'mc_fish':
            setCurrentActivity(bot, 'fishing');
            return fishAction(bot, getArg(args, 'count'));
        case 'mc_collect_items': {
            const itemArg = getArg(args, 'item_name');
            setCurrentActivity(bot, itemArg ? `collecting ${itemArg}` : 'collecting nearby items');
            return collectItems(bot, itemArg);
        }
        default:
            return null;
    }
}

function dispatchInventoryAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> | null {
    switch (actionName) {
        case 'mc_equip':
            return equipItem(bot, getArg(args, 'item_name'));
        case 'mc_give_item':
            return giveItem(
                bot,
                getArg(args, 'item_name'),
                getArg(args, 'player_name'),
                getArg(args, 'count'),
                names,
            );
        case 'mc_eat':
            setCurrentActivity(bot, 'eating');
            return eatFood(bot, getArg(args, 'food_name'));
        case 'mc_toss':
            return tossItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
        case 'mc_store_item':
            setCurrentActivity(bot, 'storing items in chest');
            return storeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
        case 'mc_take_item':
            setCurrentActivity(bot, 'taking items from chest');
            return takeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
        case 'mc_inspect':
            return inspectContainer(bot, getArg(args, 'target'));
        case 'mc_use_item':
            return useHeldItem(bot, getArg(args, 'item_name'));
        default:
            return null;
    }
}

function dispatchBuildAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> | null {
    switch (actionName) {
        case 'mc_place_block': {
            const blockTarget = getArg(args, 'block_name') ?? 'block';
            setCurrentActivity(bot, `placing ${blockTarget}`);
            return placeBlock(bot, getArg(args, 'block_name'));
        }
        case 'mc_build': {
            const structure = getArg(args, 'structure') ?? 'shelter';
            setCurrentActivity(bot, `building ${structure}`);
            return buildStructure(bot, getArg(args, 'structure'), names);
        }
        default:
            return null;
    }
}

function dispatchControlAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
): string | Promise<string> | null {
    switch (actionName) {
        case 'mc_stop':
            // mc_stop is not isPhysical (so it doesn't trigger the generic abort above),
            // but it MUST abort any running action's signal explicitly
            resetActionAbort(bot);
            bot.pathfinder.stop();
            try {
                bot.stopDigging();
            } catch {
                /* may not be digging */
            }
            try {
                bot.deactivateItem();
            } catch {
                /* may not be using an item */
            }
            // Retract fishing rod if actively fishing (check BEFORE clearing activity)
            if (getCurrentActivity(bot) === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
                bot.activateItem();
            }
            setCurrentActivity(bot, null);
            // Stopping resets to passive mode
            setBotMode(bot, 'passive');
            setGuardCenter(bot, null);
            return 'Stopped current action';

        case 'mc_set_mode': {
            const mode = (getArg(args, 'mode') ?? 'passive').toLowerCase();
            if (mode !== 'passive' && mode !== 'aggro' && mode !== 'hunt' && mode !== 'guard') {
                return `Unknown mode '${mode}'. Valid modes: passive, aggro, hunt, guard`;
            }
            setBotMode(bot, mode);
            if (mode === 'guard') {
                const pos = bot.entity.position;
                setGuardCenter(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) });
                setCurrentActivity(bot, 'guarding area');
                bot.pathfinder.stop();
                bot.pathfinder.setGoal(null);
                return `Guard mode activated. Patrolling this area.`;
            }
            setGuardCenter(bot, null);
            if (mode === 'aggro') {
                setCurrentActivity(bot, 'in aggro mode');
                return `Aggro mode activated. Will attack any hostile mob in sight.`;
            }
            if (mode === 'hunt') {
                setCurrentActivity(bot, 'hunting animals');
                return `Hunt mode activated. Hunting farm animals for food.`;
            }
            setCurrentActivity(bot, null);
            return `Passive mode. Following and defending only when attacked.`;
        }

        case 'mc_mount': {
            const mountTarget = getArg(args, 'entity_name');
            setCurrentActivity(bot, `mounting ${mountTarget ?? 'nearby entity'}`);
            return mountEntity(bot, mountTarget);
        }
        case 'mc_dismount':
            return dismountEntity(bot);

        case 'mc_sleep':
            setCurrentActivity(bot, 'going to sleep');
            return sleepInBed(bot);
        case 'mc_wake':
            if (bot.isSleeping) {
                return bot.wake().then(() => 'Woke up and got out of bed');
            }
            return 'Not currently sleeping';
        case 'mc_set_home':
            setCurrentActivity(bot, 'setting home');
            return setHomeBed(bot);

        case 'mc_none':
            return ''; // No-op — AI acknowledged, nothing to do

        default:
            return null;
    }
}

// ---- Action execution (main entry point) ----

export async function executeAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> {
    const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);

    const skipReason = checkPreconditions(bot, actionName, args);
    if (skipReason !== null) return skipReason;

    if (actionDef?.isPhysical) {
        preparePhysicalAction(bot);
    }

    // Track busy state for physical actions (except stop which clears it)
    const shouldTrackBusy = actionDef?.isPhysical && actionName !== 'mc_stop';
    if (shouldTrackBusy) setActionBusy(bot, true);

    try {
        const result =
            dispatchMovementAction(bot, actionName, args, names) ??
            dispatchCombatAction(bot, actionName, args, names) ??
            dispatchResourceAction(bot, actionName, args) ??
            dispatchInventoryAction(bot, actionName, args, names) ??
            dispatchBuildAction(bot, actionName, args, names) ??
            dispatchControlAction(bot, actionName, args);

        if (result !== null) return await result;
        return `Unknown action: ${actionName}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Error executing ${actionName}:`, message);
        return `Failed to execute ${actionName}: ${message}`;
    } finally {
        if (shouldTrackBusy) {
            setActionBusy(bot, false);
            // Only clear activity for non-quick actions (they run to completion).
            // Quick actions (follow, look_at) persist after returning — their
            // activity is cleared when a new action starts or mc_stop is called.
            if (!actionDef?.isQuick) {
                setCurrentActivity(bot, null);
            }
        }
    }
}
