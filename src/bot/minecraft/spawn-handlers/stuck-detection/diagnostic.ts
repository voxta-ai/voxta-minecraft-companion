// ---- Stuck diagnostic dump ----
// Triggered on the 3rd+ consecutive stuck cycle to capture the surrounding
// block environment so we can debug what the bot is clipping on.

import type { Bot } from 'mineflayer';
import { isInWater } from '../../mineflayer-types';
import { STUCK_DIAG_Y_MAX, STUCK_DIAG_Y_MIN } from './constants';

export function logStuckDiagnostic(bot: Bot, cycle: number): void {
    const pos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);
    const dirs = [
        { label: 'N', dx: 0, dz: -1 },
        { label: 'S', dx: 0, dz: 1 },
        { label: 'E', dx: 1, dz: 0 },
        { label: 'W', dx: -1, dz: 0 },
    ];
    // One entry per column, bottom to top (y-1 .. y+2); a non-air block with no collision is marked "(empty)"
    const column = (dx: number, dz: number): string => {
        const blocks: string[] = [];
        for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
            const b = bot.blockAt(pos.offset(dx, dy, dz));
            if (!b) blocks.push('unloaded');
            else blocks.push(b.boundingBox === 'empty' && b.name !== 'air' ? `${b.name}(empty)` : b.name);
        }
        return blocks.join('/');
    };
    const survey = [`self ${column(0, 0)}`, ...dirs.map((dir) => `${dir.label} ${column(dir.dx, dir.dz)}`)];
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
    const activeControls = controls.filter((c) => bot.getControlState(c));
    console.log(
        `[MC Stuck] Diagnostic (cycle #${cycle}): pos (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) ` +
        `block (${bx}, ${by}, ${bz}), yaw ${((yaw * 180) / Math.PI).toFixed(1)}°, ` +
        `onGround=${bot.entity.onGround}, inWater=${isInWater(bot.entity)}, controls=[${activeControls.join(', ')}], ` +
        `pathfinder goal=${!!bot.pathfinder.goal} moving=${bot.pathfinder.isMoving()} mining=${bot.pathfinder.isMining()}\n` +
        `  blocks y${STUCK_DIAG_Y_MIN}..y+${STUCK_DIAG_Y_MAX}: ${survey.join('  ')}`,
    );
}
