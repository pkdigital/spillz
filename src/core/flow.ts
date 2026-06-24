import type { Grid } from "./grid";
import { opposite, sidesOf, step } from "./pieces";
import type { Coord, Side } from "./types";

/**
 * Flood-fill flow: the sewage isn't a single head, it fills EVERY connected pipe
 * outward from the source at once (branching at crosses/junctions). One BFS ring
 * advances per tick.
 *
 * An open end — a filled cell with an opening whose neighbour can't carry the
 * sewage on (empty / off-grid / clog / mismatched) — is a LEAK.
 */

export interface LeakEdge {
  from: Coord;
  out: Side;
}

export interface NewCell {
  coord: Coord;
  /** Side the sewage first arrives from (for the fill animation). */
  entry: Side;
}

export interface FloodResult {
  /** Cells that fill on this tick (the next ring outward). */
  newlyFilled: NewCell[];
  /** Open ends of the CURRENT filled set that are spilling. */
  leaks: LeakEdge[];
}

function keyOf(c: Coord): string {
  return `${c.row},${c.col}`;
}

/**
 * Given the currently-filled cells, compute the next ring to fill and the open
 * ends that are leaking. Pure: no mutation. The caller fills `newlyFilled` and
 * drains quality for `leaks`.
 */
export function floodStep(grid: Grid, filled: Set<string>): FloodResult {
  const candidates = new Map<string, NewCell>();
  const leaks: LeakEdge[] = [];

  for (const k of filled) {
    const [r, c] = k.split(",").map(Number);
    const here: Coord = { row: r, col: c };
    const cell = grid.get(here);
    if (!cell) continue;

    for (const dir of sidesOf(cell.openings)) {
      const nb = step(here, dir);
      const nbCell = grid.get(nb);
      const connects = !!nbCell && (nbCell.openings & opposite(dir)) !== 0;

      // An open mouth that doesn't connect to a matching pipe is a leak — even if
      // the neighbour is a filled-but-mismatched pipe (sewage pressing on a wall).
      if (!connects) {
        leaks.push({ from: here, out: dir });
        continue;
      }
      // Connected: a new cell becomes a fill candidate; an already-filled one is
      // just internal plumbing (the flood came through there).
      const nbKey = keyOf(nb);
      if (!filled.has(nbKey) && !candidates.has(nbKey)) {
        candidates.set(nbKey, { coord: nb, entry: opposite(dir) });
      }
    }
  }

  return { newlyFilled: [...candidates.values()], leaks };
}
