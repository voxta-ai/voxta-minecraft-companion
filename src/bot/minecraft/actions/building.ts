import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { getBlueprint, getAvailableBlueprints, WALL_MATERIALS, ROOF_MATERIALS } from '../blueprints/index.js';
import type { Blueprint, BlockRole } from '../blueprints/index.js';
import { getActionAbort, setSuppressPickups } from './action-state.js';
import type { NameRegistry } from '../../name-registry.js';
import { getErrorMessage } from '../utils';

// Delay between block placements to avoid server rate limiting
const PLACE_DELAY_MS = 200;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Set to true to log every block placement with coordinates
const BUILD_DEBUG = false;

// ---- Types ----

interface MaterialAllocation {
    /** Maps block role → actual block name to use */
    wallMaterial: string;
    roofMaterial: string;
    available: number;
    needed: number;
    missing: string[];
}

interface BuildResult {
    success: boolean;
    placed: number;
    total: number;
    skipped: number;
    missing: string[];
}

// Progress callback for sending notes during the build
type ProgressCallback = (message: string) => void;
let buildProgressCallback: ProgressCallback | null = null;

export function setBuildProgressCallback(cb: ProgressCallback | null): void {
    buildProgressCallback = cb;
}

// ---- Material resolution ----

/**
 * Count items of a given name in the bot's inventory (including held item).
 */
function countMaterial(bot: Bot, name: string): number {
    return bot.inventory.items()
        .filter((i) => i.name === name)
        .reduce((sum, i) => sum + i.count, 0);
}

/**
 * Pick the best material from a priority chain based on what the bot has.
 * Returns the material name with the highest count.
 */
function pickBestMaterial(bot: Bot, chain: readonly string[]): { name: string; count: number } {
    let bestName = chain[chain.length - 1]; // fallback to last (dirt)
    let bestCount = 0;
    for (const mat of chain) {
        const count = countMaterial(bot, mat);
        if (count > bestCount) {
            bestCount = count;
            bestName = mat;
        }
    }
    return { name: bestName, count: bestCount };
}

/**
 * Calculate material needs and check if the bot has enough.
 */
function resolveMaterials(bot: Bot, blueprint: Blueprint): MaterialAllocation {
    // Count blocks by role
    let wallCount = 0;
    let roofCount = 0;
    for (const block of blueprint.blocks) {
        if (block.role === 'wall') wallCount++;
        else if (block.role === 'roof') roofCount++;
        // floor_patch and interior are conditional — don't count
    }

    const wallPick = pickBestMaterial(bot, WALL_MATERIALS);
    const roofPick = pickBestMaterial(bot, ROOF_MATERIALS);

    const totalNeeded = wallCount + roofCount;

    // Calculate total available across ALL materials in both chains
    // (the bot may have a mix — 30 cobblestone + 20 planks = 50 usable blocks)
    const allMaterials = new Set([...WALL_MATERIALS, ...ROOF_MATERIALS]);
    let grandTotal = 0;
    for (const mat of allMaterials) {
        grandTotal += countMaterial(bot, mat);
    }

    const missing: string[] = [];
    if (grandTotal < totalNeeded) {
        const deficit = totalNeeded - grandTotal;
        missing.push(`${deficit} more blocks (cobblestone, planks, or dirt)`);
    }

    return {
        wallMaterial: wallPick.name,
        roofMaterial: roofPick.name,
        available: grandTotal,
        needed: totalNeeded,
        missing,
    };
}

/**
 * Pick the actual block to use for a given role, checking inventory.
 * Falls back through the priority chain if the chosen material runs out.
 */
