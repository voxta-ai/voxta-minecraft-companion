// ---- Narrow passage / wall-clip stuck detection ----
// Root cause: the pathfinder's physics simulation (canStraightLine) predicts
// the bot CAN reach the next node (returns true → forward=true), but the
// actual physics engine can't move the bot because its hitbox clips a wall
// by ~0.02 blocks. The bot sits there with forward=true but 0 displacement.
//
// The orchestrator below owns all closure state (timers, counters, pre-recovery
// snapshots) and dispatches to one of three recovery strategies:
//   1. Door alignment — if a door is within 2 blocks
//   2. Narrow passage — if walls and openings detected on the 3rd+ cycle
//   3. Generic strafe/jump cycle — fallback
//
// Each strategy returns a RecoveryOutcome and the orchestrator handles the
// post-recovery state reset in one place (no duplicated cleanup paths).

import type { Bot } from 'mineflayer';
import type { Vec3 } from 'vec3';
import {
    STUCK_DETECTION_TIMEOUT_MS,
    STUCK_MAX_CYCLES,
    STUCK_MOVEMENT_THRESHOLD,
    STUCK_POST_RECOVERY_GRACE_MS,
    STUCK_PROGRESS_INTERVAL_MS,
    STUCK_PROGRESS_MIN_DIST,
    STUCK_REAL_MOVE_THRESHOLD,
    ZONE_STUCK_RADIUS,
} from './constants';
import { logStuckDiagnostic } from './diagnostic';
import { tryDoorAlignRecovery } from './recovery-door-align';
import { tryNarrowPassageRecovery } from './recovery-narrow-passage';
import { runGenericRecovery } from './recovery-generic';
import type { RecoveryDeps, RecoveryOutcome } from './recovery-shared';

