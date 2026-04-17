// ---- Narrow-passage recovery (cycle >= 3) ----
// Detects when the bot is stuck at a narrow opening (1-2 block wide passage
// with walls on sides). Instead of random strafe bouncing, align to the
// center of the opening and walk straight through.

import { NON_FULL_BLOCK_HEIGHTS } from '../ground-fix';
import {
    clearRecoveryControls,
    makeForceGroundHandler,
    type RecoveryDeps,
    type RecoveryOutcome,
} from './recovery-shared';

interface DirOffset { name: string; dx: number; dz: number; }

/**
 * Attempt narrow-passage recovery. Returns null if the bot is not in a
 * narrow passage (no walls, or no openings) so the caller can fall through
 * to generic recovery.
 */
export async function tryNarrowPassageRecovery(deps: RecoveryDeps): Promise<RecoveryOutcome | null> {
    const { bot, cycle, startPos } = deps;
    const pos = bot.entity.position;

    // Scan N/S/E/W for walls vs openings at head height (y+1)
    const dirs: DirOffset[] = [
        { name: 'N', dx: 0, dz: -1 },
        { name: 'S', dx: 0, dz: 1 },
        { name: 'E', dx: 1, dz: 0 },
        { name: 'W', dx: -1, dz: 0 },
    ];
    const wallDirs: DirOffset[] = [];
    const openDirs: DirOffset[] = [];
    for (const d of dirs) {
        const checkBlock = bot.blockAt(pos.offset(d.dx, 0, d.dz));
        // Wall = solid block at foot level (y+0) that isn't a door or short block
        // Doors are OPENINGS — the bot should walk through them, not away!
        if (checkBlock && checkBlock.boundingBox === 'block' &&
            !NON_FULL_BLOCK_HEIGHTS[checkBlock.name] &&
            !checkBlock.name.includes('door')) {
            wallDirs.push(d);
        } else {
            openDirs.push(d);
        }
    }

    // Narrow passage = at least 1 wall direction and at least 1 open direction
    // The bot should walk toward the open direction that the pathfinder wants
    if (wallDirs.length < 1 || openDirs.length < 1) return null;

    // Pick the open direction closest to where the pathfinder was heading
    const yaw = bot.entity.yaw;
    const lookDx = -Math.sin(yaw);
    const lookDz = Math.cos(yaw);

    let bestDir = openDirs[0];
    let bestDot = -Infinity;
    for (const d of openDirs) {
        const dot = d.dx * lookDx + d.dz * lookDz;
        if (dot > bestDot) {
            bestDot = dot;
            bestDir = d;
        }
    }

    console.log(
        `[MC Stuck] Narrow-passage #${cycle}: walls=[${wallDirs.map(d => d.name).join(',')}]` +
        ` open=[${openDirs.map(d => d.name).join(',')}] → walking ${bestDir.name}`,
    );

    // Stop pathfinder, align, and walk through
    const goal = bot.pathfinder.goal;
    bot.pathfinder.stop();

    const forceGroundHandler = makeForceGroundHandler(bot);

    const restoreAndCleanup = (): void => {
        bot.removeListener('physicsTick', forceGroundHandler);
        clearRecoveryControls(bot);
        bot.setControlState('sprint', false);
        if (goal) bot.pathfinder.setGoal(goal, true);
    };

    try {
        // Force ground during walk-through (Paper reports onGround=false
        // even on grass_block, blocking all horizontal movement)
        bot.on('physicsTick', forceGroundHandler);

        // Open any closed door at current position AND in walking direction
        const doorPositions = [
            pos,                                          // bot's current block
            pos.offset(bestDir.dx, 0, bestDir.dz),        // next block in walking direction
        ];
        for (const doorPos of doorPositions) {
            const doorCheck = bot.blockAt(doorPos);
            if (doorCheck && doorCheck.name.includes('door')) {
                const doorProps = doorCheck.getProperties();
                const isOpen = doorProps['open'] === true || doorProps['open'] === 'true';
                if (!isOpen) {
                    console.log(`[MC Stuck] Opening door at ${String(doorCheck.position)} before walk-through`);
                    await bot.activateBlock(doorCheck);
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        }

        // Look toward the center of the opening (2 blocks ahead)
        await bot.lookAt(
            pos.offset(bestDir.dx * 2, 0.5, bestDir.dz * 2),
            true,
        );

        // Sprint forward through the opening
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);

        await new Promise(r => setTimeout(r, 600));
        restoreAndCleanup();

        const endPos = bot.entity.position;
        const recoveryDist = startPos.distanceTo(endPos);
        const success = recoveryDist > 0.3;
        console.log(
            `[MC Stuck] Narrow-passage done: moved ${recoveryDist.toFixed(2)}` +
            ` ${success ? 'OK' : 'FAILED'}`,
        );
        return { moved: recoveryDist, success };
    } catch (err) {
        console.warn(`[MC Stuck] Narrow-passage failed: ${String(err)}`);
        restoreAndCleanup();
        const endPos = bot.entity.position;
        const recoveryDist = startPos.distanceTo(endPos);
        return { moved: recoveryDist, success: false };
    }
}
