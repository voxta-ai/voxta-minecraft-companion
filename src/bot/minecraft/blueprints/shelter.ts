import type { Blueprint, BlueprintBlock } from './types.js';

/**
 * Generate a 7×7, 4-tall survival shelter blueprint.
 *
 * Layout (top-down, entrance faces +Z / south):
 *
 *       X→  0 1 2 3 4 5 6
 *   Z=0:    W W W W W W W
 *   Z=1:    W . . . . . W     W = wall
 *   Z=2:    W . . . . . W     . = interior (air)
 *   Z=3:    W . . . . . W     E = entrance (air, 2 wide)
 *   Z=4:    W . . . . . W
 *   Z=5:    W . . . . . W
 *   Z=6:    W W E E W W W
 *
 *   Walls: y=0, y=1, y=2 (3 rows)
 *   Entrance: (2,0,6), (3,0,6), (2,1,6), (3,1,6) are air (2 wide × 2 tall)
 *   Door frame: (2,2,6) and (3,2,6) are wall blocks (solid above entrance)
 *   Roof: y=3 (full 7×7 flat)
 */
export function generateShelterBlueprint(): Blueprint {
    const W = 7;  // width (X)
    const D = 7;  // depth (Z)
    const H = 4;  // height (Y): 3 wall rows + 1 roof

    const blocks: BlueprintBlock[] = [];

    // ---- Phase 1: Floor patches ----
    // Only placed where the ground has holes (checked at build time).
    // Cover the full footprint.
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            blocks.push({
                dx: x, dy: -1, dz: z,
                block: 'cobblestone',
                role: 'floor_patch',
            });
        }
    }

    // ---- Phase 2: Walls (layer by layer, bottom to top) ----
    for (let y = 0; y < H - 1; y++) {
        for (let x = 0; x < W; x++) {
            for (let z = 0; z < D; z++) {
                // Only perimeter blocks are walls
                const isPerimeter = x === 0 || x === W - 1 || z === 0 || z === D - 1;
                if (!isPerimeter) continue;

                // Entrance: 2-wide × 2-tall opening at center of south wall
                const isEntrance = (x === 2 || x === 3) && z === D - 1 && y < 2;
                if (isEntrance) continue;

                blocks.push({
                    dx: x, dy: y, dz: z,
                    block: 'cobblestone',
                    role: 'wall',
                });
            }
        }
    }

    // ---- Phase 3: Roof (flat, y=3) ----
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            blocks.push({
                dx: x, dy: H - 1, dz: z,
                block: 'oak_planks',
                role: 'roof',
            });
        }
    }

    // ---- Phase 4: Interior items (optional, placed last) ----
    // Crafting table in a back corner
    blocks.push({
        dx: 1, dy: 0, dz: 1,
        block: 'crafting_table',
        role: 'interior',
    });

    // Torch on back wall (center)
    blocks.push({
        dx: 3, dy: 1, dz: 1,
        block: 'torch',
        role: 'interior',
    });

    return {
        name: 'shelter',
        displayName: 'survival shelter',
        width: W,
        depth: D,
        height: H,
        blocks,
    };
}
