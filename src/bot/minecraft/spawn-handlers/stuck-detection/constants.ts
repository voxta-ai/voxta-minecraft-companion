// ---- Stuck-detection tuning constants ----

export const STUCK_MOVEMENT_THRESHOLD = 0.1;    // Blocks moved to count as "not stuck"
export const STUCK_DETECTION_TIMEOUT_MS = 800;  // Must be stuck this long before recovery
export const STUCK_RECOVERY_DURATION_MS = 400;  // How long to apply recovery movement
export const STUCK_POST_RECOVERY_GRACE_MS = 400; // Ignore stuck checks while pathfinder re-engages
export const STUCK_REAL_MOVE_THRESHOLD = 0.5;   // Must move this far to count as genuinely unstuck
export const STUCK_PROGRESS_INTERVAL_MS = 1500; // How often to sample progress (longer-window check)
export const STUCK_PROGRESS_MIN_DIST = 0.3;     // Must move this far per progress interval to not be stuck
export const STUCK_DIAG_Y_MIN = -1;
export const STUCK_DIAG_Y_MAX = 2;
export const STUCK_MAX_CYCLES = 6;              // Give up after this many recovery attempts
export const ZONE_STUCK_RADIUS = 2.0;           // If bot keeps getting stuck within this radius, escalate recovery
