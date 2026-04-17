// ---- Auto-swim (stay afloat) ----
// When the bot is in water, hold jump to swim upward and stay at the surface.
// Without this, the bot sinks and drowns if it enters water while idle.

import type { Bot } from 'mineflayer';
import { isInWater } from '../mineflayer-types';

export function setupAutoSwim(bot: Bot): void {
    let wasSwimming = false;
    bot.on('physicsTick', () => {
        const inWater = isInWater(bot.entity);
        if (inWater) {
            if (!wasSwimming) {
                console.log(`[${bot.username}] Entered water — auto-swimming`);
                wasSwimming = true;
            }
            bot.setControlState('jump', true);
        } else if (wasSwimming) {
            bot.setControlState('jump', false);
            wasSwimming = false;
            console.log(`[${bot.username}] Left water — stopped swimming`);
        }
    });
}
