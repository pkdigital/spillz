import { describe, expect, it } from "vitest";
import { CONFIG, Game } from "../src/core/game";

(CONFIG as { flowJitter: number }).flowJitter = 0; // deterministic flow timing (production wobbles it)

/** Lay a pipe under the toilet (this starts the run) and run out the countdown. */
function start(g: Game): void {
  g.grid.place({ row: 1, col: CONFIG.sourceCol }, "straight-v");
  g.update(CONFIG.countdownMs); // triggers start + completes the countdown -> source fills
}

describe("Game state machine", () => {
  it("does not start (no countdown) until a pipe is laid under the toilet", () => {
    const g = new Game();
    expect(g.started).toBe(false);
    g.update(CONFIG.countdownMs * 3); // lots of time, but nothing built
    expect(g.started).toBe(false);
    expect(g.state).toBe("COUNTDOWN");
    expect(g.score).toBe(0);
  });

  it("fills the source as the first segment when flow begins", () => {
    const g = new Game();
    start(g);
    expect(g.state).toBe("FLOWING");
    expect(g.filled).toHaveLength(1); // the source
    expect(g.filled[0].coord).toEqual({ row: 0, col: CONFIG.sourceCol });
  });

  it("starts leaking (not instant game over) when sewage spills into an unbuilt grid", () => {
    const g = new Game();
    start(g); // source filled; only a straight-v under the toilet, nothing below it
    g.update(CONFIG.flowIntervalMs); // sewage fills the under-toilet pipe
    g.update(CONFIG.flowIntervalMs); // its open end leaks into the unbuilt grid
    expect(g.leaking).toBe(true);
    expect(g.state).toBe("FLOWING"); // a single leak is survivable now
  });

  it("keeps the queue full after placing a piece", () => {
    const g = new Game();
    const before = g.currentPiece;
    expect(g.queue).toHaveLength(CONFIG.queueLength);
    const ok = g.placePiece({ row: 1, col: CONFIG.sourceCol });
    expect(ok).toBe(true);
    expect(g.queue).toHaveLength(CONFIG.queueLength);
    // front advanced
    expect(g.currentPiece).not.toBe(undefined);
    expect(before).toBeDefined();
  });

  it("overwrites an existing pipe ahead of the flow", () => {
    const g = new Game();
    const c = { row: 2, col: CONFIG.sourceCol }; // row < OBSTACLE_START_ROW: never board-seeded
    g.grid.place(c, "straight-h");
    expect(g.canPlace(c)).toBe(true);
    expect(g.placePiece(c)).toBe(true);
    expect(g.grid.get(c)?.type).not.toBe(undefined);
  });

  it("tracks the deepest placed row (drives the camera scroll)", () => {
    const g = new Game();
    expect(g.placedRow).toBe(0);
    g.placePiece({ row: 1, col: CONFIG.sourceCol });
    g.placePiece({ row: 2, col: CONFIG.sourceCol });
    expect(g.placedRow).toBe(2);
    // placing higher up doesn't reduce it
    g.placePiece({ row: 1, col: 0 });
    expect(g.placedRow).toBe(2);
  });

  it("never overwrites the source", () => {
    const g = new Game();
    const src = { row: 0, col: CONFIG.sourceCol };
    expect(g.canPlace(src)).toBe(false);
    expect(g.placePiece(src)).toBe(false);
    expect(g.grid.get(src)?.type).toBe("source");
  });

  it("locks a cell once the water has filled it", () => {
    const g = new Game();
    // Build a straight run so the water fills row 1, then try to overwrite it.
    for (let r = 1; r < CONFIG.rows; r++) {
      g.grid.place({ row: r, col: CONFIG.sourceCol }, "straight-v");
    }
    g.update(CONFIG.countdownMs); // source fills
    g.update(CONFIG.flowIntervalMs); // water advances into row 1
    const filledCell = { row: 1, col: CONFIG.sourceCol };
    expect(g.canPlace(filledCell)).toBe(false);
  });

  it("survives longer when a valid path is built", () => {
    const g = new Game();
    // Build a short straight run down the source column — far less than the overflow
    // quota — so the flow advances over a built column while staying FLOWING (not yet won).
    for (let r = 1; r < 6; r++) {
      g.grid.place({ row: r, col: CONFIG.sourceCol }, "straight-v");
    }
    g.update(CONFIG.countdownMs); // source fills
    g.update(CONFIG.flowIntervalMs); // first real step
    expect(g.score).toBeGreaterThan(1);
    expect(g.state).toBe("FLOWING");
  });
});
