import type { Vec3 } from 'vec3';

/** Check if a position has finite (non-NaN, non-Infinity) coordinates */
export function isPositionFinite(pos: Vec3): boolean {
    return Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
}

/**
 * Normalize Mineflayer entity effects — the API returns either an array
 * or a keyed object depending on the server version.
 */
export function normalizeEffects(raw: unknown): Array<{ id: number }> {
    if (!raw) return [];
    return Array.isArray(raw) ? raw : Object.values(raw as Record<string, { id: number }>);
}

/** Extract a human-readable message from an unknown error value */
export function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
