// ---- Generic wall/corner recovery ----
// Cycle-based strafe/back/jump strategies for when neither the door-alignment
// nor narrow-passage recovery applies. Strategies 0-3 are back/strafe combos;
// strategy 4 is forward+jump for micro-ledge obstacles (e.g. the 1/16 step at
// dirt_path → grass_block borders near door frames).
//
// Unlike door-align/narrow-passage, this does NOT call bot.pathfinder.stop().
// The strafe/jump controls are layered on top of the pathfinder's forward
// movement so the bot keeps its goal and never has to re-plan.

import { STUCK_RECOVERY_DURATION_MS } from './constants';
import {
    clearRecoveryControls,
    makeForceGroundHandler,
    type RecoveryDeps,
    type RecoveryOutcome,
} from './recovery-shared';

const STRATEGY_NAMES = ['back+left', 'back+right', 'back', 'left', 'forward+jump'];

export function runGenericRecovery(deps: RecoveryDeps): Promise<RecoveryOutcome> {
    const { bot, cycle, startPos, preRecoveryPos } = deps;
    const pos = bot.entity.position;

    const strategy = ((cycle - 1) % 5);
    console.log(`[MC Stuck] Recovery #${cycle}: ${STRATEGY_NAMES[strategy]} at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})`);

    const forceGroundHandler = makeForceGroundHandler(bot);
    let forceGroundActive = false;

    if (strategy <= 3) {
        // Strafe recovery — force ground so Paper doesn't block movement
        bot.on('physicsTick', forceGroundHandler);
        forceGroundActive = true;
        bot.setControlState('forward', false);
        if (strategy <= 2) bot.setControlState('back', true);
        if (strategy === 0 || strategy === 3) bot.setControlState('left', true);
        if (strategy === 1) bot.setControlState('right', true);
    } else {
        // Jump recovery — DON'T force ground (jump needs real ground state,
        // forceGround + jump creates a trampoline that launches the bot)
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
    }

    return new Promise<RecoveryOutcome>((resolve) => {
        setTimeout(() => {
            if (forceGroundActive) {
                bot.removeListener('physicsTick', forceGroundHandler);
            }
            clearRecoveryControls(bot);
            const endPos = bot.entity.position;
            const recoveryDist = startPos.distanceTo(endPos);
            const totalDist = endPos.distanceTo(preRecoveryPos);
            const success = recoveryDist > 0.1;
            console.log(
                `[MC Stuck] Recovery done: moved ${recoveryDist.toFixed(2)} (total ${totalDist.toFixed(2)})` +
                ` ${success ? 'OK' : 'FAILED'}`,
            );
            // Pathfinder still has its goal — it resumes naturally
            resolve({ moved: recoveryDist, success });
        }, STUCK_RECOVERY_DURATION_MS);
    });
}
