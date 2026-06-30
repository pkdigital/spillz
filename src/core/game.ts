import { Grid } from "./grid";
import { floodStep, type LeakEdge } from "./flow";
import { buildChunk } from "./queue";
import { opposite, randomJunk, randomPiece, randomPower, sidesOf, step } from "./pieces";
import { Side } from "./types";
import {
  CHUNK_PATH_LEN,
  OBSTACLE_START_ROW,
  OPENING_PATH_LEN,
  POWER_CELL_CHANCE,
  crossesForLevel,
  decoysForLevel,
  directnessForLevel,
  fishForLevel,
  fishSpeciesForLevel,
  obstacleChance,
  overflowFor,
  rockChance,
  teesForLevel,
} from "./levels";
import type { Coord, FlowEvent, GameState, PieceType, PowerType, QueuePiece } from "./types";

/** The 2-opening piece for a given pair of sides (caps a leak without extra ends). */
const PIECE_FOR_OPENINGS: Record<number, PieceType> = {
  [Side.N | Side.S]: "straight-v",
  [Side.E | Side.W]: "straight-h",
  [Side.N | Side.E]: "bend-ne",
  [Side.N | Side.W]: "bend-nw",
  [Side.S | Side.E]: "bend-se",
  [Side.S | Side.W]: "bend-sw",
};

// ---- Tunables (all the feel knobs live here) -------------------------------
export const CONFIG = {
  rows: 10, // visible viewport rows (the world is infinite downward via scroll)
  cols: 7, // odd, so sourceCol (3) is dead-centre; the queue/gauge now OVERLAY the board, not reserve a column
  queueLength: 5,
  /** Lead time before the spill starts oozing — long enough for a "SPILL STARTING 3..2..1" beat. */
  countdownMs: 3000,
  /**
   * Milliseconds per pipe segment filled at level 1. THIS is the base flow rate.
   * Higher = slower. Level 1 is a deliberate trickle (forgiving so you can keep ahead
   * of the chase); later levels speed up faster, and speed-up power tiles shift it
   * further (see `currentFlowMs`).
   */
  /** The spill ACCELERATES as it's contained: it starts a trickle (set-up time) and ramps to a
   *  frantic chase by the time the dump's nearly diverted. `flowIntervalMs` is the opening (slow)
   *  ms/segment; `flowFastMs` is the rate at 100% contained. The whole ramp shifts faster per level. */
  flowIntervalMs: 2100,
  flowFastMs: 850,
  flowSpeedupPerLevel: 70,
  minFlowIntervalMs: 620,
  maxFlowIntervalMs: 2600,
  sourceCol: 3,
  /** Column the on-screen next-pipe queue HUD overlays — kept clear of seeded
   *  obstacles/powers so they're never hidden behind it (the player can still build there). */
  hudCol: 0,

  // --- pond / tug-of-war: Water Quality vs £ Profit (balance 0..1 = quality) ---
  startBalance: 0.72,
  /** Quality lost each tick while sewage is leaking from an open end. */
  spillDrainPerTick: 0.035,
  /** Quality regained per safely-contained segment (keeps the meter winnable). */
  healPerSegment: 0.008,
  /** A shareholder-dividend tile shifts the meter toward profit. */
  dividendHit: 0.12,
  /** A protest/judge tile shifts it back toward quality. */
  protestBoost: 0.12,

  // --- speed power tiles modify the flow interval ---
  speedUpDeltaMs: -300,
  speedDownDeltaMs: 350,

  /** Quality drain (and profit) scales with how many open ends leak at once, capped. */
  maxLeakMultiplier: 3,

  // --- cosmetic £ profit counter ---
  dividendPounds: 250_000,
  spillPounds: 40_000,
  protestPounds: 200_000,

  // --- overwriting a tile is wasteful: the shareholders profit ---
  overwritePounds: 75_000,
  overwriteHit: 0.03,

  // --- forcing pipe through a clog/hazard pollutes (costlier than an overwrite) ---
  hazardClearPounds: 150_000,
  hazardClearHit: 0.08,

  // --- score: tallied additively on the level-clear screen (SNES style) ---
  fishPoints: 500, // points per fish rescued
  purityBonusMax: 8000, // bonus for a perfectly pristine pond (scales with final quality)
  pointsPerSegment: 25, // points banked each time the sewage flows into another contained pipe tile

  // --- bucket-1 powers ---
  scorePower: 1000, // bonus points a score marker grants (× its 2/3/4 magnitude)
  freezeMs: 3500, // how long a freeze marker pauses the flow

  // --- bucket-2 powers ---
  rainMs: 4500, // how long a rain marker pours (obscures the view)
  rainHealPerSec: 0.06, // water-quality recovered per second while it rains
  blitzCount: 6, // how many free random pipe pieces a blitz scatters into empty tiles

  // --- bosses: the fatberg + the dynamite that clears it ---
  /** First level a fatberg boss can appear. */
  fatbergFromLevel: 3,
  /** Fuse length once a dynamite pipe is placed, before it detonates. */
  dynamiteFuseMs: 3000,
  /** Quality cost of a detonation (it's still a sewage blast), and its £ profit. */
  explosionHit: 0.05,
  explosionPounds: 50_000,

} as const;

