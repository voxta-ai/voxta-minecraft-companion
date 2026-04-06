import type { Bot } from 'mineflayer';
import pkg from 'mineflayer-pathfinder';
const { goals } = pkg;
import type { NameRegistry } from '../../name-registry';
import { findPlayerEntity, getBestWeapon } from './action-helpers.js';
import { getActionAbort, setCurrentCombatTarget, getCurrentCombatTarget } from './action-state.js';
import { ENTITY_ALIASES } from '../game-data';

export async function attackEntity(bot: Bot, entityName: string | undefined, names: NameRegistry): Promise<string> {
    if (!entityName) return 'No entity name provided';

    // Resolve: alias → name registry → normalized
    const normalized = entityName.toLowerCase().replace(/ /g, '_');
    const aliased = ENTITY_ALIASES[normalized] ?? normalized;
    const mcName = names.resolveToMc(aliased);

    const target = bot.nearestEntity(
        (e) =>
            e !== bot.entity &&
            (e.username?.toLowerCase() === mcName.toLowerCase() ||
                e.name?.toLowerCase() === mcName.toLowerCase() ||
                e.displayName?.toLowerCase() === mcName.toLowerCase() ||
                e.username?.toLowerCase() === entityName.toLowerCase() ||
                e.name?.toLowerCase() === entityName.toLowerCase() ||
                e.displayName?.toLowerCase() === entityName.toLowerCase()),
    );

    const displayName = names.resolveToVoxta(names.resolveToMc(entityName));

    if (!target) return `Looked around but cannot see any ${displayName} nearby`;

    // Don't chase entities that are too far — fail fast instead of running across the map
    const MAX_ATTACK_RANGE = 32;
    const dist = target.position.distanceTo(bot.entity.position);
    if (dist > MAX_ATTACK_RANGE) {
        return `Looked around but cannot see any ${displayName} nearby (nearest is ${Math.round(dist)} blocks away)`;
    }

    // Auto-equip the best weapon before fighting
    const weapon = getBestWeapon(bot);
    if (weapon) {
        try {
            await bot.equip(weapon.item as number, 'hand');
            console.log(`[MC Action] Equipped ${weapon.name} for combat`);
        } catch {
            // Best effort — continue fighting regardless
        }
    }

    // Auto-equip shield in off-hand if available
    let hasShield = false;
    const shield = bot.inventory.items().find((i) => i.name === 'shield');
    if (shield) {
        try {
            await bot.equip(shield, 'off-hand');
            hasShield = true;
            console.log('[MC Action] Equipped shield for combat');
        } catch {
            // Best effort
        }
    }

    // Track combat target to prevent duplicate attacks from cancelling this fight
    const normalizedTarget = (entityName ?? 'unknown').toLowerCase();
    setCurrentCombatTarget(normalizedTarget);

    // Follow and attack until dead
    const goal = new goals.GoalFollow(target, 2);
    bot.pathfinder.setGoal(goal, true);

    const startTime = Date.now();
    const TIMEOUT_MS = 15000; // 15-second max combat

    return new Promise<string>((resolve) => {
        const signal = getActionAbort().signal;
        const attackLoop = setInterval(() => {
            // Check if canceled
            if (signal.aborted) {
                clearInterval(attackLoop);
                if (getCurrentCombatTarget() === normalizedTarget) setCurrentCombatTarget(null);
                // Don't call pathfinder.stop() — the new action owns it now
                resolve(`Stopped fighting ${displayName}`);
                return;
            }

            // Check if the target is dead (entity removed from world)
            if (!bot.entities[target.id]) {
                clearInterval(attackLoop);
                setCurrentCombatTarget(null);
                bot.pathfinder.stop();
                // If the bot itself died, all entities disappear — don't claim victory
                if (bot.health <= 0) {
                    resolve(`Died while fighting ${displayName}`);
                } else {
                    resolve(`Defeated the ${displayName}`);
                }
                return;
            }

            // Timeout — stop chasing
            if (Date.now() - startTime > TIMEOUT_MS) {
                clearInterval(attackLoop);
                setCurrentCombatTarget(null);
                bot.pathfinder.stop();
                resolve(`Lost sight of ${displayName} and gave up the chase`);
                return;
            }

            // Attack if in range
            const dist = target.position.distanceTo(bot.entity.position);
            if (!Number.isFinite(dist)) return; // Stale entity — skip this tick
            if (dist < 3.5) {
                // Lower shield briefly to attack
                if (hasShield) bot.deactivateItem();
                bot.attack(target);
                // Raise shield again after swing
                if (hasShield) {
                    setTimeout(() => {
                        bot.activateItem(true);
                    }, 100);
                }
            } else if (hasShield) {
                // Keep the shield raised while approaching
                bot.activateItem(true);
            }
        }, 500); // MC attack cooldown is ~500ms
    });
}

export async function lookAtPlayer(bot: Bot, playerName: string | undefined, names: NameRegistry): Promise<string> {
    if (!playerName) return 'No player name provided';

    const player = findPlayerEntity(bot, playerName, names);
    const displayName = names.resolveToVoxta(names.resolveToMc(playerName));
    if (!player) return `Cannot find player "${displayName}" nearby`;

    // Initial look
    await bot.lookAt(player.position.offset(0, 1.6, 0));

    // Continuously track the player until another action cancels us
    const signal = getActionAbort().signal;
    const trackLoop = async (): Promise<void> => {
        while (!signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (signal.aborted) break;

            // Re-find the player in case they moved
            const updated = findPlayerEntity(bot, playerName, names);
            if (!updated) break;

            await bot.lookAt(updated.position.offset(0, 1.6, 0));
        }
    };

    // Start tracking in the background (don't await — action returns immediately)
    void trackLoop();

    return ''; // Silent — AI doesn't need to know about look_at
}
