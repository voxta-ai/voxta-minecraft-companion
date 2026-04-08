// ---- Shared types and constants for the blueprint system ----

export type BlockRole = 'floor_patch' | 'wall' | 'roof' | 'interior';

export interface BlueprintBlock {
    /** Offset from origin (front-left corner at ground level) */
    dx: number;
    dy: number;
    dz: number;
    /** Default block type (will be substituted based on inventory) */
    block: string;
    /** Role determines which material priority chain is used */
    role: BlockRole;
}

export interface Blueprint {
    name: string;
    displayName: string;
    width: number;
    depth: number;
    height: number;
    blocks: BlueprintBlock[];
}

// ---- Material priority chains ----
// The build engine picks the first material the bot has enough of.
// If no single material suffices, it combines from the chain.

export const WALL_MATERIALS = [
    'cobblestone', 'stone', 'deepslate',
    'oak_planks', 'spruce_planks', 'birch_planks',
    'jungle_planks', 'acacia_planks', 'dark_oak_planks',
    'mangrove_planks', 'cherry_planks',
    'dirt',
];

export const ROOF_MATERIALS = [
    'oak_planks', 'spruce_planks', 'birch_planks',
    'jungle_planks', 'acacia_planks', 'dark_oak_planks',
    'mangrove_planks', 'cherry_planks',
    'cobblestone', 'stone',
    'dirt',
];
