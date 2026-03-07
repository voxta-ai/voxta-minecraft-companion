// Barrel file — re-exports everything so consumers can import from 'actions/index'

// Shared state & lifecycle
export {
    isActionBusy,
    isPickupSuppressed,
    getCurrentActivity,
    setCurrentActivity,
    getCurrentCombatTarget,
    setFishCaughtCallback,
    getHomePosition,
    initHomePosition,
    getActionAbort,
    resetActionAbort,
    setActionBusy,
    setSuppressPickups,
} from './action-state.js';

// Helpers (re-exported for consumers that need them directly)
export { getArg } from './action-helpers.js';

// Action implementations
export { followPlayer, resumeFollowPlayer, goTo, goHome, collectItems } from './movement.js';
export { attackEntity, lookAtPlayer } from './combat.js';
export { mineBlock } from './mining.js';
export { craftItem } from './crafting.js';
export { cookFood } from './cooking.js';
export { fishAction } from './fishing.js';
export { equipItem, eatFood, giveItem, tossItem, useHeldItem } from './inventory.js';
export { storeItem, takeItem, inspectContainer } from './containers.js';
export { sleepInBed, setHomeBed } from './home.js';
export { placeBlock } from './placement.js';
