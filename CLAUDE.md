# Flowz

A tile-grid arcade puzzle game — a Pipe-Mania reimagining reframed (2026-06-24) as a **protest game about water-company sewage dumping**. You lay pipe to contain flowing **sewage** and **save the fish in the pond at the bottom**; the "score" is a tug-of-war between **Water Quality and £ shareholder profit**. Spilling sewage is the fail event (now thematically: polluting the environment). A *run you survive*, not a *level you solve*.

> **New session? Read this whole file.** The bottom half is the original design decision-log, competition analysis, and Pipe-Mania-reimagining framing — that's the *why* (note: some of it predates the sewage/protest reframe, but the core mechanics still hold). The section directly below is the *what exists now*: a playable prototype.

## Current status (prototype — built & playable)

A full playable loop runs. Built so far: forced queue with **procedurally-generated connectable paths**, tap-to-place + overwrite, countdown→flow→game-over, smooth sewage-fill animation, score-driven **difficulty ramp**, **camera-follow vertical scroll** over an infinite-downward grid, and the **protest layer** — the Water-Quality-vs-£-Profit tug-of-war meter, the **pond of fish as a living health bar**, spills that become **survivable leaks** (drain quality until capped; game over only when the pond dies), **power tiles** (speed-up/down, shareholder dividend, protest/judge), **clog tiles** (the unflushables — condom, wet wipes, cotton buds, oil, fat, sanitary pad), and the **four-way cross** piece. The open design risk is unchanged: *is the stacked pressure fun, or just stressful?* — play and tune.

### Commands

- `npm install` — once.
- `npm run dev` — Vite dev server (Phaser game in the browser; use device-emulation for touch).
- `npm run test` — Vitest (`npm run test:watch` to watch). Single file: `npx vitest run tests/flow.test.ts`.
- `npm run build` — type-check (`tsc`) + production bundle to `dist/`.

### Architecture

Deliberate split: a **framework-agnostic logic core** with **no Phaser imports**, so the rules are unit-testable and portable (and so scroll/flow-rate slot in as additive layers, not rewrites).

- `src/core/` — pure TS. `types.ts` (Side bitmask N/E/S/W; piece/power/junk/cell/queue/state types), `pieces.ts` (piece→openings incl. `cross` & `blocker`; `randomPiece`/`randomPower`/`randomJunk`; `opposite`/`step`/`sidesOf`), `grid.ts` (**sparse, infinite-downward** `Grid` keyed by world coord — bounded top+sides, no bottom; cells carry optional `power`/`junk`), `flow.ts` (`step1` = **the spill rule**; cross flows straight through), `queue.ts` (**procedural queue** — `planPath`/`connectablePath` build a guaranteed-solvable self-avoiding walk; `buildChunk` adds clogs, crosses, powers), `levels.ts` (**difficulty curve** — `levelForScore`, `decoysForLevel`, `powerChanceForLevel`, path lengths), `game.ts` (state machine, script-fed queue, **the tug-of-war meter `balance` + leak model + power effects + preloaded tiles**; **all feel knobs in the `CONFIG` object** — flow speed, meter drain/heal/dividend/protest amounts, preload count).
- **Queue generation (`queue.ts` + `levels.ts`):** NOT random. Each chunk is a **connectable backbone** (`planPath`, randomised-DFS self-avoiding walk, always on-grid → a winnable path always exists) plus spliced-in **clog blockers** (the unflushables — you dump them off-path), **bonus crosses**, and per-piece **power tags**. Opening chunk is long (`OPENING_PATH_LEN` ~20) for a fair start; continuation chunks shorter. Clog count and power chance rise per level. Solvability guarantee is strongest for the opening (empty board). `tests/queue.test.ts` proves across seeds that the path flows end-to-end.
- **Protest layer (`game.ts`):** `balance` (0..1) is the tug-of-war — 1 = pristine water, 0 = pond dead / game over. A spill is no longer instant death: it sets `leaking` and **drains `balance` each tick** until the player caps it (laying a connecting pipe; flow then auto-resumes since `tickFlow` re-runs `step1` every tick). Containment heals a little; **dividend** tiles drain balance (+£ profit), **protest** tiles restore it; **speed-up/down** tiles shift `flowMod`. Powers fire once when sewage fills the cell (`applyPower`), so placing a cursed tile off-path avoids it.
- `src/scenes/GameScene.ts` — Phaser presentation, all procedural `Graphics` (no assets): scrolling grid, sewage fill, **camera-follow** (`updateCamera`, monotonic), clog/power glyphs, leak gush, the **tug-of-war HUD bar** and the **pond of fish** (alive count ∝ quality). Renders off the core each frame; holds no rules. Layout bands: HUD / grid / queue / pond.
- `tests/` — Vitest: `flow.test.ts` (spill rule), `queue.test.ts` (path solvability + chunk contents), `mechanics.test.ts` (cross, clogs, leak/quality, powers), `levels.test.ts`, `game.test.ts`.

