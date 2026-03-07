import type { Bot } from 'mineflayer';
import { getActionAbort, getOnFishCaught } from './action-state.js';

export async function fishAction(bot: Bot, countStr: string | undefined): Promise<string> {
    // Find and equip a fishing rod
    const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
    if (!rod) return 'No fishing rod in inventory';

    try {
        await bot.equip(rod, 'hand');
    } catch {
        return 'Failed to equip fishing rod';
    }

    const targetCount = countStr ? parseInt(countStr, 10) : 5;
    if (isNaN(targetCount) || targetCount <= 0) return 'Invalid count';

    const signal = getActionAbort().signal;
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
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), CAST_TIMEOUT_MS),
                ),
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
            const msg = err instanceof Error ? err.message : String(err);
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
                // Other errors (e.g. "Fishing cancelled", no water nearby)
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
            const currentCount = bot.inventory.items()
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
                getOnFishCaught()?.(display, gained);
            }
            beforeItems.set(item.name, currentCount);
        }
        if (!gainedAny) {
            console.log(`[Fish] bot.fish() resolved but no new items in inventory`);
        }
    }

    // If aborted (e.g. mc_stop), don't report a result — the stop already did
    if (signal.aborted) return '';

    if (totalCaught === 0) return 'Didn\'t catch anything — make sure I\'m facing open water';

    const parts: string[] = [];
    for (const [name, count] of caught) {
        parts.push(`${count} ${name}`);
    }
    return `Caught ${totalCaught} items: ${parts.join(', ')}`;
}