function getMaterialForRole(bot: Bot, role: BlockRole, allocation: MaterialAllocation): string | null {
    if (role === 'interior') return null; // interior blocks use their own type
    if (role === 'floor_patch') {
        // Use wall material for patches
        if (countMaterial(bot, allocation.wallMaterial) > 0) return allocation.wallMaterial;
        // Fallback through wall chain
        for (const mat of WALL_MATERIALS) {
            if (countMaterial(bot, mat) > 0) return mat;
        }
        return null;
    }

    const chain = role === 'wall' ? WALL_MATERIALS : ROOF_MATERIALS;
    const preferred = role === 'wall' ? allocation.wallMaterial : allocation.roofMaterial;

    // Try preferred first
    if (countMaterial(bot, preferred) > 0) return preferred;

    // Fallback through chain
    for (const mat of chain) {
        if (countMaterial(bot, mat) > 0) return mat;
    }
    return null;
}

// ---- Site selection ----

interface BuildSite {
    /** World position of the blueprint origin (front-left corner at ground level) */
    originX: number;
    originY: number;
    originZ: number;
}

/**
 * Find a flat area to build on, oriented so the entrance faces the player.
 */
/**
 * Search outward from the bot in expanding rings to find a build site.
 * The entrance is oriented to face the nearest human player.
 */
function findBuildSite(bot: Bot, blueprint: Blueprint): BuildSite | null {
    const Vec3 = require('vec3').Vec3;
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    const halfW = Math.floor(blueprint.width / 2);
    const halfD = Math.floor(blueprint.depth / 2);

    // Search in expanding rings: radius 2, 3, 4, ... up to 10
    for (let radius = 2; radius <= 10; radius++) {
        for (let ox = -radius; ox <= radius; ox++) {
            for (let oz = -radius; oz <= radius; oz++) {
                // Only check the ring perimeter, not the filled square
                if (Math.abs(ox) !== radius && Math.abs(oz) !== radius) continue;

                const originX = bx + ox - halfW;
                const originZ = bz + oz - halfD;
                const site = checkSiteViability(bot, Vec3, blueprint, originX, by, originZ);
                if (site) return site;
            }
        }
    }

    return null;
}

/** Max Y variation across the footprint before a site is rejected */
const MAX_GROUND_Y_VARIATION = 2;

/** Breakable vegetation and ground cover that won't block a build site */
const CLEARABLE_BLOCKS = new Set([
    'short_grass', 'tall_grass', 'fern', 'dandelion', 'poppy',
    'dead_bush', 'seagrass', 'sweet_berry_bush', 'azure_bluet',
    'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'cactus',
    'sugar_cane', 'bamboo', 'snow',
]);

function isClearable(name: string): boolean {
    return CLEARABLE_BLOCKS.has(name) || name.includes('flower') || name.includes('tulip');
}

function checkSiteViability(
    bot: Bot,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Vec3: any,
    blueprint: Blueprint,
    originX: number,
    originY: number,
    originZ: number,
): BuildSite | null {
    // Per-column ground detection: find the ground Y for each column
    // independently, then check if the variation is acceptable.
    let minGroundY = Infinity;
    let maxGroundY = -Infinity;
    let solidCount = 0;
    let totalChecks = 0;
    const columnGroundY: number[][] = [];

    for (let x = 0; x < blueprint.width; x++) {
        columnGroundY[x] = [];
        for (let z = 0; z < blueprint.depth; z++) {
            totalChecks++;
            const wx = originX + x;
            const wz = originZ + z;

            // Scan downward to find ground for this specific column
            let colGround = -1;
            for (let y = originY + 2; y >= originY - 3; y--) {
                const block = bot.blockAt(new Vec3(wx, y, wz));
                if (block && block.boundingBox === 'block') {
                    colGround = y + 1;
                    break;
                }
            }

            if (colGround >= 0) {
                solidCount++;
                columnGroundY[x][z] = colGround;
                if (colGround < minGroundY) minGroundY = colGround;
                if (colGround > maxGroundY) maxGroundY = colGround;
            } else {
                columnGroundY[x][z] = originY;
            }
        }
    }

    // Need at least 60% solid ground (floor patches fill the rest)
    if (solidCount / totalChecks < 0.6) return null;

    // Reject if terrain is too uneven
    if (maxGroundY - minGroundY > MAX_GROUND_Y_VARIATION) return null;

    // Use the most common ground Y as the build level
    const yCounts = new Map<number, number>();
    for (let x = 0; x < blueprint.width; x++) {
        for (let z = 0; z < blueprint.depth; z++) {
            const y = columnGroundY[x][z];
            yCounts.set(y, (yCounts.get(y) ?? 0) + 1);
        }
    }
    let groundY = originY;
    let bestCount = 0;
    for (const [y, count] of yCounts) {
        if (count > bestCount) {
            bestCount = count;
            groundY = y;
        }
    }

    // Check above is clear (height + 1 safety margin)
    for (let x = 0; x < blueprint.width; x++) {
        for (let z = 0; z < blueprint.depth; z++) {
            const wx = originX + x;
            const wz = originZ + z;
            for (let y = 0; y < blueprint.height + 1; y++) {
                const above = bot.blockAt(new Vec3(wx, groundY + y, wz));
                if (above && above.boundingBox === 'block' && !isClearable(above.name)) {
                    // Hard obstruction in the first 2 layers — site not viable
                    if (y < 2) return null;
                }
            }
        }
    }

    return { originX, originY: groundY, originZ };
}

