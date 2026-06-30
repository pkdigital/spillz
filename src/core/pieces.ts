import {
  Side,
  type JunkType,
  type PieceType,
  type PowerType,
  type Coord,
} from "./types";

/** Openings bitmask for each piece type. */
export const PIECE_OPENINGS: Record<PieceType, number> = {
  "straight-v": Side.N | Side.S,
  "straight-h": Side.E | Side.W,
  "bend-ne": Side.N | Side.E,
  "bend-nw": Side.N | Side.W,
  "bend-se": Side.S | Side.E,
  "bend-sw": Side.S | Side.W,
  "tee-nes": Side.N | Side.E | Side.S, // three-way junctions (one side closed)
  "tee-new": Side.N | Side.E | Side.W,
  "tee-nsw": Side.N | Side.S | Side.W,
  "tee-esw": Side.E | Side.S | Side.W,
  cross: Side.N | Side.E | Side.S | Side.W, // four-way
  source: Side.S, // toilet outfall at the top; flows down, no entry side
  terminal: Side.N | Side.E | Side.S | Side.W, // treatment works; connect from any side = win
  // (lower levels are forgiving — accepts the sewage from all four sides)
  blocker: 0, // solid clog (unflushable) — sewage can't pass
  fatberg: 0, // giant clog boss — solid, occupies a 2x2 block
  rock: 0, // solid boulder — impassable; clear it with dynamite
};

/** The four T-junction orientations. */
export const TEE_TYPES: PieceType[] = ["tee-nes", "tee-new", "tee-nsw", "tee-esw"];

export function randomTee(rng: () => number = Math.random): PieceType {
  return TEE_TYPES[Math.floor(rng() * TEE_TYPES.length)];
}

/** The basic pipe shapes the path generator uses (no source/cross/blocker). */
export const PLACEABLE_PIECES: PieceType[] = [
  "straight-v",
  "straight-h",
  "bend-ne",
  "bend-nw",
  "bend-se",
  "bend-sw",
];

export const POWER_TYPES: PowerType[] = [
  "speed-up",
  "speed-down",
  "protest",
  "score",
  "freeze",
  "poison",
  "rain",
  "blitz",
];

/** Relative odds a seeded board marker is each power. Faucet (speed up/down) stays common; the
 *  hazard (poison) and the helpers (protest heals quality) are rarer treats. */
const POWER_WEIGHTS: [PowerType, number][] = [
  ["speed-up", 3],
  ["speed-down", 2],
  ["protest", 2],
  ["score", 2],
  ["freeze", 2],
  ["poison", 2],
  ["rain", 2],
  ["blitz", 2],
];

export const JUNK_TYPES: JunkType[] = ["condom", "wet-wipes", "cotton-buds", "sanitary-pad"];

export function randomPower(rng: () => number = Math.random): PowerType {
  const total = POWER_WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [p, w] of POWER_WEIGHTS) {
    if ((r -= w) < 0) return p;
  }
  return "speed-up";
}

export function randomJunk(rng: () => number = Math.random): JunkType {
  return JUNK_TYPES[Math.floor(rng() * JUNK_TYPES.length)];
}

/** The side directly opposite a given side. */
export function opposite(side: Side): Side {
  switch (side) {
    case Side.N:
      return Side.S;
    case Side.S:
      return Side.N;
    case Side.E:
      return Side.W;
    case Side.W:
      return Side.E;
  }
}

/** The neighbouring coord when stepping out of `from` through `side`. */
export function step(from: Coord, side: Side): Coord {
  switch (side) {
    case Side.N:
      return { row: from.row - 1, col: from.col };
    case Side.S:
      return { row: from.row + 1, col: from.col };
    case Side.E:
      return { row: from.row, col: from.col + 1 };
    case Side.W:
      return { row: from.row, col: from.col - 1 };
  }
}

/** Iterate the individual sides set in an openings bitmask. */
export function sidesOf(openings: number): Side[] {
  const all: Side[] = [Side.N, Side.E, Side.S, Side.W];
  return all.filter((s) => (openings & s) !== 0);
}

/**
 * Deterministic-friendly random piece picker for the forced queue.
 * `rng` defaults to Math.random but is injectable so tests stay deterministic.
 */
export function randomPiece(rng: () => number = Math.random): PieceType {
  const i = Math.floor(rng() * PLACEABLE_PIECES.length);
  return PLACEABLE_PIECES[i];
}
