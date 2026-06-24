import { describe, expect, it } from "vitest";
import { Grid } from "../src/core/grid";
import { floodStep } from "../src/core/flow";
import { Side, type Coord } from "../src/core/types";

function grid(cols = 5): Grid {
  return new Grid(cols);
}

function filledSet(...coords: Coord[]): Set<string> {
  return new Set(coords.map((c) => `${c.row},${c.col}`));
}

describe("flood flow", () => {
  it("floods from the source straight down a vertical pipe", () => {
    const g = grid();
    g.set({ row: 0, col: 2 }, "source"); // S
    g.place({ row: 1, col: 2 }, "straight-v"); // N|S
    const { newlyFilled, leaks } = floodStep(g, filledSet({ row: 0, col: 2 }));
    expect(newlyFilled).toHaveLength(1);
    expect(newlyFilled[0].coord).toEqual<Coord>({ row: 1, col: 2 });
    expect(newlyFilled[0].entry).toBe(Side.N);
    expect(leaks).toHaveLength(0);
  });

  it("floods in ALL directions from a four-way cross", () => {
    const g = grid();
    g.set({ row: 1, col: 2 }, "cross"); // open on all four sides
    g.place({ row: 0, col: 2 }, "straight-v");
    g.place({ row: 2, col: 2 }, "straight-v");
    g.place({ row: 1, col: 1 }, "straight-h");
    g.place({ row: 1, col: 3 }, "straight-h");
    const { newlyFilled } = floodStep(g, filledSet({ row: 1, col: 2 }));
    const coords = newlyFilled.map((n) => `${n.coord.row},${n.coord.col}`).sort();
    expect(coords).toEqual(["0,2", "1,1", "1,3", "2,2"]); // all four neighbours
  });

  it("a T-junction branches the flood three ways", () => {
    const g = grid();
    g.set({ row: 1, col: 2 }, "tee-esw"); // open E, S, W (closed N)
    g.place({ row: 1, col: 1 }, "straight-h");
    g.place({ row: 1, col: 3 }, "straight-h");
    g.place({ row: 2, col: 2 }, "straight-v");
    const { newlyFilled } = floodStep(g, filledSet({ row: 1, col: 2 }));
    const coords = newlyFilled.map((n) => `${n.coord.row},${n.coord.col}`).sort();
    expect(coords).toEqual(["1,1", "1,3", "2,2"]); // all three arms
  });

  it("reports an open end (empty/unbuilt) as a leak", () => {
    const g = grid();
    g.set({ row: 0, col: 2 }, "source"); // S, nothing below
    const { newlyFilled, leaks } = floodStep(g, filledSet({ row: 0, col: 2 }));
    expect(newlyFilled).toHaveLength(0);
    expect(leaks).toEqual([{ from: { row: 0, col: 2 }, out: Side.S }]);
  });

  it("an open mouth pressing on a filled mismatched pipe leaks (the stuck-state fix)", () => {
    const g = grid();
    g.set({ row: 1, col: 1 }, "bend-ne"); // N|E
    g.set({ row: 1, col: 2 }, "straight-v"); // N|S — no W opening (a wall to the bend's E)
    // both filled: the bend's E mouth faces the straight's solid wall -> must be a leak
    const { leaks } = floodStep(g, filledSet({ row: 1, col: 1 }, { row: 1, col: 2 }));
    expect(leaks.some((l) => l.from.col === 1 && l.from.row === 1 && l.out === Side.E)).toBe(true);
  });

  it("a clog blocks the sewage (leak, not flow-through)", () => {
    const g = grid();
    g.set({ row: 0, col: 2 }, "source"); // S
    g.place({ row: 1, col: 2 }, "blocker", { junk: "wet-wipes" }); // no openings
    const { newlyFilled, leaks } = floodStep(g, filledSet({ row: 0, col: 2 }));
    expect(newlyFilled).toHaveLength(0);
    expect(leaks).toHaveLength(1);
  });

  it("leaks off a side edge (bounded left/right, not bottom)", () => {
    const g = grid(3);
    g.place({ row: 1, col: 0 }, "bend-nw"); // N|W: W opening points off the left edge
    const { leaks } = floodStep(g, filledSet({ row: 1, col: 0 }));
    // both openings lead nowhere built -> two leaks, one of them off the W edge
    expect(leaks.some((l) => l.out === Side.W)).toBe(true);
  });
});