export interface FilledSegment {
  coord: Coord;
  /** ms timestamp (the ring time) when this segment filled — for render animation. */
  at: number;
  /** Side the sewage arrived from (null for the source) — for the fill animation. */
  entry: Side | null;
}

function keyOf(c: Coord): string {
  return `${c.row},${c.col}`;
}

/**
 * Orchestrates a run: COUNTDOWN -> FLOWING -> GAMEOVER, the forced queue,
 * placement, the flow tick, the pond/profit meter, and scoring. Drives off an
 * injected clock so it is deterministic in tests and frame-rate independent.
 */
export class Game {
  readonly grid: Grid;
  state: GameState = "COUNTDOWN";
  queue: QueuePiece[] = [];
  /** Segments the sewage has filled, in order. length == score. */
  filled: FilledSegment[] = [];

  /** Tug-of-war meter: 1 = pristine water, 0 = pond dead / shareholders win. */
  balance: number = CONFIG.startBalance;
  /** Permanent (monotonic) dead-fish count — a high-water-mark. Quality (`balance`) can recover,
   *  but the dead stay dead: poison kills directly, and a quality dip kills any fish it implies. */
  private deadFish = 0;
  /** While `elapsed < frozenUntil`, the flow is paused (a freeze marker). */
  private frozenUntil = 0;
  /** While `elapsed < rainingUntil`, rain pours (obscures the view, heals quality). */
  private rainingUntil = 0;
  /** Cosmetic running shareholder-profit figure (£). */
  profitPounds = 0;
  /** Open ends currently spilling (empty while contained). */
  leaks: LeakEdge[] = [];
  /** ms time the current fill-ring started (for animation). */
  ringStart: number = CONFIG.countdownMs;
  /** Notable tiles the sewage flowed through since last drained (for toasts). */
  events: FlowEvent[] = [];

  /** Live dynamite fuses: cell key -> ms remaining before it detonates. */
  private fuses = new Map<string, number>();
  /** Whether this level's fatberg boss has been seeded yet (one per level). */
  private fatbergPlaced = false;
  /** Top-left of the current fatberg (for handing out dynamite at the right time). */
  private fatbergAnchor: Coord | null = null;
  private dynamiteGiven = false;
  /** Every rock seeded this level (impassable; destructible with dynamite). */
  private rocks: Coord[] = [];
  /** Earliest elapsed-ms the game may slip the player a lifeline piece again. */
  private helpAt = 0;
  /** Membership set mirroring `filled`, for fast flood lookups. */
  private filledSet = new Set<string>();
  /** Deepest filled row (the flood frontier). */
  private maxFilledRow = 0;
  /** Deepest row the player has placed a pipe on (for the start hint). */
  private maxPlacedRow = 0;
  /** The row/col of the most recent placement — the camera follows the row. */
  private lastBuiltRow = 0;
  private lastBuiltCol: number = CONFIG.sourceCol;
  /** Power-up markers on empty ground — build a pipe through them to trigger. */
  private powerMarkers = new Map<string, { power: PowerType; mag: number }>();
  /** The run begins (countdown starts) only once a pipe is laid under the toilet. */
  started = false;
  private elapsed = 0;
  private currentFlowMs: number = CONFIG.flowIntervalMs;
  /** Persistent flow-interval offset from speed power tiles (− faster, + slower). */
  private flowMod = 0;
  private nextFlowAt: number;
  private rng: () => number;
  private script: QueuePiece[] = [];
  private openingGenerated = false;
  /** Deepest grid row that has had clog obstacles seeded. */
  private obstacleRow = OBSTACLE_START_ROW - 1;
  /** 1-based run number; difficulty + overflow size scale with it. */
  private readonly levelNumber: number;
  /** Segments of sewage to divert/contain to clear this level's overflow. */
  readonly overflowTotal: number;
  /** How many fish this level's pond holds, and each one's species id. */
  private readonly levelFish: number;
  private readonly fishKindsArr: number[] = [];
  /** Cumulative fish rescued across the whole run. */
  fishSaved: number;
  /** Total score banked from completed levels (the run score). */
  runScore: number;

  constructor(rng: () => number = Math.random, level = 1, fishSaved = 0, runScore = 0) {
    this.rng = rng;
    this.levelNumber = level;
    this.fishSaved = fishSaved;
    this.runScore = runScore;
    this.levelFish = fishForLevel(level);
    this.grid = new Grid(CONFIG.cols);

    const source: Coord = { row: 0, col: CONFIG.sourceCol };
    this.grid.set(source, "source");

    // this level's dump: contain this many sewage segments to clear it (no fixed destination)
    this.overflowTotal = overflowFor(level);

    this.seedBoardThrough(CONFIG.rows * 2);

    for (let i = 0; i < CONFIG.queueLength; i++) {
      this.queue.push(this.nextScriptPiece());
    }

    this.nextFlowAt = CONFIG.countdownMs + CONFIG.flowIntervalMs;

    // assign each fish a species (done last so board/queue rng is unchanged)
    const species = fishSpeciesForLevel(level);
    for (let i = 0; i < this.levelFish; i++) {
      this.fishKindsArr.push(Math.floor(this.rng() * species));
    }
  }

