import { describe, expect, it } from "vitest";
import { CONFIG, Game } from "../src/core/game";

(CONFIG as { flowJitter: number }).flowJitter = 0; // deterministic flow timing (production wobbles it)

/** Lay a pipe under the toilet (starts the run) and run out the countdown. */
function start(g: Game): void {
  g.grid.place({ row: 1, col: CONFIG.sourceCol }, "straight-v");
  g.update(CONFIG.countdownMs);
}

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

describe("clog obstacles (on the grid, not the queue)", () => {
  it("building over a clog clears it and immediately pollutes (junk falls into the pond)", () => {
    const g = new Game(mulberry32(3));
    let found: { row: number; col: number } | null = null;
    for (let row = CONFIG.rows * 2; row >= 0 && !found; row--) {
      for (let col = 0; col < CONFIG.cols; col++) {
        if (g.grid.get({ row, col })?.type === "blocker") {
          found = { row, col };
          break;
        }
      }
    }
    expect(found).not.toBeNull();
    expect(g.canPlace(found!)).toBe(true);
    const quality = g.balance;
    g.placePiece(found!);
    expect(g.grid.get(found!)?.type).not.toBe("blocker"); // cleared to a pipe
    expect(g.balance).toBeLessThan(quality); // immediate pollution
    expect(g.profitPounds).toBeGreaterThan(0);
    // emits a clog event at that cell so the scene drops the junk into the pond
    expect(g.consumeEvents().some((e) => e.kind === "clog")).toBe(true);
  });

  it("never puts a clog in the queue", () => {
    const g = new Game(mulberry32(11));
    expect(g.queue.every((p) => p.type !== "blocker")).toBe(true);
  });
});

function findMarker(g: Game): { row: number; col: number } | null {
  for (let row = 0; row <= CONFIG.rows * 2; row++) {
    for (let col = 0; col < CONFIG.cols; col++) {
      if (g.powerMarkerAt({ row, col })) return { row, col };
    }
  }
  return null;
}

/** A fresh game seeded so it has at least one power marker on the board. */
function gameWithMarker(): { g: Game; marker: { row: number; col: number } } {
  let g = new Game(mulberry32(2));
  let marker = findMarker(g);
  for (let s = 3; !marker && s < 40; s++) {
    g = new Game(mulberry32(s));
    marker = findMarker(g);
  }
  expect(marker).not.toBeNull();
  return { g, marker: marker! };
}

describe("power-up markers (board features, built through)", () => {
  it("seeds power-ups as ground markers you can build through", () => {
    const { g, marker } = gameWithMarker();
    expect(g.canPlace(marker)).toBe(true); // empty, buildable
    expect(g.queue.every((p) => !p.power)).toBe(true); // never in the queue
    g.placePiece(marker); // build a pipe through it
    expect(g.grid.get(marker)?.power).toBeDefined(); // power baked into the pipe
    expect(g.powerMarkerAt(marker)).toBeUndefined(); // marker consumed
  });

  it("does not fire on placement — it waits for the sewage to arrive", () => {
    const { g, marker } = gameWithMarker();
    g.placePiece(marker);
    expect(g.grid.get(marker)?.power).toBeDefined(); // baked, armed
    expect(g.consumeEvents().some((e) => e.kind === "power")).toBe(false); // hasn't fired yet
  });
});