// ---- Reference block resolution ----

interface PlacementRef {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    refBlock: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    faceVec: any;
}

/**
 * Find an adjacent solid block to use as a reference for placing a block
 * at the target position. Returns null if no solid neighbor found.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findReferenceBlock(bot: Bot, Vec3: any, targetX: number, targetY: number, targetZ: number): PlacementRef | null {
    // Try each adjacent position. Prefer below (most reliable for building up).
    const FACES = [
        { dx: 0, dy: -1, dz: 0, fx: 0, fy: 1, fz: 0 },   // below → top face
        { dx: 0, dy: 1, dz: 0, fx: 0, fy: -1, fz: 0 },    // above → bottom face
        { dx: -1, dy: 0, dz: 0, fx: 1, fy: 0, fz: 0 },    // west → east face
        { dx: 1, dy: 0, dz: 0, fx: -1, fy: 0, fz: 0 },    // east → west face
        { dx: 0, dy: 0, dz: -1, fx: 0, fy: 0, fz: 1 },    // north → south face
        { dx: 0, dy: 0, dz: 1, fx: 0, fy: 0, fz: -1 },    // south → north face
    ];

    for (const face of FACES) {
        const adjPos = new Vec3(targetX + face.dx, targetY + face.dy, targetZ + face.dz);
        const adjBlock = bot.blockAt(adjPos);
        if (adjBlock && adjBlock.boundingBox === 'block') {
            return {
                refBlock: adjBlock,
                faceVec: new Vec3(face.fx, face.fy, face.fz),
            };
        }
    }
    return null;
}

// ---- Blueprint rotation ----

/**
 * Rotate a blueprint 90° clockwise N times so the entrance (default: +Z face)
 * ends up facing the desired direction relative to the player.
 *
 * 0 = no rotation (entrance faces +Z)
 * 1 = 90° CW      (entrance faces -X)
 * 2 = 180°        (entrance faces -Z)
 * 3 = 90° CCW     (entrance faces +X)
 */
function rotateBlueprint(blueprint: Blueprint, times: number): void {
    const n = ((times % 4) + 4) % 4; // normalize to 0-3
    for (let r = 0; r < n; r++) {
        const oldW = blueprint.width;
        const oldD = blueprint.depth;
        for (const b of blueprint.blocks) {
            // 90° CW rotation: (dx, dz) → (oldD - 1 - dz, dx)
            const newDx = oldD - 1 - b.dz;
            const newDz = b.dx;
            b.dx = newDx;
            b.dz = newDz;
        }
        blueprint.width = oldD;
        blueprint.depth = oldW;
    }
}

