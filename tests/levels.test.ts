import { describe, expect, it } from "vitest";
import {
  OBSTACLE_START_ROW,
  OVERFLOW_BASE,
  obstacleChance,
  overflowFor,
} from "../src/core/levels";

describe("difficulty curve", () => {
  it("makes the overflow bigger each level", () => {
    expect(overflowFor(1)).toBe(OVERFLOW_BASE);
    expect(overflowFor(2)).toBeGreaterThan(overflowFor(1));
    expect(overflowFor(5)).toBeGreaterThan(overflowFor(2));
  });

  it("clog obstacles get denser the deeper you dig (capped)", () => {
    expect(obstacleChance(OBSTACLE_START_ROW)).toBeGreaterThan(0);
    expect(obstacleChance(40)).toBeGreaterThan(obstacleChance(OBSTACLE_START_ROW));
    expect(obstacleChance(1000)).toBeLessThanOrEqual(0.18);
  });
});
