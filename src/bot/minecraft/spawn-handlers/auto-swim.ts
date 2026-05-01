// ---- Auto-swim (stay afloat) ----
// When the bot is in water, hold jump to swim upward and stay at the surface.
// Without this, the bot sinks and drowns if it enters water while idle.

import type { Bot } from 'mineflayer';
import { isInWater } from '../mineflayer-types';

export function setupAutoSwim(bot: Bot): void {
    let wasSwimming = false;
    bot.on('physicsTick', () => {
        // Note: at the water surface the bot bobs in/out of water on every
        // physics tick (20×/s), so don't log transitions — it floods the log
        // with hundreds of in/out lines while swimming. Auto-swim itself
        // works regardless; if it broke, the bot would drown loudly.
        const inWater = isInWater(bot.entity);
        if (inWater) {
            wasSwimming = true;
            bot.setControlState('jump', true);
        } else if (wasSwimming) {
            bot.setControlState('jump', false);
            wasSwimming = false;
        }
    });
}
