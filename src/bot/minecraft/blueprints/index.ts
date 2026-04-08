// ---- Blueprint registry ----
//
// Built-in blueprints live as separate modules (shelter.ts, watchtower.ts).
// Custom blueprints can be dropped as JSON files in the blueprints/ folder.
// Both sources are merged into a single registry.

import { readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Blueprint, BlueprintBlock, BlockRole } from './types.js';

// Re-export types for consumers
export type { Blueprint, BlueprintBlock, BlockRole } from './types.js';
export { WALL_MATERIALS, ROOF_MATERIALS } from './types.js';

// Import built-in blueprint generators
import { generateShelterBlueprint } from './shelter.js';
import { generateWatchtowerBlueprint } from './watchtower.js';
import { generateWallBlueprint } from './wall.js';

// ---- Constants ----

const BLUEPRINTS_DIR = join(process.cwd(), 'blueprints');

/** Built-in blueprints (code-generated, each in its own module) */
const BUILTIN_BLUEPRINTS: Record<string, () => Blueprint> = {
    shelter: generateShelterBlueprint,
    watchtower: generateWatchtowerBlueprint,
    wall: generateWallBlueprint,
};

/** Loaded custom blueprints (from JSON files in blueprints/ folder) */
const CUSTOM_BLUEPRINTS: Record<string, Blueprint> = {};

/** Aliases so the AI can use natural language names */
const BLUEPRINT_ALIASES: Record<string, string> = {
    house: 'shelter',
    hut: 'shelter',
    base: 'shelter',
    cabin: 'shelter',
    shack: 'shelter',
    tower: 'watchtower',
    lookout: 'watchtower',
    fence: 'wall',
    barrier: 'wall',
    fortification: 'wall',
};

// ---- Build order sorting ----

/** Role priority for build order — lower number = built first */
const ROLE_ORDER: Record<BlockRole, number> = {
    floor_patch: 0,
    wall: 1,
    roof: 2,
    interior: 3,
};

/**
 * Sort blocks in correct build order so each block always has
 * a reference block nearby. Order: floor patches → walls (layer
 * by layer, y=0 first, perimeter before interior) → roof → interior.
 */
function sortBuildOrder(blocks: BlueprintBlock[], width: number, depth: number): BlueprintBlock[] {
    return [...blocks].sort((a, b) => {
        // Primary: role priority
        const roleA = ROLE_ORDER[a.role] ?? 99;
        const roleB = ROLE_ORDER[b.role] ?? 99;
        if (roleA !== roleB) return roleA - roleB;

        // Secondary: Y level (bottom up)
        if (a.dy !== b.dy) return a.dy - b.dy;

        // Tertiary: perimeter blocks before interior (walls need to be
        // placed first so stair blocks have a face-adjacent reference)
        const aPerimeter = a.dx === 0 || a.dx === width - 1 || a.dz === 0 || a.dz === depth - 1;
        const bPerimeter = b.dx === 0 || b.dx === width - 1 || b.dz === 0 || b.dz === depth - 1;
        if (aPerimeter !== bPerimeter) return aPerimeter ? -1 : 1;

        // Quaternary: Z then X (consistent scan order)
        if (a.dz !== b.dz) return a.dz - b.dz;
        return a.dx - b.dx;
    });
}

// ---- JSON loading ----

interface JsonBlueprintFile {
    name?: string;
    displayName?: string;
    width?: number;
    depth?: number;
    height?: number;
    blocks: Array<{
        dx: number;
        dy: number;
        dz: number;
        block: string;
        role?: BlockRole;
    }>;
}

/**
 * Load a single JSON blueprint file and validate it.
 */
