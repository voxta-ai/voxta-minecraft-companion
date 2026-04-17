// ---- NaN position/velocity guard ----
// mineflayer's physics engine (prismarine-physics) clones bot.entity.position
// every tick, runs simulation, then REPLACES the reference:
//   bot.entity.position = clonedState.pos
// If the simulation produces NaN (e.g., stale GoalFollow target, arrow
// knockback edge cases), the NaN-infected clone is assigned back.
//
// Fix: intercept writes at TWO levels:
//   1. Vec3 level: block NaN writes to x/y/z properties
//   2. Entity level: when a new Vec3 is assigned, auto-guard it

import type { Bot } from 'mineflayer';

const NAN_WARNING_RATE_LIMIT_MS = 10_000;

export function setupNaNGuards(bot: Bot): void {
    let guardCounter = 0;
    let lastNaNWarnTime = 0;
    let suppressedNaNCount = 0;

    function guardVec3(vec: { x: number; y: number; z: number }, label: string): void {
        const id = ++guardCounter;
        for (const axis of ['x', 'y', 'z'] as const) {
            let _val = vec[axis];
            if (!Number.isFinite(_val)) {
                console.warn(`[MC Guard] ${label}.${axis} was NaN on init! Defaulting to 0 (guard #${id})`);
                _val = 0;
            }
            Object.defineProperty(vec, axis, {
                get() { return _val; },
                set(v: number) {
                    if (Number.isFinite(v)) { _val = v; }
                    else {
                        // Rate-limit NaN warnings — mineflayer sends bursts of
                        // NaN velocity from entity packets, no need to log each one.
                        const now = Date.now();
                        if (now - lastNaNWarnTime > NAN_WARNING_RATE_LIMIT_MS) {
                            if (suppressedNaNCount > 0) {
                                console.warn(`[MC Guard] (suppressed ${suppressedNaNCount} NaN blocks in the last 10s)`);
                            }
                            console.warn(`[MC Guard] NaN ${label}.${axis} BLOCKED (kept ${_val}, guard #${id})`);
                            lastNaNWarnTime = now;
                            suppressedNaNCount = 0;
                        } else {
                            suppressedNaNCount++;
                        }
                    }
                },
                configurable: true,
                enumerable: true,
            });
        }
    }

    // Guard at the entity level so new Vec3 clones are auto-protected
    function guardEntityProp(
        entity: Record<string, unknown>,
        prop: string,
        label: string,
    ): void {
        let _vec = entity[prop] as { x: number; y: number; z: number };
        console.log(`[MC Guard] Setting up entity guard: ${label} = (${_vec?.x?.toFixed(1)}, ${_vec?.y?.toFixed(1)}, ${_vec?.z?.toFixed(1)})`);
        guardVec3(_vec, label);
        Object.defineProperty(entity, prop, {
            get() { return _vec; },
            set(v: { x: number; y: number; z: number }) {
                const hasNaN = !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z);
                if (hasNaN) {
                    console.warn(`[MC Guard] entity.${label} REPLACED with NaN Vec3! (${v.x}, ${v.y}, ${v.z})`);
                    console.warn(new Error('[MC Guard] replacement stack').stack);
                }
                guardVec3(v, label);
                _vec = v;
            },
            configurable: true,
            enumerable: true,
        });
    }

    const entityObj = bot.entity as unknown as Record<string, unknown>;
    guardEntityProp(entityObj, 'position', 'position');
    guardEntityProp(entityObj, 'velocity', 'velocity');
    console.log(`[MC Guard] Guards ACTIVE — pos: (${bot.entity.position.x.toFixed(1)}, ${bot.entity.position.y.toFixed(1)}, ${bot.entity.position.z.toFixed(1)})`);
}
