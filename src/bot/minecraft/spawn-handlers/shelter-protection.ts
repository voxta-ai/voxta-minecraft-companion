// ---- Shelter wall protection ----
// When the bot is inside a player-built shelter (roof + utility blocks),
// disable pathfinder digging so it routes through doors instead of
// breaking walls. Explicit mining (bot.dig) is unaffected.

import type { Bot } from 'mineflayer';

const SHELTER_CHECK_INTERVAL_TICKS = 40;  // ~2 seconds
const SHELTER_DETECTION_RADIUS = 16;      // How far to scan for shelter doors
const SHELTER_ROOF_CHECK_MAX_Y = 24;

export function setupShelterProtection(bot: Bot, doorIds: Set<number>): void {
    let tickCounter = 0;
    let lastCanDig = true;

    // Blocks that don't count as a solid roof (natural foliage/trees)
    const NON_ROOF_BLOCKS = new Set([
        'air', 'cave_air', 'void_air',
        'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
        'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
        'azalea_leaves', 'flowering_azalea_leaves',
        'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
        'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
        'short_grass', 'tall_grass', 'fern', 'large_fern',
        'vine', 'glow_lichen', 'hanging_roots', 'moss_carpet',
    ]);

    /** Check if a position has a solid roof overhead */
    function hasRoofAbove(x: number, y: number, z: number): boolean {
        try {
            for (let dy = 2; dy <= SHELTER_ROOF_CHECK_MAX_Y; dy++) {
                const above = bot.blockAt(bot.entity.position.offset(
                    x - bot.entity.position.x,
                    dy,
                    z - bot.entity.position.z,
                ));
                if (above && !NON_ROOF_BLOCKS.has(above.name)) return true;
            }
        } catch { /* chunk not loaded */ }
        return false;
    }

    bot.on('physicsTick', () => {
        tickCounter++;
        if (tickCounter < SHELTER_CHECK_INTERVAL_TICKS) return;
        tickCounter = 0;

        const movements = bot.pathfinder.movements;
        if (!movements) return;

        // Find door blocks within detection range
        const nearbyDoors = bot.findBlocks({
            matching: [...doorIds],
            maxDistance: SHELTER_DETECTION_RADIUS,
            count: 10,
        });

        // No doors nearby — no shelter to protect
        if (nearbyDoors.length === 0) {
            if (!lastCanDig) {
                movements.canDig = true;
                lastCanDig = true;
                console.log('[MC Shelter] No shelter nearby — pathfinder digging enabled');
            }
            return;
        }

        // Check if any nearby door has a roof — a door with a roof = real shelter
        let shelterDetected = false;
        for (const doorPos of nearbyDoors) {
            if (hasRoofAbove(doorPos.x, doorPos.y, doorPos.z)) {
                shelterDetected = true;
                break;
            }
        }

        const shouldDig = !shelterDetected;

        if (shouldDig !== lastCanDig) {
            movements.canDig = shouldDig;
            lastCanDig = shouldDig;
            if (shouldDig) {
                console.log('[MC Shelter] Away from shelter — pathfinder digging enabled');
            } else {
                console.log('[MC Shelter] Shelter nearby — pathfinder digging disabled (use doors)');
                // Force pathfinder to recalculate — the current path may include
                // digging through walls that was planned when canDig was still true.
                const goal = bot.pathfinder.goal;
                if (goal && bot.pathfinder.isMoving()) {
                    bot.pathfinder.setGoal(goal, true);
                }
            }
        }
    });
}
