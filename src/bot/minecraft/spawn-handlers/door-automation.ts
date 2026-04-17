// ---- Auto-open doors ----
// When bot is near a closed door while pathfinding, pause, look at the
// door, open it, and walk straight through. Track recently opened doors
// to avoid re-toggling (open→close→open spam).

import type { Bot } from 'mineflayer';

const DOOR_REOPEN_COOLDOWN_MS = 3000;    // Don't re-toggle a recently opened door
const DOOR_CLEANUP_TIMEOUT_MS = 10_000;  // Prune old door-open timestamps

export function setupDoorAutomation(bot: Bot, doorIds: Set<number>): void {
    let activating = false;
    const recentlyOpened = new Map<string, number>(); // "x,z" → timestamp

    // Monkey-patch bot.blockAt so open doors have boundingBox='empty' for ALL callers,
    // including mineflayer's physics engine. Without this, the physics engine treats
    // open doors as solid walls because the block cache doesn't update boundingBox.
    // Door collision shapes are patched at the registry level in bot.ts
    // (open door states have shapes=[]), so no per-block patching is needed here.

    bot.on('physicsTick', () => {
        if (activating) return;
        if (!bot.pathfinder.isMoving() && !bot.pathfinder.goal) return;

        const now = performance.now();
        const pos = bot.entity.position;
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                for (let dy = 0; dy <= 1; dy++) {
                    const block = bot.blockAt(pos.offset(dx, dy, dz));
                    if (!block || !doorIds.has(block.type)) continue;

                    const key = `${block.position.x},${block.position.z}`;

                    // Resolve bottom half for reliable property reading and activation
                    let doorBlock = block;
                    try {
                        const props = block.getProperties() as Record<string, string>;
                        if (props['half'] === 'upper') {
                            const below = bot.blockAt(block.position.offset(0, -1, 0));
                            if (below && doorIds.has(below.type)) {
                                doorBlock = below;
                            }
                        }
                    } catch { /* getProperties may not be available */ }

                    // Read door state — check BOTH the scanned block and resolved bottom half
                    let isOpen: boolean;
                    let facing = 'unknown';
                    let openSource: string;
                    try {
                        const doorProps = doorBlock.getProperties() as Record<string, unknown>;
                        // Property can be boolean true or string 'true' depending on server
                        isOpen = String(doorProps['open']) === 'true';
                        facing = typeof doorProps['facing'] === 'string' ? doorProps['facing'] : 'unknown';
                        openSource = `prop:${String(doorProps['open'])}(${typeof doorProps['open']})`;
                    } catch {
                        try {
                            const blockProps = block.getProperties() as Record<string, unknown>;
                            isOpen = String(blockProps['open']) === 'true';
                            openSource = `fallback:${String(blockProps['open'])}(${typeof blockProps['open']})`;
                        } catch {
                            console.log(`[MC Door] Can't read state at ${key} — skipping`);
                            continue;
                        }
                    }

                    if (isOpen) continue; // Door already open — just walk through

                    // Per-door cooldown to prevent toggle spam
                    const lastOpen = recentlyOpened.get(key);
                    if (lastOpen && now - lastOpen < DOOR_REOPEN_COOLDOWN_MS) continue;

                    const dist = pos.distanceTo(doorBlock.position.offset(0.5, 0, 0.5));
                    activating = true;
                    recentlyOpened.set(key, now);
                    console.log(
                        `[MC Door] ${doorBlock.name} at ${key} state=${openSource} facing=${facing}` +
                        ` dist=${dist.toFixed(1)} — activating (bot at ${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`,
                    );

                    // Look at the door first (Paper requires it), then activate.
                    // No manual forward after — pathfinder handles walking through.
                    const doorCenter = doorBlock.position.offset(0.5, 0.5, 0.5);
                    bot.lookAt(doorCenter, true)
                        .then(() => bot.activateBlock(doorBlock))
                        .then(() => {
                            console.log(`[MC Door] Activated at ${key}`);
                            activating = false;
                        })
                        .catch((err) => {
                            console.warn(`[MC Door] Failed at ${key}: ${err}`);
                            activating = false;
                        });

                    // Clean up old entries
                    for (const [k, t] of recentlyOpened) {
                        if (now - t > DOOR_CLEANUP_TIMEOUT_MS) recentlyOpened.delete(k);
                    }
                    return;
                }
            }
        }
    });
}
