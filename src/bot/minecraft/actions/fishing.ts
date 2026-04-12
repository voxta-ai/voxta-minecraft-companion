import type { Bot } from 'mineflayer';
import { getActionAbort, getOnFishCaught } from './action-state.js';
import { getErrorMessage } from '../utils';

export async function fishAction(bot: Bot, countStr: string | undefined): Promise<string> {
    // Find and equip a fishing rod
    const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
    if (!rod) return 'Checked inventory but has no fishing rod';

    try {
        await bot.equip(rod, 'hand');
    } catch {
        return 'Failed to equip fishing rod';
    }

    // Find nearest SURFACE water block (water with air above it)
    const pos = bot.entity.position;
    let nearestWater: { x: number; y: number; z: number; dist: number } | null = null;
    const SCAN_RANGE = 10;
    for (let dx = -SCAN_RANGE; dx <= SCAN_RANGE; dx++) {
        for (let dz = -SCAN_RANGE; dz <= SCAN_RANGE; dz++) {
            for (let dy = -3; dy <= 1; dy++) {
                const block = bot.blockAt(pos.offset(dx, dy, dz));
                if (!block || block.name !== 'water') continue;
                // Must be surface water — air (or non-solid) above it
                const above = bot.blockAt(pos.offset(dx, dy + 1, dz));
                if (above && above.name !== 'air' && above.name !== 'water') continue;
                const dist = Math.sqrt(dx * dx + dz * dz); // Horizontal distance only
                if (!nearestWater || dist < nearestWater.dist) {
                    nearestWater = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz, dist };
                }
            }
        }
    }
    if (!nearestWater) return 'Cannot fish here — no water nearby. Need to find a lake, river, or ocean first';

    const { Vec3 } = require('vec3');
    const waterVec = new Vec3(nearestWater.x + 0.5, nearestWater.y, nearestWater.z + 0.5);

    // Find a solid shore block adjacent to the water to stand on
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let shoreBlock: { x: number; y: number; z: number } | null = null;
    let bestShoreDist = Infinity;
    for (const [ddx, ddz] of directions) {
        const sx = nearestWater.x + ddx;
        const sz = nearestWater.z + ddz;
        // Check a few Y levels to find solid ground
        for (let sy = nearestWater.y - 1; sy <= nearestWater.y + 2; sy++) {
            const block = bot.blockAt(new Vec3(sx, sy, sz));
            const above = bot.blockAt(new Vec3(sx, sy + 1, sz));
            if (block && block.boundingBox === 'block' && block.name !== 'water'
                && above && (above.name === 'air' || above.name === 'tall_grass' || above.name === 'short_grass')) {
                const dist = Math.sqrt((sx - pos.x) ** 2 + (sz - pos.z) ** 2);
                if (dist < bestShoreDist) {
                    bestShoreDist = dist;
                    shoreBlock = { x: sx, y: sy + 1, z: sz }; // Stand ON TOP of the solid block
                }
            }
        }
    }

    // Walk to the shore block (or near the water if no shore found)
    const targetPos = shoreBlock
        ? new Vec3(shoreBlock.x + 0.5, shoreBlock.y, shoreBlock.z + 0.5)
        : waterVec;

    const distToTarget = Math.sqrt((targetPos.x - pos.x) ** 2 + (targetPos.z - pos.z) ** 2);
    if (distToTarget > 1.5) {
        console.log(`[Fish] Walking to shore at (${Math.round(targetPos.x)}, ${Math.round(targetPos.y)}, ${Math.round(targetPos.z)})...`);
        const pkg = (await import('mineflayer-pathfinder')).default;
        const goal = new pkg.goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1);
        bot.pathfinder.setGoal(goal, false);
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { bot.pathfinder.stop(); resolve(); }, 5000);
            bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
        });
    }

    // Face the water surface and give the server time to register
    await bot.lookAt(new Vec3(waterVec.x, nearestWater.y + 1, waterVec.z));
    await new Promise((r) => setTimeout(r, 350));
    console.log(`[Fish] Facing water at (${Math.round(nearestWater.x)}, ${nearestWater.y}, ${Math.round(nearestWater.z)})`);

    const targetCount = countStr ? parseInt(countStr, 10) : 5;
    if (isNaN(targetCount) || targetCount <= 0) return `Invalid count: ${countStr}`;

    const signal = getActionAbort(bot).signal;
    const caught = new Map<string, number>(); // displayName → count
    let totalCaught = 0;

    const CAST_TIMEOUT_MS = 30_000; // 30s max wait per cast

    for (let i = 0; i < targetCount; i++) {
        if (signal.aborted) break;

        console.log(`[Fish] Cast ${i + 1}/${targetCount} — snapshotting inventory`);

        // Snapshot inventory before cast
        const beforeItems = new Map<string, number>();
        for (const item of bot.inventory.items()) {
            beforeItems.set(item.name, (beforeItems.get(item.name) ?? 0) + item.count);
        }

        const castTime = Date.now();

        // Use Mineflayer's bot.fish() (particle-based bite detection) with a timeout
        // bot.fish() handles: cast → detect bite via world_particles → reel in
        // But it can hang forever if particle detection fails, so we race it with a timeout
        let catchResult: 'caught' | 'timeout' | 'aborted';
        try {
            console.log(`[Fish] Calling bot.fish() (timeout: ${CAST_TIMEOUT_MS / 1000}s)...`);
            await Promise.race([
                bot.fish(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CAST_TIMEOUT_MS)),
                new Promise<never>((_, reject) => {
                    if (signal.aborted) reject(new Error('aborted'));
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
            ]);
            const elapsed = ((Date.now() - castTime) / 1000).toFixed(1);
            console.log(`[Fish] bot.fish() completed — caught after ${elapsed}s`);
            catchResult = 'caught';
        } catch (err) {
            const elapsed = ((Date.now() - castTime) / 1000).toFixed(1);
            const msg = getErrorMessage(err);
            console.log(`[Fish] bot.fish() failed after ${elapsed}s — ${msg}`);
            if (msg === 'aborted' || signal.aborted) {
                catchResult = 'aborted';
            } else if (msg === 'timeout') {
                catchResult = 'timeout';
                // Reel in the rod since bot.fish() was interrupted
                console.log(`[Fish] Reeling in after timeout (activateItem)...`);
                bot.activateItem();
                await new Promise((resolve) => setTimeout(resolve, 500));
            } else {
                // Other errors (e.g. "Fishing canceled", no water nearby)
                catchResult = 'timeout';
            }
        }

        if (catchResult === 'aborted') break;
        if (catchResult === 'timeout') {
            console.log(`[Fish] Timeout — recast next loop`);
            continue;
        }

        // Wait for item to appear in inventory
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Detect what was gained
        let gainedAny = false;
        for (const item of bot.inventory.items()) {
            const prevCount = beforeItems.get(item.name) ?? 0;
            const currentCount = bot.inventory
                .items()
                .filter((i) => i.name === item.name)
                .reduce((sum, i) => sum + i.count, 0);
            const gained = currentCount - prevCount;
            if (gained > 0) {
                const display = item.displayName ?? item.name;
                console.log(`[Fish] Gained: ${gained}x ${display}`);
                caught.set(display, (caught.get(display) ?? 0) + gained);
                totalCaught += gained;
                gainedAny = true;
                // Notify per-catch so the voice chance system can react
                getOnFishCaught(bot)?.(display, gained);
            }
            beforeItems.set(item.name, currentCount);
        }
        if (!gainedAny) {
            console.log(`[Fish] bot.fish() resolved but no new items in inventory`);
        }
    }

    // If aborted (e.g., mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (totalCaught === 0) return "Didn't catch anything — make sure I'm facing open water";

    const parts: string[] = [];
    for (const [name, count] of caught) {
        parts.push(`${count} ${name}`);
    }
    return `Caught ${totalCaught} items: ${parts.join(', ')}`;
}
