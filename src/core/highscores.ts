// Local high-score table — pure logic over an injectable string store (defaults to
// localStorage in the browser). Kept Phaser-free so it's unit-testable like the rest
// of core/. Arcade-style: a fixed top-10 with 3-letter initials.

export interface HighScore {
  name: string; // 3 uppercase initials, arcade-style
  score: number;
  level: number;
}

/** Minimal storage shape — localStorage satisfies it; tests pass a fake. */
export interface ScoreStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "spillz.highscores.v2";
export const MAX_SCORES = 10;

/** The pre-seeded board so a fresh install isn't an empty list (classic arcade). */
export function defaultScores(): HighScore[] {
  return [
    { name: "FSH", score: 5200, level: 9 },
    { name: "EEL", score: 4100, level: 7 },
    { name: "OTR", score: 3300, level: 6 },
    { name: "CRB", score: 2600, level: 5 },
    { name: "FRG", score: 2000, level: 4 },
    { name: "NWT", score: 1500, level: 3 },
    { name: "CRP", score: 1100, level: 3 },
    { name: "PKE", score: 750, level: 2 },
    { name: "TAD", score: 400, level: 1 },
    { name: "FRY", score: 150, level: 1 },
  ];
}

function storage(store?: ScoreStore): ScoreStore | null {
  if (store) return store;
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts
  }
  return null;
}

function sanitize(list: unknown): HighScore[] {
  if (!Array.isArray(list)) return defaultScores();
  const clean = list
    .filter(
      (h): h is HighScore =>
        !!h &&
        typeof (h as HighScore).name === "string" &&
        Number.isFinite((h as HighScore).score) &&
        Number.isFinite((h as HighScore).level),
    )
    .map((h) => ({ name: String(h.name).slice(0, 3).toUpperCase(), score: Math.floor(h.score), level: Math.floor(h.level) }));
  return sortTrim(clean);
}

function sortTrim(list: HighScore[]): HighScore[] {
  return [...list].sort((a, b) => b.score - a.score).slice(0, MAX_SCORES);
}

export function loadScores(store?: ScoreStore): HighScore[] {
  const s = storage(store);
  if (!s) return defaultScores();
  const raw = s.getItem(KEY);
  if (!raw) return defaultScores();
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return defaultScores();
  }
}

export function saveScores(list: HighScore[], store?: ScoreStore): void {
  const s = storage(store);
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(sortTrim(list)));
  } catch {
    // out of quota / blocked — scores just won't persist this session
  }
}

/** Would this score earn a place on the board? */
export function qualifies(score: number, store?: ScoreStore): boolean {
  if (score <= 0) return false;
  const list = loadScores(store);
  if (list.length < MAX_SCORES) return true;
  return score > list[list.length - 1].score;
}

/** Insert a new entry, persist, and return the new (sorted, trimmed) board. */
export function addScore(name: string, score: number, level: number, store?: ScoreStore): HighScore[] {
  const entry: HighScore = {
    name: (name || "YOU").slice(0, 3).toUpperCase().padEnd(3, " ").trimEnd() || "YOU",
    score: Math.floor(score),
    level: Math.floor(level),
  };
  const next = sortTrim([...loadScores(store), entry]);
  saveScores(next, store);
  return next;
}

/** 1-based rank this score would take (1 = top), or 0 if it doesn't place. */
export function rankOf(score: number, store?: ScoreStore): number {
  const list = loadScores(store);
  let rank = 1;
  for (const h of list) {
    if (score > h.score) return rank;
    rank++;
  }
  return rank <= MAX_SCORES ? rank : 0;
}