  /** Number of fish in this level's pond. */
  get fishCount(): number {
    return this.levelFish;
  }

  /** Each fish's species id (for rendering variety). */
  get fishKinds(): readonly number[] {
    return this.fishKindsArr;
  }

  /** Dead fish (permanent). Fish start dying once quality drops past half; this is the
   *  high-water-mark of those deaths plus any direct kills (poison), and never decreases. */
  get fishDead(): number {
    return this.deadFish;
  }

  /** How many fish the CURRENT quality would have killed (drives the high-water-mark). The last
   *  fish only dies when quality hits exactly 0, so "all dead" stays in lock-step with a dead pond
   *  (rounding could otherwise show every fish gone while a sliver of quality remained). */
  private balanceDeadCount(): number {
    const q = this.balance;
    if (q <= 0) return this.levelFish;
    if (q >= 0.5) return 0;
    return Math.min(this.levelFish - 1, Math.round(((0.5 - q) / 0.5) * this.levelFish));
  }

  /** Kill one more fish outright (poison / dev) — permanent; the pond dies if it was the last. */
  private killOneFish(): void {
    this.deadFish = Math.min(this.levelFish, this.deadFish + 1);
    if (this.deadFish >= this.levelFish) {
      this.balance = 0;
      this.state = "GAMEOVER";
    }
  }

  /** Fish still alive in the pond right now. */
  get fishAlive(): number {
    return this.levelFish - this.fishDead;
  }

  /** Points from the fish rescued this level (tallied on the clear screen). */
  get levelFishBonus(): number {
    return this.fishAlive * CONFIG.fishPoints;
  }

  /** Cleanliness bonus this level — scales with the final pond quality. */
  get levelPurityBonus(): number {
    return Math.round(this.balance * CONFIG.purityBonusMax);
  }

  /** Dev helper: kill one more fish (permanently). */
  killFish(): void {
    this.killOneFish();
  }

  get score(): number {
    return this.filled.length;
  }

  /** Segments of sewage diverted/contained so far (excludes the source). */
  get overflowContained(): number {
    return Math.max(0, this.filled.length - 1);
  }

  /** How much of this level's overflow is contained, 0..100 — the "DUMP CONTAINED" bar. */
  get overflowPct(): number {
    return Math.min(100, Math.round((this.overflowContained / this.overflowTotal) * 100));
  }

  /** Current level (the run number). */
  get level(): number {
    return this.levelNumber;
  }

  /** Water quality as a 0..100 percentage (the pond's health). */
  get qualityPct(): number {
    return Math.round(this.balance * 100);
  }

  /** ms remaining on the start countdown (0 once flowing). */
  get countdownRemaining(): number {
    return Math.max(0, CONFIG.countdownMs - this.elapsed);
  }

  /** Whether a freeze marker currently has the flow paused (for the scene's ice overlay). */
  get frozen(): boolean {
    return this.state === "FLOWING" && this.elapsed < this.frozenUntil;
  }

  /** Whether rain is currently pouring (for the scene's rain overlay). */
  get raining(): boolean {
    return this.state === "FLOWING" && this.elapsed < this.rainingUntil;
  }

  /** The piece the player will place next (front of queue). */
  get currentPiece(): QueuePiece | undefined {
    return this.queue[0];
  }

  /** Whether any open end is currently leaking. */
  get leaking(): boolean {
    return this.leaks.length > 0;
  }

  /** Convenience: the first leak (back-compat for callers wanting one). */
  get leak(): LeakEdge | null {
    return this.leaks[0] ?? null;
  }

  /** Deepest filled row (the flood frontier). */
  get frontRow(): number {
    return this.maxFilledRow;
  }

  /** Deepest row a pipe has been placed on (for the start hint). */
  get placedRow(): number {
    return this.maxPlacedRow;
  }

  /** Row of the most recent placement — the camera follows this (scrolls up or down). */
  get buildRow(): number {
    return this.lastBuiltRow;
  }

  /** Column of the most recent placement (for nudging the next-pipe box aside). */
  get buildCol(): number {
    return this.lastBuiltCol;
  }

  /** The power-up marker (if any) on the empty ground at `c`. */
  powerMarkerAt(c: Coord): { power: PowerType; mag: number } | undefined {
    return this.powerMarkers.get(keyOf(c));
  }

  /** The current per-ring flow duration in ms (one tile of sewage advance). For the
   *  renderer to drift its flow texture at exactly the speed the sewage actually moves. */
  get ringFlowMs(): number {
    return this.currentFlowMs;
  }

