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
function findBuildSite(bot: Bot, blueprint: Blueprint): BuildSite | null {
    const Vec3 = require('vec3').Vec3;
    const pos = bot.entity.position;
    const bx = Math.floor(pos.x);
    const by = Math.floor(pos.y);
    const bz = Math.floor(pos.z);

    // Search in front of the bot (based on yaw) for a flat area
    const yaw = bot.entity.yaw;
    const forwardX = Math.round(-Math.sin(yaw));
    const forwardZ = Math.round(-Math.cos(yaw));

    // Try distances 3-10 blocks away in the forward direction
    for (let dist = 3; dist <= 10; dist++) {
        const centerX = bx + forwardX * dist;
        const centerZ = bz + forwardZ * dist;

        // Origin is the front-left corner — offset so the entrance faces the bot
        // The entrance is at the center of the south wall (Z = depth - 1)
        // We want the entrance closest to the bot
        const originX = centerX - Math.floor(blueprint.width / 2);
        const originZ = centerZ - Math.floor(blueprint.depth / 2);

        const site = checkSiteViability(bot, Vec3, blueprint, originX, by, originZ);
        if (site) return site;
    }

    // Also try at bot's current position offset slightly
    for (let ox = -3; ox <= 3; ox++) {
        for (let oz = 2; oz <= 6; oz++) {
            const originX = bx + ox;
            const originZ = bz + oz;
            const site = checkSiteViability(bot, Vec3, blueprint, originX, by, originZ);
            if (site) return site;
        }
    }

    return null;
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
    // Find ground level — check the center of the footprint
    const centerX = originX + Math.floor(blueprint.width / 2);
    const centerZ = originZ + Math.floor(blueprint.depth / 2);

    // Scan downward from originY+2 to find solid ground
    let groundY = originY;
    for (let y = originY + 2; y >= originY - 3; y--) {
        const block = bot.blockAt(new Vec3(centerX, y, centerZ));
        if (block && block.boundingBox === 'block') {
            groundY = y + 1; // stand on top of this block
            break;
        }
    }

    // Check the footprint: ground should be mostly solid, space above mostly clear
    let solidCount = 0;
    let totalChecks = 0;

    for (let x = 0; x < blueprint.width; x++) {
        for (let z = 0; z < blueprint.depth; z++) {
            totalChecks++;
            const wx = originX + x;
            const wz = originZ + z;

            // Ground block (one below standing level)
            const ground = bot.blockAt(new Vec3(wx, groundY - 1, wz));
            if (ground && ground.boundingBox === 'block') {
                solidCount++;
            }

            // Check above is clear (height + 1 safety margin)
            for (let y = 0; y < blueprint.height + 1; y++) {
                const above = bot.blockAt(new Vec3(wx, groundY + y, wz));
                if (above && above.boundingBox === 'block') {
                    // Something blocking the build area — check if it's just grass/flowers
                    // (breakable obstructions are OK, we'll clear them)
                    if (above.name !== 'short_grass' && above.name !== 'tall_grass'
                        && above.name !== 'fern' && !above.name.includes('flower')
                        && above.name !== 'dandelion' && above.name !== 'poppy'
                        && above.name !== 'dead_bush' && above.name !== 'seagrass') {
                        // Hard obstruction (tree trunk, rock) — site not viable
                        // Allow up to 5 hard obstructions (imperfect terrain is OK)
                        if (y < 2) return null; // can't have blocks right where walls go
                    }
                }
            }
        }
    }

    // Need at least 60% solid ground (patches will fill the rest)
    if (solidCount / totalChecks < 0.6) return null;

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
    // For thin structures (walls, depth=1): place ahead of the player,
    // oriented perpendicular to their look direction.
    let site: BuildSite | null;
    if (blueprint.depth === 1) {
        // Exclude the bot itself and any other registered bots — find only the human player
        const player = bot.nearestEntity(
            (e) => e.type === 'player' && e.username !== bot.username && !names.hasMcUsername(e.username ?? ''),
        );
        if (player) {
            const yaw = player.yaw ?? 0;
            // Quantize to 4 cardinal directions
            // Minecraft yaw: 0=south(+Z), π/2=west(-X), π=north(-Z), 3π/2=east(+X)
            const sin = Math.sin(yaw);
            const cos = Math.cos(yaw);
            const facingZ = Math.abs(cos) >= Math.abs(sin); // N/S vs E/W

            const px = Math.floor(player.position.x);
            const py = Math.floor(player.position.y);
            const pz = Math.floor(player.position.z);
            const dist = 2; // blocks ahead of player

            if (facingZ) {
                // Player faces N or S → wall spans X-axis (default orientation)
                const dz = cos > 0 ? -dist : dist; // negative cos = south, place ahead
                const originX = px - Math.floor(blueprint.width / 2);
                const originZ = pz + dz;
                site = { originX, originY: py, originZ };
            } else {
                // Player faces E or W → wall spans Z-axis (rotate: swap dx↔dz)
                const dx = sin > 0 ? -dist : dist;
                const originX = px + dx;
                const originZ = pz - Math.floor(blueprint.width / 2);
                // Rotate all blocks: swap dx↔dz
                for (const b of blueprint.blocks) {
                    const tmpDx = b.dx;
                    b.dx = b.dz;
                    b.dz = tmpDx;
                }
                const tmpW = blueprint.width;
                blueprint.width = blueprint.depth;
                blueprint.depth = tmpW;
                site = { originX, originY: py, originZ };
            }
            console.log(`[MC Build] Wall placed ahead of player: origin=(${site.originX}, ${site.originY}, ${site.originZ})`);
        } else {
            site = findBuildSite(bot, blueprint);
        }
    } else {
        site = findBuildSite(bot, blueprint);
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
