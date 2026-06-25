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
 * Order candidate exits so the walk heads toward `target` (the works) by a fraction
 * `directness` (1 = greedy/straight at it, 0 = fully random). This is the "AI": it
 * hands the player the pieces that build a route to the goal, more so on early levels.
 */
function orderExits(
  sides: Side[],
  cell: Coord,
  target: Coord,
  directness: number,
  rng: () => number,
): Side[] {
  return sides
    .map((s) => {
      const nx = step(cell, s);
      const dist = Math.abs(nx.row - target.row) + Math.abs(nx.col - target.col);
      const score = -dist + (rng() - 0.5) * (1 - directness) * 26; // jitter shrinks as directness rises
      return { s, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((o) => o.s);
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
  target?: Coord,
  directness = 0,
): PathStep[] {
  const inBounds = (c: Coord) =>
    c.row >= 0 && c.row < rows && c.col >= 0 && c.col < cols;
  const visited = new Set<string>([keyOf(source)]);
  const steps: PathStep[] = [];

  const dfs = (cell: Coord, entry: Side, remaining: number): boolean => {
    visited.add(keyOf(cell));
    // the assist (target set) never walks back UP — every piece moves toward the works,
    // so the player is only ever handed forward-progress pieces (no useless snake-back).
    const open = ALL_SIDES.filter((s) => s !== entry && !(target && s === Side.N));
    const ordered = target ? orderExits(open, cell, target, directness, rng) : shuffled(open, rng);
    for (const exit of ordered) {
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
  target?: Coord,
  directness = 0,
): PieceType[] {
  return planPath(rows, cols, source, length, rng, target, directness).map((s) => s.piece);
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
  /** Cell the planned path should head toward (the works); omit for a random walk. */
  target?: Coord;
  /** 0..1 — how strongly the path aims at `target` (the early-level assist). */
  directness?: number;
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
  const { rows, cols, source, pathLen, crosses, tees, rng, target, directness = 0 } = opts;

  const script: QueuePiece[] = connectablePath(
    rows,
    cols,
    source,
    pathLen,
    rng,
    target,
    directness,
  ).map((type) => ({ type }));

  for (let i = 0; i < crosses; i++) {
    spliceIn(script, { type: "cross" }, rng);
  }
  for (let i = 0; i < tees; i++) {
    spliceIn(script, { type: randomTee(rng) }, rng);
  }

  return script;
}