/**
 * Determine how many 90° CW rotations are needed so the entrance
 * (default: +Z face) faces toward the player's position.
 */
function getEntranceRotation(site: BuildSite, blueprint: Blueprint, playerX: number, playerZ: number): number {
    // Center of the build site
    const cx = site.originX + blueprint.width / 2;
    const cz = site.originZ + blueprint.depth / 2;
    const dx = playerX - cx;
    const dz = playerZ - cz;

    // Determine which cardinal direction the player is in
    if (Math.abs(dz) >= Math.abs(dx)) {
        // Player is primarily along Z axis
        return dz >= 0 ? 0 : 2; // +Z (default) or -Z (180°)
    } else {
        // Player is primarily along X axis
        return dx >= 0 ? 3 : 1; // +X (270°) or -X (90°)
    }
}

// ---- Build engine ----

/**
 * Build a structure from a blueprint at a given site.
 */
async function executeBuild(
    bot: Bot,
    blueprint: Blueprint,
    site: BuildSite,
    allocation: MaterialAllocation,
    signal: AbortSignal,
): Promise<BuildResult> {
    const Vec3 = require('vec3').Vec3;
    let placed = 0;
    let skipped = 0;
    const missingItems: string[] = [];
    const total = blueprint.blocks.length;

    // Pre-clear snow layers and vegetation in the footprint.
    // Snow layers have boundingBox 'empty' so bot.dig() can fail if called
    // per-block during placement. Sweeping them first ensures clean ground.
    for (let x = 0; x < blueprint.width; x++) {
        for (let z = 0; z < blueprint.depth; z++) {
            if (signal.aborted) break;
            for (let y = 0; y < blueprint.height; y++) {
                const wx = site.originX + x;
                const wy = site.originY + y;
                const wz = site.originZ + z;
                const block = bot.blockAt(new Vec3(wx, wy, wz));
                if (block && isClearable(block.name)) {
                    try {
                        await bot.dig(block);
                        await delay(100);
                    } catch {
                        // Best effort — block may be out of reach, will retry during placement
                    }
                }
            }
        }
    }

    // Track progress phases for notes
    let lastPhaseNote = '';

    for (let i = 0; i < blueprint.blocks.length; i++) {
        if (signal.aborted) {
            console.log(`[MC Build] Aborted at block ${i}/${total}`);
            break;
        }

        const bp = blueprint.blocks[i];
        const wx = site.originX + bp.dx;
        const wy = site.originY + bp.dy;
        const wz = site.originZ + bp.dz;
        const blockLabel = `#${i} (${bp.dx},${bp.dy},${bp.dz}) ${bp.role}`;

        // --- Floor patch: skip if ground is already solid ---
        if (bp.role === 'floor_patch') {
            const existing = bot.blockAt(new Vec3(wx, wy, wz));
            if (existing && existing.boundingBox === 'block') {
                if (BUILD_DEBUG) console.log(`[MC Build] ${blockLabel} — ground OK, skip patch`);
                continue; // Ground is fine, no patch needed
            }
        }

        // --- Check if block is already placed ---
        const existing = bot.blockAt(new Vec3(wx, wy, wz));
        if (existing && existing.boundingBox === 'block') {
            if (BUILD_DEBUG) console.log(`[MC Build] ${blockLabel} — already exists (${existing.name}), skip`);
            continue; // Something is already there
        }

        // --- Clear obstructions (tall grass, flowers, etc.) ---
        if (existing && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'void_air') {
            try {
                await bot.dig(existing);
                await delay(100);
            } catch {
                // Can't dig it — skip
            }
        }

        // --- Determine which material to use ---
        let blockName: string;
        if (bp.role === 'interior') {
            // Interior blocks use their blueprint-defined type
            blockName = bp.block;
        } else {
            const material = getMaterialForRole(bot, bp.role, allocation);
            if (!material) {
                skipped++;
                if (skipped <= 3) missingItems.push(`blocks for ${bp.role}`);
                continue;
            }
            blockName = material;
        }

        // --- Check if bot has this block in inventory ---
        const item = bot.inventory.items().find((it) => it.name === blockName);
        if (!item) {
            // For interior items (crafting_table, torch), just skip if not available
            if (bp.role === 'interior') {
                console.log(`[MC Build] Skipping interior item ${blockName} — not in inventory`);
                continue;
            }
            skipped++;
            continue;
        }

        // --- Ensure bot is not standing at the target position ---
        // The bot's hitbox is ~1 block wide and ~1.8 blocks tall.
        // If the target is at the bot's feet or head, placeBlock will fail
        // because the server can't place a block where an entity exists.
        const botPos = bot.entity.position;
        const botBlockX = Math.floor(botPos.x);
        const botBlockY = Math.floor(botPos.y);
        const botBlockZ = Math.floor(botPos.z);
        const isAtFeet = botBlockX === wx && botBlockY === wy && botBlockZ === wz;
        const isAtHead = botBlockX === wx && botBlockY + 1 === wy && botBlockZ === wz;
        const isDirectlyBelow = botBlockX === wx && botBlockZ === wz && wy > botBlockY;

        if (isAtFeet || isAtHead || isDirectlyBelow) {
            // Step away — find a clear adjacent position
            const offsets = [
                { ox: 2, oz: 0 }, { ox: -2, oz: 0 },
                { ox: 0, oz: 2 }, { ox: 0, oz: -2 },
                { ox: 2, oz: 2 }, { ox: -2, oz: -2 },
            ];
            let moved = false;
            for (const off of offsets) {
                const safeX = wx + off.ox;
                const safeZ = wz + off.oz;
                const safeGround = bot.blockAt(new Vec3(safeX, wy - 1, safeZ));
                const safeFeet = bot.blockAt(new Vec3(safeX, wy, safeZ));
                if (safeGround?.boundingBox === 'block' && safeFeet?.name === 'air') {
                    try {
                        await bot.pathfinder.goto(new goals.GoalBlock(safeX, wy, safeZ));
                        moved = true;
                        break;
                    } catch {
                        // Try next offset
                    }
                }
            }
            if (!moved) {
                // Fallback: just move 2 blocks away in any direction
                try {
                    await bot.pathfinder.goto(new goals.GoalNear(wx, wy, wz, 2));
                } catch {
                    console.log(`[MC Build] Can't step away from (${wx}, ${wy}, ${wz})`);
                }
            }
        }

        // --- Pathfind to within reach of the target ---
        const currentPos = bot.entity.position;
        const targetVec = new Vec3(wx + 0.5, wy, wz + 0.5);
        const dist = currentPos.distanceTo(targetVec);
        if (dist > 4.0) {
            try {
                await bot.pathfinder.goto(new goals.GoalNear(wx, wy, wz, 3));
            } catch (err) {
                console.log(`[MC Build] Can't reach (${wx}, ${wy}, ${wz}): ${getErrorMessage(err)}`);
                skipped++;
                continue;
            }
        }

        // --- Find reference block ---
        const ref = findReferenceBlock(bot, Vec3, wx, wy, wz);
        if (!ref) {
            console.log(`[MC Build] No reference block for (${wx}, ${wy}, ${wz}) — skipping`);
            skipped++;
            continue;
        }

        // --- Equip the block ---
        try {
            await bot.equip(item, 'hand');
        } catch {
            console.log(`[MC Build] Failed to equip ${blockName}`);
            skipped++;
            continue;
        }

        // --- Look at the reference block face ---
        try {
            const lookTarget = ref.refBlock.position.offset(
                0.5 + ref.faceVec.x * 0.5,
                0.5 + ref.faceVec.y * 0.5,
                0.5 + ref.faceVec.z * 0.5,
            );
            await bot.lookAt(lookTarget, true);
        } catch {
            // Best effort
        }

        // --- Place the block ---
        try {
            // Sneak to prevent accidentally interacting with crafting tables/furnaces
            bot.setControlState('sneak', true);
            await bot.placeBlock(ref.refBlock, ref.faceVec);
            bot.setControlState('sneak', false);

            // Verify placement
            const check = bot.blockAt(new Vec3(wx, wy, wz));
            if (check && check.boundingBox === 'block') {
                if (BUILD_DEBUG) console.log(`[MC Build] ${blockLabel} — PLACED (${blockName})`);
                placed++;
            } else if (check && check.name !== 'air') {
                // Partial success (torch, etc.)
                placed++;
            } else {
                console.log(`[MC Build] Placement not verified at (${wx}, ${wy}, ${wz})`);
                skipped++;
            }
        } catch (err) {
            bot.setControlState('sneak', false);
            const msg = getErrorMessage(err);
            console.log(`[MC Build] placeBlock failed at (${wx}, ${wy}, ${wz}): ${msg}`);

            // Retry once
            try {
                await delay(300);
                const retryRef = findReferenceBlock(bot, Vec3, wx, wy, wz);
                if (retryRef) {
                    bot.setControlState('sneak', true);
                    await bot.placeBlock(retryRef.refBlock, retryRef.faceVec);
                    bot.setControlState('sneak', false);
                    placed++;
                } else {
                    skipped++;
                }
            } catch {
                bot.setControlState('sneak', false);
                skipped++;
            }
        }

        // --- Progress notes ---
        const phaseNote = getPhaseNote(bp.role, placed, total);
        if (phaseNote && phaseNote !== lastPhaseNote) {
            lastPhaseNote = phaseNote;
            buildProgressCallback?.(phaseNote);
        }

        await delay(PLACE_DELAY_MS);
    }

    return {
        success: placed > 0,
        placed,
        total: blueprint.blocks.length,
        skipped,
        missing: missingItems,
    };
}

