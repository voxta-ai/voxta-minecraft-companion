import type { Bot } from 'mineflayer';
import { BED_BLOCKS } from '../game-data';
import { findAndReachBlock } from './action-helpers.js';
import { saveHome } from './action-state.js';
import { getErrorMessage } from '../utils';

function findAndReachBed(bot: Bot) {
    return findAndReachBlock(
        bot,
        (block) => BED_BLOCKS.includes(block.name),
        'Looked around but there is no bed nearby',
        'Cannot reach the bed from here',
    );
}

export async function sleepInBed(bot: Bot): Promise<string> {
    const result = await findAndReachBed(bot);
    if ('error' in result) return result.error;
    const bedBlock = result.block;

    // Try to sleep
    try {
        await bot.sleep(bedBlock);
        saveHome(bot, bedBlock);
        return 'Climbed into bed and fell asleep (home set here)';
    } catch (err) {
        const message = getErrorMessage(err);

        // Can't sleep but can still set spawn point by tapping the bed
        if (message.includes('not night') || message.includes('occupied') || message.includes('monsters')) {
            try {
                await bot.activateBlock(bedBlock);
                saveHome(bot, bedBlock);
            } catch {
                // activateBlock can fail if too far — home not set
            }
        }

        if (message.includes('not night')) return 'Cannot sleep during the day, but remembered this bed as home';
        if (message.includes('occupied')) return 'Cannot sleep — someone else is already in the bed (remembered it as home)';
        if (message.includes('monsters')) return 'Cannot sleep — there are monsters lurking nearby (remembered this bed as home)';
        return `Cannot sleep: ${message}`;
    }
}

export async function setHomeBed(bot: Bot): Promise<string> {
    const result = await findAndReachBed(bot);
    if ('error' in result) return result.error;
    const bedBlock = result.block;

    // Tap the bed to set spawn point (works any time of day)
    try {
        await bot.activateBlock(bedBlock);
        saveHome(bot, bedBlock);
        return 'Remembered this bed as home';
    } catch (err) {
        const message = getErrorMessage(err);
        return `Failed to set home: ${message}`;
    }
}