describe("bosses: fatberg + dynamite", () => {
  function findFatberg(g: Game): { row: number; col: number } | null {
    for (let row = 0; row <= CONFIG.rows * 2; row++) {
      for (let col = 0; col < CONFIG.cols; col++) {
        if (g.grid.get({ row, col })?.type === "fatberg") return { row, col };
      }
    }
    return null;
  }

  it("seeds a 2x2 fatberg on deeper levels that blocks placement", () => {
    let g = new Game(mulberry32(1), CONFIG.fatbergFromLevel);
    let berg = findFatberg(g);
    for (let s = 2; !berg && s < 30; s++) {
      g = new Game(mulberry32(s), CONFIG.fatbergFromLevel);
      berg = findFatberg(g);
    }
    expect(berg).not.toBeNull();
    // it's a 2x2 block
    expect(g.grid.get({ row: berg!.row + 1, col: berg!.col + 1 })?.type).toBe("fatberg");
    // and you can't build through it
    expect(g.canPlace(berg!)).toBe(false);
  });

  it("a dynamite tile detonates after its fuse and clears the fatberg", () => {
    let g = new Game(mulberry32(1), CONFIG.fatbergFromLevel);
    let berg = findFatberg(g);
    for (let s = 2; !berg && s < 30; s++) {
      g = new Game(mulberry32(s), CONFIG.fatbergFromLevel);
      berg = findFatberg(g);
    }
    expect(berg).not.toBeNull();
    g.started = true; // skip the start gate so update() ticks the fuse
    // drop dynamite right next to the berg (a guaranteed-empty cell two cols over)
    const dyn = { row: berg!.row, col: berg!.col };
    g.grid.clear(dyn); // clear that fatberg tile so we can stand a fused pipe on it
    g.grid.set(dyn, "straight-v"); // dynamite is now a fuse on any normal piece
    (g as unknown as { fuses: Map<string, number> }).fuses.set(`${dyn.row},${dyn.col}`, CONFIG.dynamiteFuseMs);
    g.update(CONFIG.dynamiteFuseMs + 50); // fuse burns down -> BOOM
    expect(findFatberg(g)).toBeNull(); // berg gone
    expect(g.consumeEvents().some((e) => e.kind === "explosion")).toBe(true);
  });

  it("dynamite wasted away from the fatberg leaves it standing (to be re-supplied)", () => {
    let g = new Game(mulberry32(1), CONFIG.fatbergFromLevel);
    let berg = findFatberg(g);
    for (let s = 2; !berg && s < 30; s++) {
      g = new Game(mulberry32(s), CONFIG.fatbergFromLevel);
      berg = findFatberg(g);
    }
    expect(berg).not.toBeNull();
    g.started = true;
    // detonate at the top corner, nowhere near the (deeper) berg
    g.grid.set({ row: 0, col: 0 }, "straight-v");
    (g as unknown as { fuses: Map<string, number> }).fuses.set("0,0", CONFIG.dynamiteFuseMs);
    g.update(CONFIG.dynamiteFuseMs + 50);
    expect(findFatberg(g)).not.toBeNull(); // berg untouched -> supply re-arms
  });
});

describe("sewer overflow (level win)", () => {
  it("constructs deeper levels without error, with a bigger overflow each level", () => {
    let prev = 0;
    for (const lvl of [2, 3, 5, 8]) {
      const g = new Game(undefined, lvl);
      expect(g.level).toBe(lvl);
      expect(g.overflowTotal).toBeGreaterThan(prev); // bigger dump each level
      prev = g.overflowTotal;
      expect(g.queue.length).toBeGreaterThan(0);
      g.update(100); // a tick on a fresh deeper level shouldn't throw
    }
  });

  it("tracks how much of the overflow is contained as the sewage flows", () => {
    const g = new Game();
    expect(g.overflowContained).toBe(0);
    for (let r = 1; r <= g.overflowTotal + 2; r++) {
      g.grid.set({ row: r, col: CONFIG.sourceCol }, "straight-v");
    }
    g.update(CONFIG.countdownMs); // start + source fills
    g.update(CONFIG.flowIntervalMs); // a couple of segments fill
    g.update(CONFIG.flowIntervalMs);
    expect(g.overflowContained).toBeGreaterThan(0);
    expect(g.overflowPct).toBeGreaterThan(0);
  });

  it("wins the level once the whole overflow is contained", () => {
    const g = new Game();
    // a clean straight column long enough to divert the entire overflow
    for (let r = 1; r <= g.overflowTotal + 2; r++) {
      g.grid.set({ row: r, col: CONFIG.sourceCol }, "straight-v");
    }
    g.update(CONFIG.countdownMs); // start + source fills
    for (let i = 0; i < g.overflowTotal + 4; i++) g.update(CONFIG.flowIntervalMs);
    expect(g.state).toBe("WON");
    expect(g.overflowContained).toBeGreaterThanOrEqual(g.overflowTotal);
  });
});