function getPhaseNote(currentRole: BlockRole, placed: number, _total: number): string | null {
    if (currentRole === 'floor_patch' && placed === 1) return 'Laying the foundation...';
    if (currentRole === 'wall' && placed >= 5 && placed < 20) return 'Walls going up...';
    if (currentRole === 'roof' && placed >= 20) return 'Putting on the roof...';
    if (currentRole === 'interior') return 'Adding finishing touches...';
    return null;
}

// ---- Public API ----

export async function buildStructure(bot: Bot, structureName: string | undefined, names: NameRegistry): Promise<string> {
    if (!structureName) return 'What should I build? Available: ' + getAvailableBlueprints().join(', ');

    const original = getBlueprint(structureName);
    if (!original) {
        return `Don't know how to build "${structureName}". Available: ${getAvailableBlueprints().join(', ')}`;
    }

    // Deep-clone so wall rotation (dx↔dz swap) doesn't mutate the shared
    // blueprint object — custom blueprints return the same reference each time.
    const blueprint: Blueprint = {
        ...original,
        blocks: original.blocks.map((b) => ({ ...b })),
    };

    console.log(`[MC Build] Starting build: ${blueprint.displayName} (${blueprint.blocks.length} blocks)`);

    // Suppress pickup notes during building
    setSuppressPickups(bot, true);

    // --- Step 1: Check materials ---
    const allocation = resolveMaterials(bot, blueprint);
    console.log(`[MC Build] Materials: wall=${allocation.wallMaterial} (${countMaterial(bot, allocation.wallMaterial)}), ` +
        `roof=${allocation.roofMaterial} (${countMaterial(bot, allocation.roofMaterial)}), ` +
        `total available=${allocation.available}, needed=${allocation.needed}`);

    if (allocation.missing.length > 0) {
        setSuppressPickups(bot, false);
        return `Not enough materials to build a ${blueprint.displayName}. Need ${allocation.missing.join(', ')}. ` +
            `Have ${allocation.available} building blocks, need about ${allocation.needed}.`;
    }

    // --- Step 2: Find build site ---
    // Search outward from bot position, then orient entrance toward the player.
    const site = findBuildSite(bot, blueprint);

    if (site) {
        // Orient entrance to face the nearest human player
        const player = bot.nearestEntity(
            (e) => e.type === 'player' && e.username !== bot.username && !names.hasMcUsername(e.username ?? ''),
        );
        if (player) {
            const px = Math.floor(player.position.x);
            const pz = Math.floor(player.position.z);
            const rotations = getEntranceRotation(site, blueprint, px, pz);
            if (rotations !== 0) {
                rotateBlueprint(blueprint, rotations);
                console.log(`[MC Build] Rotated blueprint ${rotations * 90}° to face player`);
            }
        }
    }

    if (!site) {
        setSuppressPickups(bot, false);
        return `Can't find a flat enough spot nearby to build a ${blueprint.displayName}. Help clear an area first.`;
    }
    console.log(`[MC Build] Site selected: origin=(${site.originX}, ${site.originY}, ${site.originZ})`);

    // --- Debug: dump blueprint grid per level ---
    if (BUILD_DEBUG) {
        const levels = new Map<number, Array<{ dx: number; dz: number; role: string }>>();
        for (const b of blueprint.blocks) {
            if (!levels.has(b.dy)) levels.set(b.dy, []);
            levels.get(b.dy)?.push({ dx: b.dx, dz: b.dz, role: b.role });
        }
        for (const [dy, blocks] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
            if (dy === -1) continue; // skip floor patches
            const grid: string[][] = [];
            for (let z = 0; z < blueprint.depth; z++) {
                grid[z] = [];
                for (let x = 0; x < blueprint.width; x++) grid[z][x] = '.';
            }
            for (const b of blocks) {
                const ch = b.role === 'wall' ? 'W' : b.role === 'roof' ? 'R' : b.role === 'interior' ? 'I' : 'F';
                if (b.dz >= 0 && b.dz < blueprint.depth && b.dx >= 0 && b.dx < blueprint.width) {
                    grid[b.dz][b.dx] = ch;
                }
            }
            console.log(`[MC Build] y=${dy}: ${grid.map((row) => row.join('')).join(' | ')}`);
        }
    }

    // --- Step 3: Navigate to the build site ---
    try {
        await bot.pathfinder.goto(
            new goals.GoalNear(
                site.originX + Math.floor(blueprint.width / 2),
                site.originY,
                site.originZ + blueprint.depth, // stand in front of entrance
                2,
            ),
        );
    } catch {
        // Best effort — continue building from current position
        console.log('[MC Build] Could not reach build site exactly, building from current position');
    }

    // --- Step 4: Build ---
    const signal = getActionAbort(bot).signal;

    // Disable pathfinder digging during building — prevents the bot from
    // breaking through walls it just placed to reach the roof.
    // The bot will walk AROUND the shelter instead.
    const savedCanDig = bot.pathfinder.movements.canDig;
    bot.pathfinder.movements.canDig = false;

    buildProgressCallback?.(`Starting to build a ${blueprint.displayName}...`);

    let result: BuildResult;
    try {
        result = await executeBuild(bot, blueprint, site, allocation, signal);
    } finally {
        // Always restore canDig, even on error/abort
        bot.pathfinder.movements.canDig = savedCanDig;
        setSuppressPickups(bot, false);
    }

    // --- Step 5: Report ---
    console.log(`[MC Build] Result: placed=${result.placed}, skipped=${result.skipped}, total=${result.total}`);

    if (signal.aborted) {
        return `Building interrupted. Placed ${result.placed} blocks so far.`;
    }

    if (result.placed === 0) {
        return `Failed to build the ${blueprint.displayName}.`;
    }

    if (result.skipped > 5) {
        return `Finished the ${blueprint.displayName}, but some parts are missing.`;
    }

    return `Finished building the ${blueprint.displayName}.`;
}
