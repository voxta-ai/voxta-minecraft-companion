// ---- Defensive Wall blueprint ----
//
// A simple 3×3 wall segment with center missing as an arrow slit.
//
//   y=2: W W W
//   y=1: W . W   ← arrow slit
//   y=0: W W W

import type { Blueprint, BlueprintBlock } from './types.js';

export function generateWallBlueprint(): Blueprint {
    const blocks: BlueprintBlock[] = [];

    // Floor patches
    for (let x = 0; x < 3; x++) {
        blocks.push({ dx: x, dy: -1, dz: 0, block: 'cobblestone', role: 'floor_patch' });
    }

    // 3×3 wall with center missing
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
            if (x === 1 && y === 1) continue; // arrow slit
            blocks.push({ dx: x, dy: y, dz: 0, block: 'cobblestone', role: 'wall' });
        }
    }

    return {
        name: 'wall',
        displayName: 'wall',
        width: 3,
        depth: 1,
        height: 3,
        blocks,
    };
}
