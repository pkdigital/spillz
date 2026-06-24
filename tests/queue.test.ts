import { describe, expect, it } from "vitest";
import { buildChunk, planPath } from "../src/core/queue";
import { Grid } from "../src/core/grid";
import { floodStep } from "../src/core/flow";
import { PIECE_OPENINGS, opposite, step } from "../src/core/pieces";
import { Side, type Coord } from "../src/core/types";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROWS = 10;
const COLS = 7;
const SOURCE: Coord = { row: 0, col: 3 };

/** Build the path on a grid and flood it; returns how many path cells the sewage reaches. */
function flowThrough(steps: ReturnType<typeof planPath>): number {
  const g = new Grid(COLS);
  g.set(SOURCE, "source");
  for (const s of steps) g.set(s.cell, s.piece);
  const filled = new Set<string>([`${SOURCE.row},${SOURCE.col}`]);
  // Run the flood to completion.
  for (let guard = 0; guard < steps.length + 5; guard++) {
    const { newlyFilled } = floodStep(g, filled);
    if (newlyFilled.length === 0) break;
    for (const n of newlyFilled) filled.add(`${n.coord.row},${n.coord.col}`);
  }
  return filled.size - 1; // exclude the source
}

describe("connectable path generation", () => {
  // Run several seeds — generation is randomised, the guarantees must always hold.
  for (const seed of [1, 7, 42, 99, 1234]) {
    it(`seed ${seed}: produces a 20-piece on-grid, non-intersecting, flowing path`, () => {
      const len = 20;
      const steps = planPath(ROWS, COLS, SOURCE, len, mulberry32(seed));

      expect(steps).toHaveLength(len);

      // all cells in bounds and distinct
      const seen = new Set<string>();
      for (const s of steps) {
        expect(s.cell.row).toBeGreaterThanOrEqual(0);
        expect(s.cell.row).toBeLessThan(ROWS);
        expect(s.cell.col).toBeGreaterThanOrEqual(0);
        expect(s.cell.col).toBeLessThan(COLS);
        const k = `${s.cell.row},${s.cell.col}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }

      // first cell is directly below the source, entered from the north
      expect(steps[0].cell).toEqual({ row: 1, col: SOURCE.col });
      expect(steps[0].entry).toBe(Side.N);

      // each piece's openings are exactly its entry+exit, and consecutive cells link
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        expect(PIECE_OPENINGS[s.piece]).toBe(s.entry | s.exit);
        if (i + 1 < steps.length) {
          expect(step(s.cell, s.exit)).toEqual(steps[i + 1].cell);
          expect(steps[i + 1].entry).toBe(opposite(s.exit));
        }
      }

      // THE guarantee: water flows through every single piece, no early spill
      expect(flowThrough(steps)).toBe(len);
    });
  }

  it("buildChunk mixes crosses and tees into the backbone (no clogs — those are grid obstacles)", () => {
    const chunk = buildChunk({
      rows: ROWS,
      cols: COLS,
      source: SOURCE,
      pathLen: 12,
      crosses: 1,
      tees: 2,
      rng: mulberry32(5),
    });
    expect(chunk).toHaveLength(15); // 12 path + 1 cross + 2 tees
    expect(chunk.filter((p) => p.type === "blocker")).toHaveLength(0); // never in the queue
    expect(chunk.filter((p) => p.type === "cross")).toHaveLength(1);
    expect(chunk.filter((p) => p.type.startsWith("tee-"))).toHaveLength(2);
    expect(chunk.some((p) => p.power)).toBe(false);
  });

  it("never puts powers or clogs in the queue (both are board features)", () => {
    const chunk = buildChunk({
      rows: ROWS,
      cols: COLS,
      source: SOURCE,
      pathLen: 12,
      crosses: 1,
      tees: 2,
      rng: mulberry32(9),
    });
    expect(chunk.some((p) => p.power)).toBe(false);
    expect(chunk.some((p) => p.type === "blocker")).toBe(false);
  });
});
