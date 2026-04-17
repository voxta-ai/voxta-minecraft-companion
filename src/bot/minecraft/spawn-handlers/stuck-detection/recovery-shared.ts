// ---- Shared types and helpers for stuck-recovery strategies ----

import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';

/** Inputs every recovery strategy receives from the orchestrator. */
export interface RecoveryDeps {
    bot: Bot;
    doorIds: Set<number>;
    /** consecutiveStuckCount value at the moment recovery is triggered */
    cycle: number;
    /** Position when recovery began (for measuring moved distance) */
    startPos: Vec3;
    /** Position at the start of the stuck episode (cycle 1) — used for total-distance log */
    preRecoveryPos: Vec3;
}

/** Result returned by every recovery strategy. */
export interface RecoveryOutcome {
    /** Distance from startPos to the bot's position when recovery finished. */
    moved: number;
    /** True if the recovery actually displaced the bot beyond the success threshold. */
    success: boolean;
}

/** Stop all recovery-related movement controls. Forward and sneak are not touched. */
export function clearRecoveryControls(bot: Bot): void {
    bot.setControlState('back', false);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('jump', false);
}

/**
 * Build a physicsTick listener that forces onGround=true when the bot is
 * within ~0.2 blocks of a solid block surface. Recovery flows register this
 * during their movement window so Paper's onGround=false reports don't kill
 * horizontal speed. Each call returns a fresh function so add/removeListener
 * pairs match.
 */
export function makeForceGroundHandler(bot: Bot): () => void {
    return (): void => {
        const y = bot.entity.position.y;
        const below = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
        if (below && below.boundingBox === 'block') {
            const blockTop = below.position.y + 1.0;
            if (Math.abs(y - blockTop) < 0.2) {
                bot.entity.onGround = true;
            }
        }
    };
}