export function setupStuckDetection(bot: Bot, doorIds: Set<number>): void {
    let stuckSince: number | null = null;
    let noPathSince: number | null = null;       // Separate timer for "no path" state (prevents leak into physically-stuck timer)
    let lastMovePos = bot.entity.position.clone();
    let preRecoveryPos: Vec3 = bot.entity.position.clone();  // Position before any recovery attempts
    let zoneStuckPos: Vec3 | null = null;    // Where the bot FIRST got stuck in this zone
    let consecutiveStuckCount = 0;
    let isRecovering = false;
    let graceUntil = 0;                           // Timestamp — ignore checks until pathfinder re-engages

    // Longer-window progress tracker — catches "jittering without progress"
    // (bot moves > 0.1 blocks per tick but < 0.5 blocks per 3 seconds)
    let lastProgressPos = bot.entity.position.clone();
    let lastProgressCheck = performance.now();

    /** Run recovery strategies in priority order, returning the first applicable outcome. */
    async function runRecovery(deps: RecoveryDeps): Promise<RecoveryOutcome> {
        const doorOutcome = await tryDoorAlignRecovery(deps);
        if (doorOutcome) return doorOutcome;
        if (deps.cycle >= 3) {
            const narrowOutcome = await tryNarrowPassageRecovery(deps);
            if (narrowOutcome) return narrowOutcome;
        }
        return runGenericRecovery(deps);
    }

    bot.on('physicsTick', () => {
        if (isRecovering) return; // Don't check during recovery movement

        const now = performance.now();
        if (now < graceUntil) return; // Post-recovery grace — let pathfinder re-engage

        const hasGoal = !!bot.pathfinder.goal;
        const pos = bot.entity.position;
        const moved = pos.distanceTo(lastMovePos);

        // Bot actually moved — not stuck
        if (moved > STUCK_MOVEMENT_THRESHOLD) {
            if (stuckSince !== null) stuckSince = null;
            if (noPathSince !== null) noPathSince = null;
            if (consecutiveStuckCount > 0) {
                const realMoved = pos.distanceTo(preRecoveryPos);
                if (realMoved > STUCK_REAL_MOVE_THRESHOLD) {
                    // Moved from recovery pos — but are we still in the same stuck zone?
                    if (zoneStuckPos && pos.distanceTo(zoneStuckPos) < ZONE_STUCK_RADIUS) {
                        // Still oscillating in the same area — don't reset counter
                        // This lets narrow-passage recovery (cycle 3) trigger
                    } else {
                        console.log(`[MC Stuck] Genuinely unstuck (moved ${realMoved.toFixed(2)} from pre-recovery pos) after ${consecutiveStuckCount} cycles`);
                        consecutiveStuckCount = 0;
                        zoneStuckPos = null;
                    }
                }
            }
            lastMovePos = pos.clone();

            // Longer-window progress check: bot moved per-tick but is it
            // making real progress? Catches jittering at obstacles.
            if (hasGoal && now - lastProgressCheck > STUCK_PROGRESS_INTERVAL_MS) {
                const progress = pos.distanceTo(lastProgressPos);
                lastProgressPos = pos.clone();
                lastProgressCheck = now;
                if (progress < STUCK_PROGRESS_MIN_DIST) {
                    // Jittering without progress — force into stuck state
                    console.log(
                        `[MC Stuck] Jitter detected: moved ${progress.toFixed(2)} in ${STUCK_PROGRESS_INTERVAL_MS}ms` +
                        ` (threshold: ${STUCK_PROGRESS_MIN_DIST}) — forcing stuck recovery`,
                    );
                    stuckSince = now - STUCK_DETECTION_TIMEOUT_MS - 1; // Force immediate timeout
                    // Fall through to stuck handling below
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        // No goal — nothing to be stuck about
        if (!hasGoal) {
            if (consecutiveStuckCount > 0) {
                console.log(`[MC Stuck] Goal cleared — resetting (was at cycle #${consecutiveStuckCount})`);
                consecutiveStuckCount = 0;
                zoneStuckPos = null;
            }
            stuckSince = null;
            noPathSince = null;
            lastMovePos = pos.clone();
            return;
        }

        // Check WHY the bot isn't moving
        const isMoving = bot.pathfinder.isMoving();
        const forwardOn = bot.getControlState('forward');
        const isPhysicallyStuck = isMoving && forwardOn; // hitbox clip — recovery can help
        const isNoPath = hasGoal && !isMoving;            // no path — recovery won't help

        // Clear no-path state when pathfinder is active again (brief recalculation pauses reset)
        if (!isNoPath && noPathSince !== null) {
            noPathSince = null;
        }

        // "No path" — pathfinder can't find a route. Don't bounce the bot around.
        // Just try opening nearby doors and let the pathfinder retry on its own.
        // Uses a SEPARATE timer (noPathSince) so the clock doesn't leak into
        // the physically-stuck timer and cause false-positive recovery triggers.
        if (isNoPath && !isPhysicallyStuck) {
            if (noPathSince === null) {
                noPathSince = now;
            }
            // Only log after 3s of CONTINUOUS no-path state.
            // The pathfinder briefly sets isMoving()=false during normal
            // recalculations — those ~100-500ms blips are not real stucks
            // and noPathSince gets cleared above when the bot starts moving again.
            const noPathDuration = now - noPathSince;
            if (noPathDuration > 5000) {
                noPathSince = now; // reset timer, keep waiting
                console.log(
                    `[MC Stuck] No path at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)})` +
                    ` — waiting for watchdog to re-set goal`,
                );
            }
            return;
        }

        // Physically stuck — bot is moving with forward=true but not displacing
        if (stuckSince === null) {
            stuckSince = now;
            return; // Wait for timeout before logging — avoid noisy false positives
        }

        if (now - stuckSince <= STUCK_DETECTION_TIMEOUT_MS) return;

        // ---- Recovery dispatch ----
        consecutiveStuckCount++;
        // Record zone center + pre-recovery snapshot on first stuck detection
        if (consecutiveStuckCount === 1) {
            zoneStuckPos = pos.clone();
            preRecoveryPos = pos.clone();
        }

        // Give up after too many consecutive stuck cycles
        if (consecutiveStuckCount >= STUCK_MAX_CYCLES) {
            console.log(`[MC Stuck] Giving up after ${consecutiveStuckCount} consecutive stuck cycles — canceling pathfinder goal`);
            bot.pathfinder.stop();
            consecutiveStuckCount = 0;
            zoneStuckPos = null;
            stuckSince = null;
            lastMovePos = pos.clone();
            return;
        }

        // Diagnostic dump on 3rd+ cycle
        if (consecutiveStuckCount >= 3) {
            logStuckDiagnostic(bot, consecutiveStuckCount);
        }

        isRecovering = true;
        stuckSince = null;
        const deps: RecoveryDeps = {
            bot,
            doorIds,
            cycle: consecutiveStuckCount,
            startPos: pos.clone(),
            preRecoveryPos,
        };

        // Fire-and-forget — physicsTick is gated on isRecovering until cleanup runs
        void runRecovery(deps)
            .catch((err: unknown) => console.warn(`[MC Stuck] Recovery error: ${String(err)}`))
            .finally(() => {
                isRecovering = false;
                graceUntil = performance.now() + STUCK_POST_RECOVERY_GRACE_MS;
                stuckSince = null;
                lastMovePos = bot.entity.position.clone();
            });
    });
}
