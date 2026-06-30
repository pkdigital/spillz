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

/** First level rocks (impassable, blow-up-able boulders) can appear. */
export const ROCK_START_ROW = 5;
/** Level from which rocks start clumping into nasty fields. */
export const ROCK_CLUSTER_LEVEL = 7;
/** Per-cell chance an impassable rock is seeded (off the source column). The most painful
 *  obstacle — so it gets steadily more common with depth and level (no longer caps early). */
export function rockChance(level: number, row: number): number {
  if (level < 2 || row < ROCK_START_ROW) return 0;
  return Math.min(0.02 + (level - 2) * 0.013, 0.16);
}
/** Late-game clustering: a rock seeded next to an existing one gets this much added chance, so
 *  boulders clump into walls (route around them, or blow a gap with dynamite). 0 until late. */
export function rockClusterBoost(level: number): number {
  if (level < ROCK_CLUSTER_LEVEL) return 0;
  return Math.min(0.5, (level - ROCK_CLUSTER_LEVEL + 1) * 0.09);
}

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
  // dialled back: the queue no longer spoon-feeds a near-straight route — it weaves more, so the
  // forced pieces demand real placement decisions. Still descends (forward-only); loosens further
  // with depth. (The flow accelerates, so awkward pieces under time pressure is the puzzle.)
  return Math.max(0.35, 0.55 - (level - 1) * 0.05);
}

/**
 * Random NON-connecting decoy pieces spliced into each queue chunk — shapes that (mostly) don't
 * continue the path, so the player has to dump them off-route or overwrite them. This is the main
 * "stop the queue being too forgiving" dial. None land in the first couple of slots (spliceIn keeps
 * the opening fair — i.e. not "at the edge"); the count climbs with depth.
 */
export function decoysForLevel(level: number): number {
  return Math.min(2 + Math.floor((level - 1) * 0.7), 8); // L1:2, L3:3, L5:4, … capped
}

/** How many fish live in this level's pond — the run score is the total saved. */
export function fishForLevel(level: number): number {
  return Math.min(3 + level, 12); // 4 at level 1, growing, capped
}

/** Distinct fish species on show this level (variety grows as you go deeper). */
export function fishSpeciesForLevel(level: number): number {
  return Math.min(2 + level, 6);
}
