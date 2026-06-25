import { Grid } from "./grid";
import { floodStep, type LeakEdge } from "./flow";
import { buildChunk } from "./queue";
import { opposite, randomJunk, randomPower, sidesOf, step } from "./pieces";
import { Side } from "./types";
import {
  CHUNK_PATH_LEN,
  OBSTACLE_START_ROW,
  OPENING_PATH_LEN,
  POWER_CELL_CHANCE,
  crossesForLevel,
  directnessForLevel,
  fishForLevel,
  fishSpeciesForLevel,
  obstacleChance,
  teesForLevel,
  terminalRow,
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
  cols: 7,
  queueLength: 5,
  /** Seconds of lead time before the sewage starts oozing (Pipe Mania's start countdown). */
  countdownMs: 7000,
  /**
   * Milliseconds per pipe segment filled at level 1. THIS is the base flow rate.
   * Higher = slower. Level 1 is a deliberate trickle (forgiving so you can keep ahead
   * of the chase); later levels speed up faster, and speed-up power tiles shift it
   * further (see `currentFlowMs`).
   */
  flowIntervalMs: 2400,
  flowSpeedupPerLevel: 200,
  minFlowIntervalMs: 700,
  maxFlowIntervalMs: 3200,
  /** Once a finished pipe connects the toilet to the works, the flow zooms. */
  superFlowMs: 110,
  sourceCol: 3,

  // --- pond / tug-of-war: Water Quality vs £ Profit (balance 0..1 = quality) ---
  startBalance: 0.6,
  /** Quality lost each tick while sewage is leaking from an open end. */
  spillDrainPerTick: 0.05,
  /** Quality regained per safely-contained segment (keeps the meter winnable). */
  healPerSegment: 0.006,
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
  /** 1-based run number; difficulty + terminal depth scale with it. */
  private readonly levelNumber: number;
  /** The treatment works — get the sewage here to win the level. */
  readonly terminal: Coord;
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

    // the treatment works sits at the bottom of this level, in the source column
    this.terminal = { row: terminalRow(level), col: CONFIG.sourceCol };
    this.grid.set(this.terminal, "terminal");

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

  /** Fish that have died (float belly-up) — they start dying past a half-full pond. */
  get fishDead(): number {
    const q = this.balance;
    return q >= 0.5 ? 0 : Math.round(((0.5 - q) / 0.5) * this.levelFish);
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

  /** Dev helper: drop the quality meter just enough to kill one more fish. */
  killFish(): void {
    const next = this.fishDead + 1;
    if (next >= this.levelFish) {
      this.balance = 0; // last fish -> pond dies
      return;
    }
    this.balance = Math.max(0, 0.5 - (next / this.levelFish) * 0.5);
  }

  get score(): number {
    return this.filled.length;
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
        rng: this.rng,
        // aim the planned path down the source column toward the works (the assist)
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
    // never seed the terminal row or below — keep the approach to it clear
    const cap = Math.min(targetRow, this.terminal.row - 1);
    while (this.obstacleRow < cap) {
      this.obstacleRow++;
      const r = this.obstacleRow;
      const clog = obstacleChance(r);
      for (let col = 0; col < CONFIG.cols; col++) {
        const c = { row: r, col };
        if (!this.grid.isEmpty(c)) continue;
        const roll = this.rng();
        if (roll < clog) {
          this.grid.set(c, "blocker", { junk: randomJunk(this.rng) });
        } else if (roll < clog + POWER_CELL_CHANCE) {
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
    if (r < OBSTACLE_START_ROW + 3 || r >= this.terminal.row - 2) return;
    // a 2x2 block whose columns avoid the source column, so a route always exists
    const lefts = [0, 1, 4, 5].filter(
      (c) => c + 1 < CONFIG.cols && c !== CONFIG.sourceCol && c + 1 !== CONFIG.sourceCol,
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
      // Overwriting your OWN pipe is wasteful — shareholders profit.
      this.profitPounds += CONFIG.overwritePounds;
      this.adjustBalance(-CONFIG.overwriteHit);
    }

    // Completing the route to the works takes effect NOW: pull the next flow tick
    // forward so the super-speed dash starts immediately (no waiting a slow tick).
    if (this.state === "FLOWING" && this.isConnectedToTerminal()) {
      this.nextFlowAt = Math.min(this.nextFlowAt, this.elapsed);
    }
    return true;
  }

  /** Hand the player a stick of dynamite (into the queue) once they build near
   *  the fatberg — so it arrives when it's useful, not at the start of the run. */
  private maybeGiveDynamite(): void {
    if (this.dynamiteGiven || !this.fatbergAnchor) return;
    if (this.maxPlacedRow < this.fatbergAnchor.row - 4) return;
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
    if (existing?.type === "source" || existing?.type === "terminal") return false; // fixtures
    if (existing?.type === "fatberg") return false; // can't build through the boss — blow it up
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

  /** Back-compat: a single leak target (the first). */
  get leakTarget(): Coord | null {
    return this.leakTargets[0] ?? null;
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

  /** Clear every fatberg tile within blast radius, at a quality cost. */
  private detonate(c: Coord): void {
    let cleared = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const t = { row: c.row + dr, col: c.col + dc };
        if (this.grid.get(t)?.type === "fatberg") {
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
    // wasted the dynamite (the berg still stands)? re-arm the supply so it can still be cleared
    if (this.fatbergPlaced && this.fatbergStillStanding()) {
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
    // Once the player has connected a finished pipe all the way to the works, the
    // outcome is decided — zoom the flow so they don't sit watching it crawl.
    if (this.isConnectedToTerminal()) return CONFIG.superFlowMs;
    const base = CONFIG.flowIntervalMs - (this.level - 1) * CONFIG.flowSpeedupPerLevel;
    return Math.max(
      CONFIG.minFlowIntervalMs,
      Math.min(CONFIG.maxFlowIntervalMs, base + this.flowMod),
    );
  }

  /** True once a continuous connected pipe path exists from the toilet to the works. */
  isConnectedToTerminal(): boolean {
    const start: Coord = { row: 0, col: CONFIG.sourceCol };
    const seen = new Set<string>([keyOf(start)]);
    const stack: Coord[] = [start];
    while (stack.length) {
      const c = stack.pop()!;
      const cell = this.grid.get(c);
      if (!cell) continue;
      for (const dir of sidesOf(cell.openings)) {
        const nb = step(c, dir);
        const nbCell = this.grid.get(nb);
        if (!nbCell || (nbCell.openings & opposite(dir)) === 0) continue; // not joined
        if (nb.row === this.terminal.row && nb.col === this.terminal.col) return true;
        const k = keyOf(nb);
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(nb);
      }
    }
    return false;
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
      if (this.state !== "FLOWING") return;
    }
  }

  /** Record a newly-filled cell and fire any special effect the sewage hits there. */
  private fillCell(coord: Coord, entry: Side | null, at: number): void {
    this.filled.push({ coord, at, entry });
    this.filledSet.add(keyOf(coord));
    if (coord.row > this.maxFilledRow) this.maxFilledRow = coord.row;
    const cell = this.grid.get(coord);
    if (cell?.type === "terminal") {
      this.state = "WON"; // sewage reached the treatment works — pond saved!
      this.fishSaved += this.fishAlive; // bank the survivors
      this.runScore += this.levelFishBonus + this.levelPurityBonus; // tally the points
      return;
    }
    if (cell?.power) this.applyPower(coord, cell.power);
  }

  /** Fire (once) the power on a freshly-filled cell, then consume it. */
  private applyPower(c: Coord, power: PowerType): void {
    const mag = this.grid.get(c)?.powerMag ?? 1; // 2x / 3x / 4x faucet strength
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
    }
    this.events.push({ kind: "power", power, coord: c });
    const cell = this.grid.get(c);
    if (cell) cell.power = undefined; // spent
  }

  /** Drain the flow events accumulated since the last call (the scene shows toasts). */
  consumeEvents(): FlowEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private adjustBalance(delta: number): void {
    this.balance = Math.max(0, Math.min(1, this.balance + delta));
    if (this.balance <= 0) this.state = "GAMEOVER"; // pond dead
  }
}
