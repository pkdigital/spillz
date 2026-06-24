import { describe, expect, it } from "vitest";
import {
  OBSTACLE_START_ROW,
  TERMINAL_BASE_ROW,
  obstacleChance,
  terminalRow,
} from "../src/core/levels";

describe("difficulty curve", () => {
  it("puts the treatment works deeper each level", () => {
    expect(terminalRow(1)).toBe(TERMINAL_BASE_ROW);
    expect(terminalRow(2)).toBeGreaterThan(terminalRow(1));
    expect(terminalRow(5)).toBeGreaterThan(terminalRow(2));
  });

  it("clog obstacles get denser the deeper you dig (capped)", () => {
    expect(obstacleChance(OBSTACLE_START_ROW)).toBeGreaterThan(0);
    expect(obstacleChance(40)).toBeGreaterThan(obstacleChance(OBSTACLE_START_ROW));
    expect(obstacleChance(1000)).toBeLessThanOrEqual(0.18);
  });
});