function loadJsonBlueprint(filePath: string): Blueprint | null {
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw) as JsonBlueprintFile;

        if (!data.blocks || !Array.isArray(data.blocks) || data.blocks.length === 0) {
            console.error(`[Blueprints] ${basename(filePath)}: no blocks array found — skipping`);
            return null;
        }

        // Validate each block
        const blocks: BlueprintBlock[] = [];
        for (const b of data.blocks) {
            if (typeof b.dx !== 'number' || typeof b.dy !== 'number' || typeof b.dz !== 'number') {
                console.error(`[Blueprints] ${basename(filePath)}: invalid block offset — skipping file`);
                return null;
            }
            if (!b.block || typeof b.block !== 'string') {
                console.error(`[Blueprints] ${basename(filePath)}: block missing "block" field — skipping file`);
                return null;
            }
            blocks.push({
                dx: b.dx,
                dy: b.dy,
                dz: b.dz,
                block: b.block,
                role: b.role ?? 'wall', // default to wall if role not specified
            });
        }

        // Calculate dimensions from block offsets if not specified
        const maxX = Math.max(...blocks.map((b) => b.dx)) + 1;
        const maxY = Math.max(...blocks.map((b) => b.dy)) + 1;
        const maxZ = Math.max(...blocks.map((b) => b.dz)) + 1;

        const fileName = basename(filePath, '.json');
        const blueprint: Blueprint = {
            name: data.name ?? fileName,
            displayName: data.displayName ?? fileName.replace(/_/g, ' '),
            width: data.width ?? maxX,
            depth: data.depth ?? maxZ,
            height: data.height ?? maxY,
            blocks: sortBuildOrder(blocks, data.width ?? maxX, data.depth ?? maxZ),
        };

        return blueprint;
    } catch (err) {
        console.error(`[Blueprints] Failed to load ${basename(filePath)}:`, err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Scan the blueprints/ directory and load all JSON files.
 * Call this once at startup.
 */
export function loadCustomBlueprints(): void {
    // Create the directory if it doesn't exist (so users know where to put files)
    if (!existsSync(BLUEPRINTS_DIR)) {
        try {
            mkdirSync(BLUEPRINTS_DIR, { recursive: true });
            console.log(`[Blueprints] Created blueprints/ directory at: ${BLUEPRINTS_DIR}`);
        } catch {
            console.log('[Blueprints] Could not create blueprints/ directory');
            return;
        }
    }

    let files: string[];
    try {
        files = readdirSync(BLUEPRINTS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    } catch {
        console.log('[Blueprints] Could not read blueprints/ directory');
        return;
    }

    if (files.length === 0) {
        console.log('[Blueprints] No custom blueprints found in blueprints/ directory');
        return;
    }

    for (const file of files) {
        const filePath = join(BLUEPRINTS_DIR, file);
        const blueprint = loadJsonBlueprint(filePath);
        if (blueprint) {
            CUSTOM_BLUEPRINTS[blueprint.name] = blueprint;
            console.log(`[Blueprints] Loaded custom blueprint: "${blueprint.displayName}" (${blueprint.blocks.length} blocks, ${blueprint.width}×${blueprint.depth}×${blueprint.height})`);
        }
    }

    console.log(`[Blueprints] ${Object.keys(CUSTOM_BLUEPRINTS).length} custom blueprint(s) loaded`);
}

// ---- Public API ----

export function getBlueprint(name: string): Blueprint | undefined {
    const normalized = name.toLowerCase().replace(/ /g, '_');
    const resolved = BLUEPRINT_ALIASES[normalized] ?? normalized;

    // Check custom blueprints first (user overrides built-in)
    if (CUSTOM_BLUEPRINTS[resolved]) return CUSTOM_BLUEPRINTS[resolved];

    // Fall back to built-in
    const generator = BUILTIN_BLUEPRINTS[resolved];
    if (!generator) return undefined;
    const bp = generator();
    bp.blocks = sortBuildOrder(bp.blocks, bp.width, bp.depth);
    return bp;
}

/** List available blueprint names (for error messages and AI context) */
export function getAvailableBlueprints(): string[] {
    return [...Object.keys(BUILTIN_BLUEPRINTS), ...Object.keys(CUSTOM_BLUEPRINTS)];
}
