// ---- Non-full-height block ground fix ----
// Paper servers report onGround=false when the bot stands on blocks with
// non-standard heights (dirt_path/farmland = 15/16, soul_sand = 14/16).
// This prevents jumping, step-up, and reduces movement speed to air-control.
// Fix: detect when the bot is resting on such a block and force onGround=true.

import type { Bot } from 'mineflayer';

/** Blocks shorter than 1.0 and their actual surface heights */
export const NON_FULL_BLOCK_HEIGHTS: Record<string, number> = {
    'dirt_path': 0.9375,     // 15/16
    'farmland': 0.9375,      // 15/16
    'soul_sand': 0.875,      // 14/16
};

/** Maximum gap between bot feet and block surface to count as "standing on" */
const GROUND_FIX_TOLERANCE = 0.03;

export function setupNonFullBlockGroundFix(bot: Bot): void {

    // ---- Ground fix: onGround correction for non-full blocks ----
    bot.on('physicsTick', () => {
        const pos = bot.entity.position;
        const feetY = pos.y;

        const block = bot.blockAt(pos.offset(0, -0.1, 0));
        if (!block) return;

        // Use known height for non-full blocks, or 1.0 for full solid blocks.
        // Paper often reports onGround=false even on full blocks (grass_block,
        // dirt, stone, etc.), crippling movement to airborne acceleration (1/5th
        // normal speed). We must fix onGround for ALL solid blocks, not just
        // the non-full ones.
        let blockHeight = NON_FULL_BLOCK_HEIGHTS[block.name];
        if (blockHeight === undefined) {
            if (block.boundingBox === 'block') {
                blockHeight = 1.0;
            } else {
                return;
            }
        }

        const surface = block.position.y + blockHeight;
        if (Math.abs(feetY - surface) < GROUND_FIX_TOLERANCE) {
            bot.entity.onGround = true;
        }
    });

    // ---- Monkey-patch setControlState to intercept and suppress jump ----
    // The pathfinder sets jump internally; we can't cancel it after the fact
    // because physics already processes it. Intercept at the source.
    const origSetControlState = bot.setControlState.bind(bot);
    bot.setControlState = (control: Parameters<typeof origSetControlState>[0], state: boolean): void => {
        if (control === 'jump' && state) {
            // Suppress jump near shelter entrances (any door within 5 blocks)
            const pos = bot.entity.position;
            try {
                const nearbyDoors = bot.findBlocks({
                    matching: (block) => block.name.includes('door'),
                    maxDistance: 5,
                    count: 1,
                    point: pos,
                });
                if (nearbyDoors.length > 0) {
                    return; // swallow the jump command
                }
            } catch { /* findBlocks can fail before chunks load */ }
        }
        origSetControlState(control, state);
    };

}
