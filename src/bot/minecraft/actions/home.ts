import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { BED_BLOCKS } from '../game-data';
import { saveHome } from './action-state.js';

export async function sleepInBed(bot: Bot): Promise<string> {
    // Find the nearest bed
    const bedBlock = bot.findBlock({
        matching: (block) => BED_BLOCKS.includes(block.name),
        maxDistance: 32,
    });

    if (!bedBlock) return 'No bed found nearby';

    // Walk to the bed
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the bed';
    }

    // Try to sleep
    try {
        await bot.sleep(bedBlock);
        saveHome(bedBlock);
        return 'Went to sleep in bed (home set)';
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Can't sleep but can still set spawn point by tapping the bed
        if (message.includes('not night') || message.includes('occupied') || message.includes('monsters')) {
            try {
                await bot.activateBlock(bedBlock);
                saveHome(bedBlock);
            } catch {
                // activateBlock can fail if too far — home not set
            }
        }

        if (message.includes('not night')) return 'Cannot sleep during the day, but home has been set to this bed';
        if (message.includes('occupied')) return 'Cannot sleep, the bed is occupied (home set to this bed)';
        if (message.includes('monsters')) return 'Cannot sleep, there are monsters nearby (home set to this bed)';
        return `Cannot sleep: ${message}`;
    }
}

export async function setHomeBed(bot: Bot): Promise<string> {
    // Find the nearest bed
    const bedBlock = bot.findBlock({
        matching: (block) => BED_BLOCKS.includes(block.name),
        maxDistance: 32,
    });

    if (!bedBlock) return 'No bed found nearby to set as home';

    // Walk to the bed
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2),
        );
    } catch {
        return 'Cannot reach the bed';
    }

    // Tap the bed to set spawn point (works any time of day)
    try {
        await bot.activateBlock(bedBlock);
        saveHome(bedBlock);
        return `Home set to bed at ${bedBlock.position.x}, ${bedBlock.position.y}, ${bedBlock.position.z}`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Failed to set home: ${message}`;
    }
}