describe("leak model (spill no longer instant death)", () => {
  it("a spill drains quality over ticks, not instant game over", () => {
    const g = new Game();
    start(g);
    g.update(CONFIG.flowIntervalMs); // fills the under-toilet pipe
    g.update(CONFIG.flowIntervalMs); // it leaks below
    expect(g.leaking).toBe(true);
    expect(g.state).toBe("FLOWING"); // still alive
    expect(g.balance).toBeLessThan(CONFIG.startBalance);
    expect(g.balance).toBeGreaterThan(0);
  });

  it("game over once quality drains to zero", () => {
    const g = new Game();
    start(g);
    // Sustained leak below the under-toilet pipe -> quality drains to death.
    for (let i = 0; i < 30; i++) g.update(CONFIG.flowIntervalMs);
    expect(g.state).toBe("GAMEOVER");
    expect(g.balance).toBe(0);
  });

  it("exposes the leak target cell (where to build to cap it)", () => {
    const g = new Game();
    start(g);
    g.update(CONFIG.flowIntervalMs); // fills the under-toilet pipe
    g.update(CONFIG.flowIntervalMs); // it leaks into the cell below
    expect(g.leaking).toBe(true);
    expect(g.leakTarget).toEqual({ row: 2, col: CONFIG.sourceCol });
  });

  it("locks filled tiles, but the bursting tile itself can be replaced", () => {
    const g = new Game();
    // A bend just below the source that points WEST into the empty column beside it.
    g.grid.place({ row: 1, col: CONFIG.sourceCol }, "bend-nw"); // N|W
    g.update(CONFIG.countdownMs); // source fills
    g.update(CONFIG.flowIntervalMs); // sewage enters the bend
    g.update(CONFIG.flowIntervalMs); // bend exits W into an empty cell -> leak here
    const burst = { row: 1, col: CONFIG.sourceCol };
    expect(g.leaking).toBe(true);
    expect(g.leak?.from).toEqual(burst);
    expect(g.canPlace(burst)).toBe(true); // the bursting (filled) tile is replaceable
    // ...but other filled tiles stay locked, and the source is never replaceable.
    expect(g.canPlace({ row: 0, col: CONFIG.sourceCol })).toBe(false);
  });

  it("resumes flowing once the leak is capped with a connecting pipe", () => {
    const g = new Game();
    start(g);
    g.update(CONFIG.flowIntervalMs); // fills the under-toilet pipe
    g.update(CONFIG.flowIntervalMs); // it leaks into the cell below
    expect(g.leaking).toBe(true);
    const before = g.score;
    // Cap it: lay a vertical pipe in the leaking cell below.
    g.grid.place({ row: 2, col: CONFIG.sourceCol }, "straight-v");
    g.update(CONFIG.flowIntervalMs); // next tick retries and advances into the new pipe
    expect(g.score).toBeGreaterThan(before); // flow resumed
  });
});

describe("overwrite penalty", () => {
  it("placing on an empty cell is free; overwriting profits the shareholders", () => {
    const g = new Game();
    const a = { row: 1, col: 1 }; // row 1 is never preloaded -> guaranteed empty
    expect(g.placePiece(a)).toBe(true); // fresh placement
    expect(g.profitPounds).toBe(0);
    const qualityBefore = g.balance;

    g.placePiece(a); // overwrite the same cell with the next piece
    expect(g.profitPounds).toBe(CONFIG.overwritePounds);
    expect(g.balance).toBeLessThan(qualityBefore);
  });
});

