// ---- Difficulty curve (all progression knobs live here) --------------------
//
// A "level" is a single sewer OVERFLOW — a finite dump the water company spills.
// You win by containing the whole overflow (diverting `overflowFor(level)` segments
// of sewage through pipe) before the pond dies. `level` is the 1-based run number;
// each deeper level is a bigger dump. Fish saved at the end is the grade.

/**
 * Length of the guaranteed-connectable opening backbone. The first ~20 placeable
 * pieces form a real on-grid path from the source, so the player has a fair,
 * winnable start (the early-hook). See `queue.ts`.
 */
export const OPENING_PATH_LEN = 20;

/** Length of each connectable continuation chunk after the opening. */
export const CHUNK_PATH_LEN = 12;

/** Size of the overflow to contain (segments of sewage diverted) — bigger each level. */
export const OVERFLOW_BASE = 16;
export const OVERFLOW_STEP = 6;
export function overflowFor(level: number): number {
  return OVERFLOW_BASE + (level - 1) * OVERFLOW_STEP;
}

/** First row that can hold a clog obstacle (keeps the opening clean). */
export const OBSTACLE_START_ROW = 3;

/**
 * Per-cell chance a clog (unflushable) obstacle is seeded on a grid row. The
 * unflushables sit ON the grid as hazards to route around (NOT in the queue);
 * they get denser the deeper you dig.
 */
export function obstacleChance(row: number): number {
  return Math.min(0.06 + row * 0.004, 0.18);
}

/** Per-cell chance a power-up tile is seeded on a grid row (also board features). */
export const POWER_CELL_CHANCE = 0.05;

/**
 * Bonus four-way cross tiles per chunk. None in the early levels (it's a powerful,
 * confusing piece for new players); it shows up from level 3 on.
 */
export function crossesForLevel(level: number): number {
  return level >= 6 ? 1 : 0; // the four-way is a confusing, powerful piece — late game only
}

/**
 * Bonus three-way T-junction tiles per chunk. None early (the extra mouth leaks
 * if you can't connect all three — too hard for new players); from level 3 on it
 * ramps 1, 2, 3 (capped).
 */
export function teesForLevel(level: number): number {
  return level < 3 ? 0 : Math.min(1 + Math.floor((level - 3) / 2), 3);
}

/**
 * How goal-directed the queue's planned path is: 1 = it heads straight for the
 * treatment works (so the player is handed the pieces they need), 0 = a random
 * wander. Early levels are very direct (a fair, winnable start); it loosens with
 * depth so later runs demand real routing.
 */
export function directnessForLevel(level: number): number {
  // moderate, not greedy: the path always descends (forward-only) but weaves a little
  // for variety. Higher early = gentler/straighter; it loosens with depth.
  return Math.max(0.3, 0.62 - (level - 1) * 0.05);
}

/** How many fish live in this level's pond — the run score is the total saved. */
export function fishForLevel(level: number): number {
  return Math.min(3 + level, 12); // 4 at level 1, growing, capped
}

/** Distinct fish species on show this level (variety grows as you go deeper). */
export function fishSpeciesForLevel(level: number): number {
  return Math.min(2 + level, 6);
}
