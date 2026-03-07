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
} from './actions';
import {
    followPlayer,
    goTo,
    goHome,
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
} from './actions/action-state.js';
export { resumeFollowPlayer } from './actions/movement.js';

// ---- Action execution (dispatcher) ----

export async function executeAction(
    bot: Bot,
    actionName: string,
    args: ActionInvocationArgument[] | undefined,
    names: NameRegistry,
): Promise<string> {
    // Look up action metadata to decide behavior
    const actionDef = MINECRAFT_ACTIONS.find((a) => a.name === actionName);

    // If we're already fighting this exact target (e.g. auto-defense), skip entirely
    // — don't abort the ongoing fight just to restart the same attack.
    if (actionName === 'mc_attack') {
        const attackTarget = (getArg(args, 'entity_name') ?? 'enemy').toLowerCase();
        if (getCurrentCombatTarget() && getCurrentCombatTarget() === attackTarget) {
            return `Already fighting ${attackTarget}`;
        }
    }

    if (actionDef?.isPhysical) {
        // Cancel any running action before starting a new one
        resetActionAbort();
        try {
            bot.stopDigging();
        } catch {
            /* may not be digging */
        }
        // Retract fishing rod if actively fishing
        if (getCurrentActivity() === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
            bot.activateItem();
        }
    }

    // Track busy state for physical actions (except stop which clears it)
    const shouldTrackBusy = actionDef?.isPhysical && actionName !== 'mc_stop';
    if (shouldTrackBusy) setActionBusy(true);

    try {
        switch (actionName) {
            case 'mc_follow_player': {
                const followTarget = getArg(args, 'player_name') ?? 'player';
                setCurrentActivity(`following ${followTarget}`);
                return await followPlayer(bot, getArg(args, 'player_name'), names);
            }

            case 'mc_go_to': {
                const gx = getArg(args, 'x'),
                    gy = getArg(args, 'y'),
                    gz = getArg(args, 'z');
                setCurrentActivity(`navigating to ${gx ?? '?'},${gy ?? '?'},${gz ?? '?'}`);
                return await goTo(bot, gx, gy, gz);
            }

            case 'mc_go_home':
                setCurrentActivity('heading home');
                return await goHome(bot);

            case 'mc_mine_block': {
                const blockArg = getArg(args, 'block_type') ?? 'blocks';
                setCurrentActivity(`mining ${blockArg}`);
                return await mineBlock(bot, getArg(args, 'block_type'), getArg(args, 'count'));
            }

            case 'mc_attack': {
                const attackTarget = getArg(args, 'entity_name') ?? 'enemy';
                setCurrentActivity(`fighting ${attackTarget}`);
                return await attackEntity(bot, getArg(args, 'entity_name'), names);
            }

            case 'mc_look_at':
                return await lookAtPlayer(bot, getArg(args, 'player_name'), names);

            case 'mc_stop':
                // mc_stop is not isPhysical (so it doesn't trigger the generic abort above),
                // but it MUST abort any running action's signal explicitly
                resetActionAbort();
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
                if (getCurrentActivity() === 'fishing' && bot.heldItem?.name === 'fishing_rod') {
                    bot.activateItem();
                }
                setCurrentActivity(null);
                return 'Stopped current action';

            case 'mc_equip':
                return await equipItem(bot, getArg(args, 'item_name'));

            case 'mc_give_item':
                return await giveItem(
                    bot,
                    getArg(args, 'item_name'),
                    getArg(args, 'player_name'),
                    getArg(args, 'count'),
                    names,
                );

            case 'mc_collect_items':
                setCurrentActivity('collecting nearby items');
                return await collectItems(bot);

            case 'mc_eat':
                setCurrentActivity('eating');
                return await eatFood(bot, getArg(args, 'food_name'));

            case 'mc_none':
                return ''; // No-op — AI acknowledged, nothing to do

            case 'mc_sleep':
                setCurrentActivity('going to sleep');
                return await sleepInBed(bot);

            case 'mc_wake':
                if (bot.isSleeping) {
                    await bot.wake();
                    return 'Woke up and got out of bed';
                }
                return 'Not currently sleeping';

            case 'mc_set_home':
                setCurrentActivity('setting home');
                return await setHomeBed(bot);

            case 'mc_cook':
                setCurrentActivity('cooking');
                return await cookFood(bot, getArg(args, 'item_name'));

            case 'mc_craft': {
                const craftTarget = getArg(args, 'item_name') ?? 'item';
                setCurrentActivity(`crafting ${craftTarget}`);
                return await craftItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));
            }

            case 'mc_place_block': {
                const blockTarget = getArg(args, 'block_name') ?? 'block';
                setCurrentActivity(`placing ${blockTarget}`);
                return await placeBlock(bot, getArg(args, 'block_name'));
            }

            case 'mc_store_item':
                setCurrentActivity('storing items in chest');
                return await storeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_take_item':
                setCurrentActivity('taking items from chest');
                return await takeItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_inspect':
                return await inspectContainer(bot, getArg(args, 'target'));

            case 'mc_toss':
                return await tossItem(bot, getArg(args, 'item_name'), getArg(args, 'count'));

            case 'mc_fish':
                setCurrentActivity('fishing');
                return await fishAction(bot, getArg(args, 'count'));

            case 'mc_use_item':
                return await useHeldItem(bot, getArg(args, 'item_name'));

            default:
                return `Unknown action: ${actionName}`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MC Action] Error executing ${actionName}:`, message);
        return `Failed to execute ${actionName}: ${message}`;
    } finally {
        if (shouldTrackBusy) {
            setActionBusy(false);
            // Only clear activity for non-quick actions (they run to completion).
            // Quick actions (follow, look_at) persist after returning — their
            // activity is cleared when a new action starts or mc_stop is called.
            if (!actionDef?.isQuick) {
                setCurrentActivity(null);
            }
        }
    }
}