**The flow rule (the thing to get right):** sewage **flood-fills** — `floodStep(grid, filledSet)` in `flow.ts` returns, for the current filled set, the next BFS ring to fill (every connected neighbour, branching at crosses) and the list of **leaks** (open ends whose neighbour is off-grid/empty/clog/mismatched). One ring per tick. Each leak drains quality; capping it (building the connecting pipe) lets the flood resume. Pure function, guarded by tests.

Stack is **Phaser + TS in the browser now, Capacitor-wrap to iOS/Android later** (`vite.config.ts` uses a relative `base` so a `file://` wrapper works). Touch-first. Don't pull in Capacitor until the feel is validated with Paul.

## The pitch (one line)

"Pipe Mania meets a vertical roguelite" — survive a never-ending downward scroll by laying pipe from a forced queue fast enough to keep the water flowing, managing a flow rate that power-up cells push up and down. Game over when the water spills (hits an open end / unconnected edge).

## Core mechanics (decided)

- **Forced queue (DECIDED, not free-rotate).** Pieces arrive in a fixed "next" queue (Tetris-style); the player places them in order and cannot freely choose/rotate any cell to any shape. This forced randomness *is* the puzzle — free rotation was considered and rejected as too trivial/relaxed (that's the saturated zen-puzzle segment we're avoiding). Pieces: vertical, horizontal, directional bends, (later) cross-pipes.
- **The spill = win and lose condition are the same event** (stolen directly from Pipe Mania's best design idea). The water stopping is inevitable; the player races to make it stop *late enough* / survive longer. Defining *exactly when water spills* is the single most important fairness rule and the first thing to nail in a prototype.
- **Vertical scroll** — the grid moves under the player (endless-runner pressure). New, nobody in the pipe genre does this.
- **Flow rate as a managed resource** — starts as a trickle, modulated by power-up cells (increase/decrease flow rate, and other effects TBD). New; this is the central hook. A fast flow = less reaction time but more ground covered; slow = safer but the scroll may catch up.
- **Two modes were discussed; forced-queue is the committed primary.** A free-rotate mode may still be built later as a comparison/relaxed mode — it shares ~80% of the engine (grid, pipe-connection logic, flow sim) and differs only in the piece-supply rule.

## Key design risk (flagged, unresolved)

Stacking **three pressure systems** — forced queue + vertical scroll + flow rate — could be exhilarating or just punishing/stressful. This is the open question the first prototype must answer. Build the loop, feel it, then tune. Don't over-build before validating the feel.

## Build approach (proposed, not started)

Smallest playable loop first: fixed grid, water source, forced-queue piece placement, flow advances on a timer, lose on spill. **No scroll, no power-ups yet.** Get that feeling right, then layer scroll, then flow-rate power-ups — each independently tunable.

**Stack — undecided.** A single HTML + `<canvas>` file is the fastest path to "is this fun?". Phaser or PixiJS if going bigger. Platform target (web / mobile / desktop) not yet chosen. Decide with Paul before scaffolding.

## Pipe Mania reference facts (for grounding design)

- Pressure was a **start countdown** (seconds before the goo/"flooz" starts oozing), not a global clock. Once flowing, the goo itself is the moving deadline, advancing at a fixed speed that increases per level.
- Fail = goo reaches an open end and spills. Not instant game over: each level had a **minimum pipe-length quota**; spill after quota = advance, spill before = game over.
- It was a **forced queue** (sidebar of ~5 next pieces, placed in order). Overwriting an existing pipe was allowed but cost a time penalty. The forced randomness is the entire puzzle.

## Competition analysis (researched June 2026)

Market splits three ways:

1. **Zen "rotate-to-connect" puzzles — brutally saturated, AVOID.** No timer/fail/queue; rotate static tiles until the network lights up. Flow Free (2,500+ levels, the category king), Pipes (still updated, v2.0 Jan 2025), Water Pipes: Pipeline, Pipe Puzzle Legends, Aquavias, Sewer Quest, Line Puzzle: Pipe Art. Impossible to out-clone; ad-monetized to the floor.
2. **Faithful Pipe Mania ports — proven but stale/abandoned.** The 2008 Empire/Razorworks remake on Steam, assorted Google Play clones, open-source web clones (github liukaren/pipe-dream). All keep original mechanics frozen — none add scroll, flow management, or run-based progression.
3. **Cozy tile-laying titans — aspirational tonal comp, not direct rivals.** Mini Motorways, Dorfromantik (Spiel des Jahres 2023, began as a student thesis). Prove a minimalist routing/tile mechanic + right aesthetic + tension curve = breakout hit.

**The gap = the committed positioning:** forced-queue arcade tension (proven but abandoned) + vertical scroll (nobody) + flow-rate power-ups (nobody) + run/roguelite framing (nobody in pipes). Mechanically novel; the one-line pitch doesn't exist on any store today.

**Mild validation, not a threat:** Playdate's "Water Flow" uses the crank to control flow speed — proof the "flow rate as a player-managed dial" idea resonates, but tiny-niche hardware with no reach.

**The trap:** competing in the relaxed segment. **The risk:** the three-deadline stack being stressful rather than fun (see design risk above).
