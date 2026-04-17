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
    const survey: string[] = [];
    for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        survey.push(`  self  y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
    }
    for (const dir of dirs) {
        for (let dy = STUCK_DIAG_Y_MIN; dy <= STUCK_DIAG_Y_MAX; dy++) {
            const b = bot.blockAt(pos.offset(dir.dx, dy, dir.dz));
            survey.push(`  ${dir.label}     y${dy >= 0 ? '+' : ''}${dy}: ${b?.name ?? 'unloaded'} (${b?.boundingBox ?? '?'})`);
        }
    }
    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
    const activeControls = controls.filter((c) => bot.getControlState(c));
    console.log(
        `[MC Stuck] === DIAGNOSTIC DUMP (cycle #${cycle}) ===\n` +
        `  pos: (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}) block: (${bx}, ${by}, ${bz})\n` +
        `  yaw: ${((yaw * 180) / Math.PI).toFixed(1)}°, onGround: ${bot.entity.onGround}, inWater: ${isInWater(bot.entity)}\n` +
        `  controls: [${activeControls.join(', ')}]\n` +
        `  pathfinder: goal=${!!bot.pathfinder.goal}, moving=${bot.pathfinder.isMoving()}, mining=${bot.pathfinder.isMining()}\n` +
        `  --- Block survey ---\n` +
        survey.join('\n'),
    );
}
