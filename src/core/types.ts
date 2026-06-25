// Framework-agnostic core types. No Phaser imports here — keep this layer pure
// and unit-testable (and portable, e.g. to Flutter, if ever needed).

/** Pipe openings as a bitmask. A piece is just the set of sides it is open on. */
export const Side = {
  N: 1,
  E: 2,
  S: 4,
  W: 8,
} as const;
export type Side = (typeof Side)[keyof typeof Side];

/**
 * Every concrete piece shape. `cross` is the four-way (straight-through on both
 * axes). `blocker` is a solid clog (no openings) — the themed "unflushables".
 */
export type PieceType =
  | "straight-v"
  | "straight-h"
  | "bend-ne"
  | "bend-nw"
  | "bend-se"
  | "bend-sw"
  | "tee-nes"
  | "tee-new"
  | "tee-nsw"
  | "tee-esw"
  | "cross"
  | "source"
  | "terminal"
  | "blocker"
  | "fatberg"; // a giant multi-tile clog boss; can't build through, must blow it up

/** Power effects that fire once when sewage flows through the tile. */
export type PowerType =
  | "speed-up"
  | "speed-down"
  | "protest"
  | "score" // bonus points (good)
  | "freeze" // pauses the flow for a few seconds (good — breathing room)
  | "poison" // drops into the pond and kills a fish instantly (hazard)
  | "rain" // obscures the view a few seconds but heals water quality (mixed)
  | "blitz"; // scatters free pipe pieces into nearby empty tiles (good — chaotic)

/** Themed clog variants (cosmetic) for blocker tiles — the unflushables. */
export type JunkType = "condom" | "wet-wipes" | "cotton-buds" | "sanitary-pad";

/** A placed cell in the grid. `null` cells are empty/unplaced. */
export interface Cell {
  type: PieceType;
  /** Openings bitmask, derived from `type` at placement time. */
  openings: number;
  /** Optional power that fires when sewage first fills this cell. */
  power?: PowerType;
  /** Strength multiplier of the power (2/3/4 = how much the faucet speeds the flow). */
  powerMag?: number;
  /** Cosmetic clog variant when `type === "blocker"`. */
  junk?: JunkType;
}

/** A piece waiting in the forced queue (carries any power/clog flavour). */
export interface QueuePiece {
  type: PieceType;
  power?: PowerType;
  junk?: JunkType;
  /** When set, this piece carries a stick of dynamite — placing it lights a fuse
   *  that detonates to clear an adjacent fatberg. Works on ANY piece shape. */
  dynamite?: boolean;
}

/** Something notable the sewage flowed through this tick (drives the on-screen toast). */
export interface FlowEvent {
  kind: "clog" | "power" | "explosion";
  junk?: JunkType;
  power?: PowerType;
  /** Where it happened (so the scene can drop the junk from that tile into the pond). */
  coord: Coord;
  /** Payload for the effect — e.g. the bonus points a score marker awarded. */
  value?: number;
  /** Extra coords touched by the effect — e.g. the tiles a blitz dropped pipe into. */
  coords?: Coord[];
}

/** Top-level run state machine. WON = sewage reached the treatment works. */
export type GameState = "COUNTDOWN" | "FLOWING" | "GAMEOVER" | "WON";

/** Grid coordinate. row 0 is the top; col 0 is the left. */
export interface Coord {
  row: number;
  col: number;
}
