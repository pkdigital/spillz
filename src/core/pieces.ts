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
  dynamite: Side.N | Side.E | Side.S | Side.W, // four-way pipe with a fuse
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

export const POWER_TYPES: PowerType[] = ["speed-up"]; // the faucet always speeds the flow up

export const JUNK_TYPES: JunkType[] = ["condom", "wet-wipes", "cotton-buds", "sanitary-pad"];

export function randomPower(rng: () => number = Math.random): PowerType {
  return POWER_TYPES[Math.floor(rng() * POWER_TYPES.length)];
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
