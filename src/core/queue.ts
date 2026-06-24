import { opposite, randomTee, step } from "./pieces";
import { Side, type Coord, type PieceType, type QueuePiece } from "./types";

// Queue generation. The forced queue is NOT pure random: we generate a
// guaranteed-connectable path (a self-avoiding walk from the source that stays
// on-grid), emit the pieces that build it, and mix in "non-connector" decoys the
// player has to dump elsewhere. More decoys per level = harder. See levels.ts.

const ALL_SIDES: Side[] = [Side.N, Side.E, Side.S, Side.W];

/** The piece whose two openings are exactly `entry` and `exit`. */
const PIECE_BY_OPENINGS: Record<number, PieceType> = {
  [Side.N | Side.S]: "straight-v",
  [Side.E | Side.W]: "straight-h",
  [Side.N | Side.E]: "bend-ne",
  [Side.N | Side.W]: "bend-nw",
  [Side.S | Side.E]: "bend-se",
  [Side.S | Side.W]: "bend-sw",
};

function pieceFor(entry: Side, exit: Side): PieceType {
  return PIECE_BY_OPENINGS[entry | exit];
}

function keyOf(c: Coord): string {
  return `${c.row},${c.col}`;
}

function shuffled<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface PathStep {
  cell: Coord;
  entry: Side;
  exit: Side;
  piece: PieceType;
}

/**
 * Plan a connectable path of `length` pieces starting just below the source.
 * Every emitted piece's exit leads to an in-bounds, not-yet-used cell, so the
 * path never self-intersects, never runs off the grid, and always has an open
 * end *inside* the grid to continue into. Uses randomised DFS with backtracking,
 * so it reliably reaches `length` as long as the grid can hold length+1 cells.
 */
export function planPath(
  rows: number,
  cols: number,
  source: Coord,
  length: number,
  rng: () => number,
): PathStep[] {
  const inBounds = (c: Coord) =>
    c.row >= 0 && c.row < rows && c.col >= 0 && c.col < cols;
  const visited = new Set<string>([keyOf(source)]);
  const steps: PathStep[] = [];

  const dfs = (cell: Coord, entry: Side, remaining: number): boolean => {
    visited.add(keyOf(cell));
    for (const exit of shuffled(ALL_SIDES.filter((s) => s !== entry), rng)) {
      const next = step(cell, exit);
      if (!inBounds(next) || visited.has(keyOf(next))) continue; // exit must lead somewhere real
      steps.push({ cell, entry, exit, piece: pieceFor(entry, exit) });
      if (remaining === 1) return true; // emitted enough; `next` is the open end
      if (dfs(next, opposite(exit), remaining - 1)) return true;
      steps.pop();
    }
    visited.delete(keyOf(cell));
    return false;
  };

  const first = step(source, Side.S); // source flows down; first cell is below it
  if (length > 0 && inBounds(first)) dfs(first, Side.N, length);
  return steps;
}

/** Just the piece types of a connectable path (the backbone, no decoys). */
export function connectablePath(
  rows: number,
  cols: number,
  source: Coord,
  length: number,
  rng: () => number,
): PieceType[] {
  return planPath(rows, cols, source, length, rng).map((s) => s.piece);
}

export interface ChunkOpts {
  rows: number;
  cols: number;
  source: Coord;
  pathLen: number;
  /** Number of bonus four-way cross tiles to mix in. */
  crosses: number;
  /** Number of bonus three-way T-junction tiles to mix in. */
  tees: number;
  rng: () => number;
}

/** Splice `item` into `script` at a random index, never before index 2. */
function spliceIn(script: QueuePiece[], item: QueuePiece, rng: () => number): void {
  const lo = Math.min(2, script.length);
  const idx = lo + Math.floor(rng() * (script.length - lo + 1));
  script.splice(idx, 0, item);
}

/**
 * A queue chunk: a connectable pipe backbone with bonus crosses and tees spliced
 * in. The queue holds ONLY plain pipe pieces — clogs and power-ups are features
 * of the game BOARD (see game.ts), never things you're handed.
 */
export function buildChunk(opts: ChunkOpts): QueuePiece[] {
  const { rows, cols, source, pathLen, crosses, tees, rng } = opts;

  const script: QueuePiece[] = connectablePath(rows, cols, source, pathLen, rng).map(
    (type) => ({ type }),
  );

  for (let i = 0; i < crosses; i++) {
    spliceIn(script, { type: "cross" }, rng);
  }
  for (let i = 0; i < tees; i++) {
    spliceIn(script, { type: randomTee(rng) }, rng);
  }

  return script;
}
