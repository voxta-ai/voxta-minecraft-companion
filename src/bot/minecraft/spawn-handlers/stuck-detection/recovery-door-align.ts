// ---- Door-alignment recovery ----
// When stuck near a door (open or closed), the bot is usually at an angle and
// its hitbox clips the door frame. Strategy: back up to create clearance, open
// any closed doors (handles double doors), strafe to center on the opening,
// then sprint straight through.

import {
    clearRecoveryControls,
    makeForceGroundHandler,
    type RecoveryDeps,
    type RecoveryOutcome,
} from './recovery-shared';

/**
 * Attempt door-alignment recovery. Returns null if no door is within 2 blocks
 * (caller should fall through to the next strategy), otherwise returns the
 * outcome once the alignment sequence completes.
 */
export async function tryDoorAlignRecovery(deps: RecoveryDeps): Promise<RecoveryOutcome | null> {
    const { bot, doorIds, cycle, startPos } = deps;

    let nearbyDoors: ReturnType<typeof bot.findBlocks>;
    try {
        nearbyDoors = bot.findBlocks({
            matching: [...doorIds],
            maxDistance: 2,
            count: 1,
        });
    } catch {
        return null; // findBlocks can fail before chunks load
    }
    if (nearbyDoors.length === 0) return null;

    const doorPos = nearbyDoors[0];
    let doorBlock = bot.blockAt(doorPos);
    if (!doorBlock) return null;

    // Resolve to bottom half for reliable property reading
    try {
        const props = doorBlock.getProperties() as Record<string, unknown>;
        if (String(props['half']) === 'upper') {
            const below = bot.blockAt(doorPos.offset(0, -1, 0));
            if (below && doorIds.has(below.type)) doorBlock = below;
        }
    } catch { /* use as-is */ }

    let doorFacing = 'north';
    let doorIsOpen = false;
    try {
        const props = doorBlock.getProperties() as Record<string, unknown>;
        doorFacing = typeof props['facing'] === 'string' ? props['facing'] : 'north';
        doorIsOpen = String(props['open']) === 'true';
    } catch { /* defaults */ }

    // Door facing north/south → passage along Z, center on X
    // Door facing east/west  → passage along X, center on Z
    const isNS = doorFacing === 'north' || doorFacing === 'south';

    // Detect double doors — check adjacent blocks along the lateral axis
    const allDoors = [doorBlock];
    const lateralOffsets = isNS
        ? [[1, 0], [-1, 0]]  // N/S: check east/west
        : [[0, 1], [0, -1]];  // E/W: check north/south
    for (const [dx, dz] of lateralOffsets) {
        const neighbor = bot.blockAt(doorBlock.position.offset(dx, 0, dz));
        if (neighbor && doorIds.has(neighbor.type)) {
            try {
                const nProps = neighbor.getProperties() as Record<string, unknown>;
                if (String(nProps['half']) !== 'upper' &&
                    String(nProps['facing']) === doorFacing) {
                    allDoors.push(neighbor);
                }
            } catch { /* skip */ }
        }
    }

    // Center of all door blocks (handles single + double doors)
    let doorCenterX = 0;
    let doorCenterZ = 0;
    for (const d of allDoors) {
        doorCenterX += d.position.x + 0.5;
        doorCenterZ += d.position.z + 0.5;
    }
    doorCenterX /= allDoors.length;
    doorCenterZ /= allDoors.length;

    const botPos = bot.entity.position;

    // Determine through direction based on where the player is.
    // The bot's own yaw is unreliable here — the pathfinder may
    // point at an angle or even away from the door when stuck.
    // The bot always wants to reach the player, so we just check
    // which side of the door the player is on.
    const targetPlayer = Object.values(bot.players).find(
        p => p.entity && p.username !== bot.username,
    );
    let throughDx = 0;
    let throughDz = 0;
    if (targetPlayer?.entity) {
        const playerPos = targetPlayer.entity.position;
        if (isNS) {
            throughDz = playerPos.z > doorCenterZ ? 1 : -1;
        } else {
            throughDx = playerPos.x > doorCenterX ? 1 : -1;
        }
    } else {
        // No player visible — fall back to bot's heading
        const yaw = bot.entity.yaw;
        const headingX = -Math.sin(yaw);
        const headingZ = Math.cos(yaw);
        if (isNS) {
            throughDz = Math.abs(headingZ) > 0.1
                ? (headingZ < 0 ? -1 : 1)
                : (botPos.z < doorCenterZ ? 1 : -1);
        } else {
            throughDx = Math.abs(headingX) > 0.1
                ? (headingX < 0 ? -1 : 1)
                : (botPos.x < doorCenterX ? 1 : -1);
        }
    }

    // Calculate lateral offset — how far off-center the bot is
    const lateralOffset = isNS
        ? botPos.x - doorCenterX
        : botPos.z - doorCenterZ;

    const doorDesc = allDoors.length > 1
        ? `double-door at (${doorBlock.position.x},${doorBlock.position.z})+(${allDoors[1].position.x},${allDoors[1].position.z})`
        : `door at (${doorBlock.position.x},${doorBlock.position.z})`;
    console.log(
        `[MC Stuck] Door-align #${cycle}: ${doorDesc}` +
        ` facing=${doorFacing} open=${doorIsOpen}` +
        ` center=(${doorCenterX.toFixed(2)},${doorCenterZ.toFixed(2)})` +
        ` bot=(${botPos.x.toFixed(2)},${botPos.z.toFixed(2)})` +
        ` through=(${throughDx},${throughDz}) offset=${lateralOffset.toFixed(3)}`,
    );

    const goal = bot.pathfinder.goal;
    bot.pathfinder.stop();
    const theDoor = doorBlock;
    const allDoorsRef = allDoors;

    // Boost airborne acceleration to match ground speed.
    // The physicsTick handler sets onGround=true, but it fires
    // AFTER the physics simulation already ran that tick. So every
    // other tick the engine sees onGround=false and uses the tiny
    // airborne acceleration (0.02). Boosting it ensures the bot
    // moves at full speed regardless of onGround timing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedAirborneAccel = (bot as any).physics?.airborneAcceleration;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((bot as any).physics) (bot as any).physics.airborneAcceleration = 0.1;

    const forceGroundHandler = makeForceGroundHandler(bot);

    const restoreAndCleanup = (): void => {
        bot.removeListener('physicsTick', forceGroundHandler);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((bot as any).physics && savedAirborneAccel !== undefined) (bot as any).physics.airborneAcceleration = savedAirborneAccel;
        clearRecoveryControls(bot);
        bot.setControlState('sprint', false);
        if (goal) bot.pathfinder.setGoal(goal, true);
    };

    try {
        bot.on('physicsTick', forceGroundHandler);

        // The bot is stuck at a door at an angle because the
        // pathfinder was heading toward the player who moved
        // sideways after going through. Recovery strategy:
        //   1. Face through the door (perpendicular to the wall)
        //   2. Back up straight to clear the door frame
        //   3. Open any closed doors
        //   4. Strafe laterally to center on the opening
        //   5. Sprint straight through

        const throughPoint = theDoor.position.offset(
            0.5 + throughDx * 2,
            0.5,
            0.5 + throughDz * 2,
        );

        // Step 1: Sprint AWAY from the door to create clearance.
        // Walking backward is too slow (~0.5 blocks in 400ms).
        // Instead: face away, sprint forward, then turn back.
        // This gives ~2-3 blocks of clearance so the strafe won't
        // clip wall corners next to the door frame.
        const awayPoint = theDoor.position.offset(
            0.5 - throughDx * 3,
            0.5,
            0.5 - throughDz * 3,
        );
        await bot.lookAt(awayPoint, true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await new Promise(r => setTimeout(r, 500));
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        await new Promise(r => setTimeout(r, 100));

        // Step 3: Open all closed doors (handles double doors)
        for (const d of allDoorsRef) {
            const freshBlock = bot.blockAt(d.position);
            if (!freshBlock || !doorIds.has(freshBlock.type)) continue;
            try {
                const dProps = freshBlock.getProperties() as Record<string, unknown>;
                if (String(dProps['open']) !== 'true') {
                    const center = freshBlock.position.offset(0.5, 0.5, 0.5);
                    await bot.lookAt(center, true);
                    await bot.activateBlock(freshBlock);
                    console.log(`[MC Stuck] Door-align: opened door at (${freshBlock.position.x},${freshBlock.position.z})`);
                    await new Promise(r => setTimeout(r, 200));
                }
            } catch { /* skip */ }
        }

        // Step 4: Strafe laterally to center on the door opening.
        // Pure sideways movement — no forward/back — so the bot
        // stays at the same distance from the door while centering.
        // Re-aim through the door first so strafe is perpendicular.
        await bot.lookAt(throughPoint, true);

        const postBackupPos = bot.entity.position;
        const currentOffset = isNS
            ? postBackupPos.x - doorCenterX
            : postBackupPos.z - doorCenterZ;

        if (Math.abs(currentOffset) > 0.05) {
            // Strafe left/right are relative to the bot's look direction.
            // When looking along (throughDx, throughDz), the "left" direction
            // in world coords is (throughDz, -throughDx). We care about its
            // lateral component: throughDz for N/S doors, -throughDx for E/W.
            // If that component has opposite sign to offset, 'left' reduces it.
            const leftLateral = isNS ? throughDz : -throughDx;
            const strafeDir: 'left' | 'right' =
                (currentOffset * leftLateral < 0) ? 'left' : 'right';
            const strafeDist = Math.abs(currentOffset);
            // Walk speed ~4.3 blocks/sec → ~230ms/block + buffer
            const strafeDuration = Math.min(Math.max(strafeDist * 250 + 250, 300), 1200);

            console.log(
                `[MC Stuck] Door-align: offset=${currentOffset.toFixed(3)}` +
                ` → strafe ${strafeDir} for ${strafeDuration.toFixed(0)}ms`,
            );

            bot.setControlState(strafeDir, true);
            await new Promise(r => setTimeout(r, strafeDuration));
            bot.setControlState(strafeDir, false);
            await new Promise(r => setTimeout(r, 100));
        } else {
            console.log(`[MC Stuck] Door-align: offset=${currentOffset.toFixed(3)} — centered, skipping strafe`);
        }

        // Step 5: Sprint straight through the door
        await bot.lookAt(throughPoint, true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await new Promise(r => setTimeout(r, 1000));

        restoreAndCleanup();

        const endPos = bot.entity.position;
        const recoveryDist = startPos.distanceTo(endPos);
        const success = recoveryDist > 0.3;
        console.log(
            `[MC Stuck] Door-align done: moved ${recoveryDist.toFixed(2)}` +
            ` ${success ? 'OK' : 'FAILED'}`,
        );
        return { moved: recoveryDist, success };
    } catch (err) {
        console.warn(`[MC Stuck] Door-align failed: ${String(err)}`);
        restoreAndCleanup();
        const endPos = bot.entity.position;
        const recoveryDist = startPos.distanceTo(endPos);
        return { moved: recoveryDist, success: false };
    }
}
