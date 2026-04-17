// ---- Bot spawn-time subsystems ----
//
// Independent physicsTick handlers and one-time fixes that are
// registered when the bot spawns. Each module is self-contained
// and only needs the bot instance (plus doorIds where relevant).

export { setupNaNGuards } from './nan-guards';
export { setupDoorAutomation } from './door-automation';
export { setupAutoSwim } from './auto-swim';
export { setupNonFullBlockGroundFix } from './ground-fix';
export { setupStuckDetection } from './stuck-detection';
export { setupShelterProtection } from './shelter-protection';
export { handleTreeSpawn } from './tree-spawn';
