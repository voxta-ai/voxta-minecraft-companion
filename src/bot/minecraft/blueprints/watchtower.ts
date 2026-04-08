import type { Blueprint, BlueprintBlock } from './types.js';

/**
 * Generate a 5×5, 8-tall watchtower with an interior spiral staircase,
 * a solid observation deck floor, and crenellated battlements.
 *
 * Layout (top-down):
 *
 *       X→  0 1 2 3 4
 *   Z=0:    W W W W W
 *   Z=1:    W s . s W     s = stair position (varies per Y)
 *   Z=2:    W . . . W     . = air (interior)
 *   Z=3:    W s . s W     W = wall (perimeter)
 *   Z=4:    W W E W W     E = entrance
 *
 * Vertical structure:
 *   y=0-5:  Walls + spiral staircase (6 enclosed layers)
 *   y=6:    Observation deck floor (solid 5×5, gap at stairwell exit)
 *   y=7:    Crenellations (alternating perimeter blocks)
 *
 * Side view:
 *     C . C . C   y=7  crenellations (railing)
 *     F F F F F   y=6  solid floor (walk on this)
 *     W . . . W   y=5  walls
 *     W . . . W   y=4
 *     W . . . W   y=3
 *     W . . . W   y=2
 *     W . . . W   y=1
 *     W . . . W   y=0
 *     W W E W W        entrance
 *
 * Spiral staircase (each step is 1 block up, diagonally adjacent):
 *   y=0: (1,3)  y=1: (1,2)  y=2: (1,1)
 *   y=3: (2,1)  y=4: (3,1)  y=5: (3,2)
 *
 * The stairwell exit at (3,2) on the observation deck floor is left
 * open so the bot can climb through. The bot jumps from the top stair
 * onto the surrounding floor blocks.
 */
export function generateWatchtowerBlueprint(): Blueprint {
    const W = 5;  // width (X)
    const D = 5;  // depth (Z)
    const H = 8;  // total height: 6 wall layers + 1 floor + 1 crenellations

    const blocks: BlueprintBlock[] = [];

    // Spiral staircase — each step is 1Y higher. Each must have a
    // face-adjacent reference block (wall or previous step) for placement.
    const STAIRS: Array<{ x: number; y: number; z: number }> = [
        { x: 1, y: 0, z: 3 },  // near entrance, west side
        { x: 1, y: 1, z: 2 },  // west
        { x: 1, y: 2, z: 1 },  // northwest corner
        { x: 2, y: 3, z: 1 },  // north center
        { x: 3, y: 4, z: 1 },  // northeast corner
        { x: 3, y: 5, z: 2 },  // top of stairs (ref: east wall at 4,5,2)
    ];

    // Build a set for quick lookup: "x,y,z" → is stair position
    const stairSet = new Set<string>();
    for (const s of STAIRS) {
        stairSet.add(`${s.x},${s.y},${s.z}`);
    }

    // ---- Phase 1: Floor patches ----
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            blocks.push({
                dx: x, dy: -1, dz: z,
                block: 'cobblestone',
                role: 'floor_patch',
            });
        }
    }

    // ---- Phase 2: Walls + stairs (y=0 to y=5, 6 layers) ----
    const wallLayers = H - 2;  // 6 wall layers (floor and crenellations are separate)
    for (let y = 0; y < wallLayers; y++) {
        for (let x = 0; x < W; x++) {
            for (let z = 0; z < D; z++) {
                const isPerimeter = x === 0 || x === W - 1 || z === 0 || z === D - 1;

                // Entrance: 1-wide × 2-tall opening at center of south wall
                const isEntrance = x === 2 && z === D - 1 && y < 2;
                if (isEntrance) continue;

                // Check if this is a stair position
                const isStair = stairSet.has(`${x},${y},${z}`);

                if (isPerimeter || isStair) {
                    blocks.push({
                        dx: x, dy: y, dz: z,
                        block: 'cobblestone',
                        role: 'wall',
                    });
                }
            }
        }
    }

    // ---- Phase 3: Observation deck floor (y=6) ----
    // 3 holes at the NE corner (L-shape) for stairwell access.
    //
    //   F F F F F      z=0
    //   F F H H F      z=1
    //   F F F H F      z=2
    //   F F F F F      z=3
    //   F F F F F      z=4
    const stairwellHoles = new Set(['3,1', '3,2', '2,1']);
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            // Leave stairwell opening so the bot can climb through
            if (stairwellHoles.has(`${x},${z}`)) continue;

            blocks.push({
                dx: x, dy: H - 2, dz: z,
                block: 'cobblestone',
                role: 'roof',
            });
        }
    }

    // ---- Phase 4: Crenellations (y=7) ----
    // Alternating perimeter blocks give the classic battlement look.
    // Skip positions above stairwell holes for headroom.
    //
    //   C . C . C      C = crenellation (1 block above the floor)
    //   .       .      . = gap (open, you can see through)
    //   C       C
    //   .       .
    //   C . C . C
    for (let x = 0; x < W; x++) {
        for (let z = 0; z < D; z++) {
            const isPerimeter = x === 0 || x === W - 1 || z === 0 || z === D - 1;
            if (!isPerimeter) continue;

            // Alternating pattern: place block only when (x + z) is even
            if ((x + z) % 2 !== 0) continue;

            // Skip crenellations above stairwell holes (headroom for climbing)
            if (stairwellHoles.has(`${x},${z}`)) continue;

            blocks.push({
                dx: x, dy: H - 1, dz: z,
                block: 'cobblestone',
                role: 'roof',
            });
        }
    }

    // ---- Phase 5: Interior items ----
    // Torch at ground level
    blocks.push({
        dx: 2, dy: 1, dz: 2,
        block: 'torch',
        role: 'interior',
    });

    return {
        name: 'watchtower',
        displayName: 'watchtower',
        width: W,
        depth: D,
        height: H,
        blocks,
    };
}