  /** 0..1 fill animation progress of the cells in the current ring. */
  get fillProgress(): number {
    if (this.state !== "FLOWING") return 1;
    return Math.max(0, Math.min(1, (this.elapsed - this.ringStart) / this.currentFlowMs));
  }

  // ---- queue / script --------------------------------------------------------

  private nextScriptPiece(): QueuePiece {
    if (this.script.length === 0) this.refillScript();
    return this.script.shift()!;
  }

  private refillScript(): void {
    const source: Coord = { row: 0, col: CONFIG.sourceCol };
    const opening = !this.openingGenerated;
    this.openingGenerated = true;
    const pathLen = opening ? OPENING_PATH_LEN : CHUNK_PATH_LEN;
    this.script.push(
      ...buildChunk({
        // a tall, narrow planning grid so the forward-only path can DESCEND the whole
        // chunk without bouncing off a bottom wall (which produced useless snake-back pieces)
        rows: pathLen + 4,
        cols: CONFIG.cols,
        source,
        pathLen,
        crosses: crossesForLevel(this.level),
        tees: teesForLevel(this.level),
        // duds to dump/overwrite (never in the first slots — spliceIn keeps the start fair, "the edge")
        decoys: decoysForLevel(this.level),
        rng: this.rng,
        // bias the planned path to keep DESCENDING (no fixed destination — it's an overflow you
        // divert ever downward); the synthetic point below just pulls the walk down the column.
        target: { row: pathLen + 8, col: CONFIG.sourceCol },
        directness: directnessForLevel(this.level),
      }),
    );
  }

  /**
   * Seed the game BOARD down to `targetRow`: clog obstacles (route around them)
   * and power-up tiles (flow-through crosses carrying a power). Both get denser
   * deeper. Only ever placed on empty cells, so they never touch player pipes.
   */
  private seedBoardThrough(targetRow: number): void {
    while (this.obstacleRow < targetRow) {
      this.obstacleRow++;
      const r = this.obstacleRow;
      const clog = obstacleChance(r);
      const rock = rockChance(this.level, r);
      for (let col = 0; col < CONFIG.cols; col++) {
        if (col === CONFIG.hudCol) continue; // keep the queue-HUD column clear of seeded content
        const c = { row: r, col };
        if (!this.grid.isEmpty(c)) continue;
        const roll = this.rng();
        if (col !== CONFIG.sourceCol && roll < rock) {
          // a boulder: impassable AND can't be built through — route around it or blow it up.
          // never on the source column, so a straight descent always exists.
          this.grid.set(c, "rock");
          this.rocks.push(c);
        } else if (roll < rock + clog) {
          this.grid.set(c, "blocker", { junk: randomJunk(this.rng) });
        } else if (roll < rock + clog + POWER_CELL_CHANCE) {
          // power-up marker on the GROUND: build a pipe through it (good) or route
          // around it (bad). Cell stays empty/buildable until then.
          // a faucet of strength 2x / 3x / 4x — the label warns how much it speeds up
          this.powerMarkers.set(keyOf(c), { power: randomPower(this.rng), mag: 2 + Math.floor(this.rng() * 3) });
        }
      }
      this.maybeSeedFatberg(r);
    }
  }

