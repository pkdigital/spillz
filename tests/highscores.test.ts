import { describe, it, expect } from "vitest";
import {
  addScore,
  defaultScores,
  loadScores,
  MAX_SCORES,
  qualifies,
  rankOf,
  saveScores,
  type ScoreStore,
} from "../src/core/highscores";

/** In-memory store standing in for localStorage. */
function fakeStore(): ScoreStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("highscores", () => {
  it("seeds a full default board when empty", () => {
    const s = fakeStore();
    const list = loadScores(s);
    expect(list.length).toBe(MAX_SCORES);
    expect(list).toEqual(defaultScores());
  });

  it("keeps the board sorted high-to-low and capped", () => {
    const s = fakeStore();
    saveScores(
      [
        { name: "AAA", score: 10, level: 1 },
        { name: "BBB", score: 999999, level: 9 },
        { name: "CCC", score: 500, level: 2 },
      ],
      s,
    );
    const list = loadScores(s);
    expect(list[0].name).toBe("BBB");
    expect(list.length).toBeLessThanOrEqual(MAX_SCORES);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].score).toBeGreaterThanOrEqual(list[i].score);
  });

  it("qualifies only when it beats the lowest of a full board", () => {
    const s = fakeStore();
    // default board's lowest is 150
    expect(qualifies(149, s)).toBe(false);
    expect(qualifies(151, s)).toBe(true);
    expect(qualifies(0, s)).toBe(false);
    expect(qualifies(-5, s)).toBe(false);
  });

  it("inserts a qualifying score and trims to the cap", () => {
    const s = fakeStore();
    const before = loadScores(s).length;
    const after = addScore("ZZZ", 99999, 12, s);
    expect(after.length).toBe(before); // still capped at MAX
    expect(after[0]).toMatchObject({ name: "ZZZ", score: 99999, level: 12 });
    // the old lowest got pushed off
    expect(after.some((h) => h.score === 150)).toBe(false);
  });

  it("normalizes initials to 3 uppercase chars", () => {
    const s = fakeStore();
    const list = addScore("abcdef", 50000, 3, s);
    expect(list.find((h) => h.score === 50000)?.name).toBe("ABC");
  });

  it("falls back to YOU for an empty name", () => {
    const s = fakeStore();
    const list = addScore("", 50000, 3, s);
    expect(list.find((h) => h.score === 50000)?.name).toBe("YOU");
  });

  it("rankOf reports the placement (1-based) or 0 when off the board", () => {
    const s = fakeStore();
    expect(rankOf(999999, s)).toBe(1);
    expect(rankOf(149, s)).toBe(0);
  });

  it("recovers from corrupt stored data", () => {
    const s = fakeStore();
    s.setItem("spillz.highscores.v2", "{not json");
    expect(loadScores(s)).toEqual(defaultScores());
  });
});
