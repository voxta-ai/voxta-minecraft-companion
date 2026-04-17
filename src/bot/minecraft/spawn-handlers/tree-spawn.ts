// ---- Tree-spawn fix ----
// If the bot spawned on top of a tree (standing on leaves or logs),
// the pathfinder can't find a clean path down and spins in place.
// Detect this and make the bot jump + move off the tree so gravity
// pulls it down naturally (no position teleport — server-safe).

import type { Bot } from 'mineflayer';

const TREE_SPAWN_JUMP_DURATION_MS = 1500;

export function handleTreeSpawn(bot: Bot): void {
    try {
        const pos = bot.entity.position;
        const footBlock = bot.blockAt(pos.offset(0, -1, 0));
        const isOnTree = footBlock && (
            footBlock.name.endsWith('_leaves') || footBlock.name === 'leaves' ||
            footBlock.name.endsWith('_log') || footBlock.name === 'log'
        );
        if (isOnTree) {
            console.log(`[MC] Spawned on tree (${footBlock.name}) — jumping off`);
            // Jump and walk forward briefly to clear the tree canopy
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            setTimeout(() => {
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
            }, TREE_SPAWN_JUMP_DURATION_MS);
        }
    } catch {
        /* chunk not loaded — skip */
    }
}