  /** Drop one 2x2 fatberg boss per level (deeper levels). The dynamite to clear it
   *  is handed over later, once the player builds near it (see placePiece). */
  private maybeSeedFatberg(r: number): void {
    if (this.fatbergPlaced || this.level < CONFIG.fatbergFromLevel) return;
    if (r < OBSTACLE_START_ROW + 4) return; // a few rows into the dump, never right at the top
    // a 2x2 block whose columns avoid the source column (so a route always exists) and the
    // queue-HUD column (so it's not hidden behind the HUD)
    const lefts = [0, 1, 4, 5].filter(
      (c) =>
        c + 1 < CONFIG.cols &&
        c !== CONFIG.sourceCol &&
        c + 1 !== CONFIG.sourceCol &&
        c !== CONFIG.hudCol &&
        c + 1 !== CONFIG.hudCol,
    );
    const col = lefts[Math.floor(this.rng() * lefts.length)];
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        this.grid.set({ row: r + dr, col: col + dc }, "fatberg"); // force over any seeded clog
      }
    }
    this.fatbergPlaced = true;
    this.fatbergAnchor = { row: r, col };
  }

  // ---- placement -------------------------------------------------------------

  /**
   * Place the front-of-queue piece. Empty cells always allowed; an existing tile
   * may be overwritten EXCEPT the source and any cell the sewage has already
   * filled/passed (you can only edit pipe ahead of the flow).
   */
  placePiece(c: Coord): boolean {
    if (this.state === "GAMEOVER") return false;
    const piece = this.queue[0];
    if (!piece) return false;
    if (!this.canPlace(c)) return false;

    const existing = this.grid.get(c);
    const wasClog = existing?.type === "blocker";
    const clogJunk = existing?.junk;
    const isOverwrite = existing !== null;

    // Building through a power-up marker bakes its power into the pipe (it fires
    // later, when the sewage actually reaches the cell — see fillCell), then
    // consumes the marker.
    const marker = this.powerMarkers.get(keyOf(c));
    if (marker) this.powerMarkers.delete(keyOf(c));

    this.grid.set(c, piece.type, { power: piece.power ?? marker?.power, powerMag: marker?.mag });
    if (c.row > this.maxPlacedRow) this.maxPlacedRow = c.row;
    this.lastBuiltRow = c.row;
    this.lastBuiltCol = c.col;
    this.queue.shift();
    this.queue.push(this.nextScriptPiece());

    if (piece.dynamite) this.fuses.set(keyOf(c), CONFIG.dynamiteFuseMs); // a fuse on any shape
    this.maybeGiveDynamite();

    if (wasClog) {
      // Clearing a clog dumps it straight into the pond and pollutes — immediately.
      this.adjustBalance(-CONFIG.hazardClearHit);
      this.profitPounds += CONFIG.hazardClearPounds;
      this.events.push({ kind: "clog", junk: clogJunk, coord: c });
    } else if (isOverwrite) {
      // Overwriting your OWN pipe is wasteful — shareholders profit. It also costs time:
      // the scene blocks the next placement while the smoke clears (the flow keeps running).
      this.profitPounds += CONFIG.overwritePounds;
      this.adjustBalance(-CONFIG.overwriteHit);
      this.events.push({ kind: "overwrite", coord: c });
    }

    // Capping / replacing a leaking end takes effect NOW — pull the next tick forward so the
    // spill stops the instant the player plugs it, rather than gushing for up to a full tick.
    if (this.state === "FLOWING" && this.leaking) {
      const capsLeak = this.leaks.some((l) => {
        const t = step(l.from, l.out);
        return (t.row === c.row && t.col === c.col) || (l.from.row === c.row && l.from.col === c.col);
      });
      if (capsLeak) this.nextFlowAt = Math.min(this.nextFlowAt, this.elapsed);
    }
    return true;
  }

  /** Rows of every un-cleared destructible obstacle (the fatberg boss + rocks). */
  private destructibleRows(): number[] {
    const rows: number[] = [];
    if (this.fatbergAnchor && this.fatbergStillStanding()) rows.push(this.fatbergAnchor.row);
    for (const rk of this.rocks) if (this.grid.get(rk)?.type === "rock") rows.push(rk.row);
    return rows;
  }

  /** Hand the player a stick of dynamite (into the queue) once they build near a destructible
   *  obstacle (the fatberg OR a rock) — so it arrives when it's useful, not at the start. */
  private maybeGiveDynamite(): void {
    if (this.dynamiteGiven) return;
    const rows = this.destructibleRows();
    if (rows.length === 0) return;
    if (!rows.some((row) => this.maxPlacedRow >= row - 4)) return; // not near one yet
    // strap a fuse onto the upcoming piece — whatever shape it is — so the shape
    // is never dictated by the dynamite.
    const piece = this.queue[1] ?? this.queue[0];
    if (piece) {
      piece.dynamite = true;
      this.dynamiteGiven = true;
    }
  }

  /** Whether the front-of-queue piece may legally go on cell `c`. */
  canPlace(c: Coord): boolean {
    if (!this.grid.inBounds(c)) return false;
    const existing = this.grid.get(c);
    if (existing?.type === "source") return false; // the manhole is a fixture
    if (existing?.type === "fatberg") return false; // can't build through the boss — blow it up
    if (existing?.type === "rock") return false; // impassable boulder — blow it up to clear the cell
    // clogs CAN be built through (at a cost — see placePiece), so they're not blocked here
    if (this.isFilled(c)) {
      // Filled tiles are locked — EXCEPT the one currently bursting, which you may
      // replace to redirect the leak (e.g. when it's pointed into a wall).
      return this.isLeakCell(c);
    }
    return true;
  }

  /** Empty cells to build into to cap a leak (the normal fix). */
  get leakTargets(): Coord[] {
    const out: Coord[] = [];
    const seen = new Set<string>();
    for (const l of this.leaks) {
      const t = step(l.from, l.out);
      if (!this.grid.isEmpty(t)) continue; // must be a buildable empty cell
      const k = keyOf(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  /**
   * Leaking tiles whose open end CAN'T be capped by building (it points at the
   * toilet, a clog, the wall, or another pipe) — the player must *replace the
   * bursting tile itself* to redirect the flow.
   */
  get burstTiles(): Coord[] {
    const out: Coord[] = [];
    const seen = new Set<string>();
    for (const l of this.leaks) {
      if (this.grid.isEmpty(step(l.from, l.out))) continue; // that leak has a buildable target
      const k = keyOf(l.from);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l.from);
    }
    return out;
  }

  /** For the leak UI: each buildable leak as the empty cell to build into plus the
   *  direction the sewage is spilling, so the renderer can march an arrow that way. */
  get leakHints(): { cell: Coord; dir: Side }[] {
    const out: { cell: Coord; dir: Side }[] = [];
    const seen = new Set<string>();
    for (const l of this.leaks) {
      const t = step(l.from, l.out);
      if (!this.grid.isEmpty(t)) continue; // only buildable (empty) targets get an arrow
      const k = keyOf(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ cell: t, dir: l.out });
    }
    return out;
  }

  /** Back-compat: a single leak target (the first). */
  get leakTarget(): Coord | null {
    return this.leakTargets[0] ?? null;
  }

  /** The fatberg boss's 2x2 anchor cell, once one has been seeded this level (else null).
   *  The scene uses this to flash a one-time "use the dynamite" hint when it comes into view. */
  get fatbergAt(): Coord | null {
    return this.fatbergAnchor;
  }

  /**
   * The build frontier: every empty, in-bounds cell that an OPEN end of the
   * source-connected pipe network points into — i.e. where the next piece should
   * go to extend the pipe. Drives the always-on "lay it here" placement hints.
   */
  get buildFrontier(): { cell: Coord; dir: Side }[] {
    const start: Coord = { row: 0, col: CONFIG.sourceCol };
    const seen = new Set<string>([keyOf(start)]);
    const stack: Coord[] = [start];
    const out: { cell: Coord; dir: Side }[] = [];
    const tseen = new Set<string>();
    while (stack.length) {
      const c = stack.pop()!;
      const cell = this.grid.get(c);
      if (!cell) continue;
      for (const dir of sidesOf(cell.openings)) {
        const nb = step(c, dir);
        const nbCell = this.grid.get(nb);
        if (nbCell) {
          if ((nbCell.openings & opposite(dir)) !== 0 && !seen.has(keyOf(nb))) {
            seen.add(keyOf(nb)); // joined pipe — keep walking the network
            stack.push(nb);
          }
        } else if (this.grid.inBounds(nb) && !tseen.has(keyOf(nb))) {
          tseen.add(keyOf(nb)); // open end -> empty cell; `dir` is the way the pipe extends
          out.push({ cell: nb, dir });
        }
      }
    }
    return out;
  }

  private isLeakCell(c: Coord): boolean {
    return this.leaks.some((l) => l.from.row === c.row && l.from.col === c.col);
  }

  private isFilled(c: Coord): boolean {
    return this.filledSet.has(keyOf(c));
  }

  // ---- simulation ------------------------------------------------------------

  update(dtMs: number): void {
    if (this.state === "GAMEOVER" || this.state === "WON") return;
    // Keep the board seeded well ahead of the descending flood.
    this.seedBoardThrough(this.maxFilledRow + CONFIG.rows * 2);

    // The run is paused until it's begun — either via the Start button (beginRun)
    // or, as a fallback, by laying the first pipe under the toilet.
    if (!this.started) {
      if (this.grid.get({ row: 1, col: CONFIG.sourceCol }) === null) return;
      this.beginRun();
    }
    this.elapsed += dtMs;
    this.tickFuses(dtMs);

    // FREEZE: while the flow is paused, slide the flow timeline forward with elapsed so the front
    // holds exactly where it is (fillProgress = (elapsed-ringStart)/flowMs stays put) and no ring
    // ticks. Countdown is unaffected — freeze only ever fires once the sewage is already flowing.
    if (this.state === "FLOWING" && this.elapsed < this.frozenUntil) {
      this.ringStart += dtMs;
      this.nextFlowAt += dtMs;
    }

    // RAIN: fresh water dilutes the river — quality recovers while it pours (dead fish stay dead).
    if (this.state === "FLOWING" && this.elapsed < this.rainingUntil) {
      this.adjustBalance(CONFIG.rainHealPerSec * (dtMs / 1000));
    }

    if (this.state === "COUNTDOWN") {
      if (this.elapsed < CONFIG.countdownMs) return;
      this.state = "FLOWING";
      this.fillCell({ row: 0, col: CONFIG.sourceCol }, null, CONFIG.countdownMs);
      this.ringStart = CONFIG.countdownMs;
      this.currentFlowMs = this.effectiveFlowMs();
      this.nextFlowAt = CONFIG.countdownMs + this.currentFlowMs;
    }

    while (this.state === "FLOWING" && this.elapsed >= this.nextFlowAt) {
      this.ringStart = this.nextFlowAt;
      this.currentFlowMs = this.effectiveFlowMs();
      this.tickFlood();
      this.nextFlowAt = this.ringStart + this.currentFlowMs;
      if (this.state !== "FLOWING") break;
    }

    if (this.state === "FLOWING") this.maybeOfferHelp();
  }

  /** Rubber-band: when the pond is nearly dead AND sewage is spilling, occasionally
   *  slip the EXACT capping piece (a straight/bend, never a cross — extra open ends
   *  just make more leaks) to the front of the queue so the player can recover. */
  private maybeOfferHelp(): void {
    if (this.fishAlive >= 2 || !this.leaking) return;
    if (this.elapsed < this.helpAt) return;
    this.helpAt = this.elapsed + 5000; // at most once every ~5s of trouble
    if (this.rng() < 0.8) {
      this.queue.unshift({ type: this.helpPiece() });
      this.queue.pop();
    }
  }

  /** The 2-opening piece that caps the current leak and continues toward the works. */
  private helpPiece(): PieceType {
    const leak = this.leaks[0];
    if (!leak) return "straight-v";
    const entry = opposite(leak.out); // side the cap must face back toward the spill
    const goal = entry === Side.S ? Side.N : Side.S; // ...and continue down to the works
    return PIECE_FOR_OPENINGS[entry | goal] ?? "straight-v";
  }

  /** Begin the run (the Start button) — the poo starts welling and the countdown ticks. */
  beginRun(): void {
    if (this.started) return;
    this.started = true;
    this.elapsed = 0;
  }

  /** ms left on the fuse of a dynamite tile, or undefined if it isn't armed. */
  fuseAt(c: Coord): number | undefined {
    return this.fuses.get(keyOf(c));
  }

  /** Count down live fuses; detonate any that reach zero. */
  private tickFuses(dtMs: number): void {
    if (this.fuses.size === 0) return;
    for (const [key, ms] of this.fuses) {
      const left = ms - dtMs;
      if (left <= 0) {
        this.fuses.delete(key);
        const [row, col] = key.split(",").map(Number);
        this.detonate({ row, col });
      } else {
        this.fuses.set(key, left);
      }
    }
  }

  /** Clear every destructible obstacle (fatberg tile or rock) within blast radius, at a cost. */
  private detonate(c: Coord): void {
    let cleared = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const t = { row: c.row + dr, col: c.col + dc };
        const type = this.grid.get(t)?.type;
        if (type === "fatberg" || type === "rock") {
          this.grid.clear(t);
          cleared++;
        }
      }
    }
    this.events.push({ kind: "explosion", coord: c });
    if (cleared > 0) {
      this.adjustBalance(-CONFIG.explosionHit);
      this.profitPounds += CONFIG.explosionPounds;
    }
    // anything destructible still standing (this berg, or rocks elsewhere)? re-arm the supply
    if (this.destructibleRows().length > 0) {
      this.dynamiteGiven = false;
    }
  }

  /** Whether any tile of this level's fatberg remains on the board. */
  private fatbergStillStanding(): boolean {
    const a = this.fatbergAnchor;
    if (!a) return false;
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        if (this.grid.get({ row: a.row + dr, col: a.col + dc })?.type === "fatberg") return true;
      }
    }
    return false;
  }

  private effectiveFlowMs(): number {
    // a SURGE: the spill starts a trickle, ramps to a frantic peak through the middle, then
    // peters out near the end as the dump subsides (intensity 0 at both ends, 1 in the middle).
    const frac = Math.min(1, this.overflowContained / this.overflowTotal);
    const up = Math.min(1, frac / 0.3); // builds over the first 30%
    const down = Math.max(0, Math.min(1, (1 - frac) / 0.25)); // eases over the last 25%
    const intensity = Math.min(up, down);
    const ramp = CONFIG.flowIntervalMs + (CONFIG.flowFastMs - CONFIG.flowIntervalMs) * intensity;
    const base = ramp - (this.level - 1) * CONFIG.flowSpeedupPerLevel;
    return Math.max(CONFIG.minFlowIntervalMs, Math.min(CONFIG.maxFlowIntervalMs, base + this.flowMod));
  }

  /** Advance the flood one ring: drain for current leaks, then fill the next ring. */
  private tickFlood(): void {
    const { newlyFilled, leaks } = floodStep(this.grid, this.filledSet);
    this.leaks = leaks;

    // Sewage gushing from open ends drains quality (worse the more ends leak).
    const n = Math.min(leaks.length, CONFIG.maxLeakMultiplier);
    if (n > 0) {
      this.adjustBalance(-CONFIG.spillDrainPerTick * n);
      this.profitPounds += CONFIG.spillPounds * n;
      if (this.state !== "FLOWING") return;
    }

    for (const nf of newlyFilled) {
      this.fillCell(nf.coord, nf.entry, this.ringStart);
      this.adjustBalance(CONFIG.healPerSegment); // containment slowly recovers quality
      this.runScore += CONFIG.pointsPerSegment; // score ticks up as the flow fills each pipe tile
      if (this.state !== "FLOWING") return;
    }

    // The whole overflow is contained — level cleared, graded by the fish saved.
    if (this.overflowContained >= this.overflowTotal) this.winLevel();
  }

  /** Clear the level: the overflow is fully diverted. Pond saved! Complete the pipe by banking
   *  every GOOD bonus still sitting on it (the score markers the spill never reached), ignoring
   *  the hazards (no poison on the victory lap), then tally the survivors + purity. */
  private winLevel(): void {
    if (this.state !== "FLOWING") return;
    this.state = "WON";
    for (const { coord, cell } of this.grid.entries()) {
      if (cell.power === "score") {
        const bonus = CONFIG.scorePower * (cell.powerMag ?? 1);
        this.runScore += bonus;
        this.events.push({ kind: "power", power: "score", coord, value: bonus });
        cell.power = undefined;
      }
      // hazards (poison) and neutral powers are skipped — the spill is contained, only good news
    }
    this.fishSaved += this.fishAlive; // bank the survivors
    this.runScore += this.levelFishBonus + this.levelPurityBonus;
  }

  /** Record a newly-filled cell and fire any special effect the sewage hits there. */
  private fillCell(coord: Coord, entry: Side | null, at: number): void {
    this.filled.push({ coord, at, entry });
    this.filledSet.add(keyOf(coord));
    if (coord.row > this.maxFilledRow) this.maxFilledRow = coord.row;
    const cell = this.grid.get(coord);
    if (cell?.power) this.applyPower(coord, cell.power);
  }

  /** Fire (once) the power on a freshly-filled cell, then consume it. */
  private applyPower(c: Coord, power: PowerType): void {
    const mag = this.grid.get(c)?.powerMag ?? 1; // 2x / 3x / 4x faucet strength
    this.firePower(power, mag, c);
    const cell = this.grid.get(c);
    if (cell) cell.power = undefined; // spent
  }

  /** DEV: fire a power right now (no marker needed) for testing — at the flow front. */
  devFirePower(power: PowerType): void {
    if (this.state !== "FLOWING") return;
    const c = this.filled.length > 1 ? this.filled[this.filled.length - 1].coord : { row: 1, col: CONFIG.sourceCol };
    this.firePower(power, 3, c);
  }

  /** Apply a power's effect and emit its event (shared by real markers and the dev key). */
  private firePower(power: PowerType, mag: number, c: Coord): void {
    let bonus: number | undefined; // points awarded (score marker) — carried to the scene
    let coords: Coord[] | undefined; // tiles touched (blitz) — carried to the scene
    switch (power) {
      case "speed-up":
        this.flowMod += CONFIG.speedUpDeltaMs * mag;
        break;
      case "speed-down":
        this.flowMod += CONFIG.speedDownDeltaMs * mag;
        break;
      case "protest":
        this.adjustBalance(CONFIG.protestBoost);
        this.profitPounds = Math.max(0, this.profitPounds - CONFIG.protestPounds);
        break;
      case "score":
        bonus = CONFIG.scorePower * mag; // 2x / 3x / 4x bonus points
        this.runScore += bonus;
        break;
      case "freeze":
        this.frozenUntil = this.elapsed + CONFIG.freezeMs; // pause the flow a few seconds
        break;
      case "poison":
        this.killOneFish(); // a fish dies instantly
        break;
      case "rain":
        this.rainingUntil = this.elapsed + CONFIG.rainMs; // pours: obscures the view, heals quality
        break;
      case "blitz":
        coords = this.blitzScatter(c); // free random pipe OR bonus markers into nearby tiles
        break;
    }
    this.events.push({ kind: "power", power, coord: c, value: bonus, coords });
  }

  /** Blitz: a coin-flip between two chaotic leg-ups, scattered into empty tiles near the flow
   *  front — either free random PIPE pieces, or bonus POWER markers (a good/poison mix the
   *  player can still choose to route through or around). Returns the tiles touched (for the
   *  scene's strike + pop-in). */
  private blitzScatter(near: Coord): Coord[] {
    const touched: Coord[] = [];
    const empties: Coord[] = [];
    for (let dr = -1; dr <= 4; dr++) {
      for (let col = 0; col < CONFIG.cols; col++) {
        const cell = { row: near.row + dr, col };
        if (cell.row >= 1 && this.grid.isEmpty(cell)) empties.push(cell);
      }
    }
    const dropPowers = this.rng() < 0.5;
    for (let i = 0; i < CONFIG.blitzCount && empties.length; i++) {
      const cell = empties.splice(Math.floor(this.rng() * empties.length), 1)[0];
      if (dropPowers) {
        this.powerMarkers.set(keyOf(cell), { power: randomPower(this.rng), mag: 2 + Math.floor(this.rng() * 3) });
      } else {
        this.grid.place(cell, randomPiece(this.rng));
      }
      touched.push(cell);
    }
    return touched;
  }

  /** Drain the flow events accumulated since the last call (the scene shows toasts). */
  consumeEvents(): FlowEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private adjustBalance(delta: number): void {
    this.balance = Math.max(0, Math.min(1, this.balance + delta));
    // raise the permanent dead-fish count to whatever this quality implies (never lower it)
    this.deadFish = Math.min(this.levelFish, Math.max(this.deadFish, this.balanceDeadCount()));
    if (this.balance <= 0 || this.deadFish >= this.levelFish) this.state = "GAMEOVER"; // pond dead
  }
}
