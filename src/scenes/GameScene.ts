import Phaser from "phaser";
import factsData from "../../data/facts.json";
import { CONFIG, Game } from "../core/game";
import { qualifies } from "../core/highscores";
import { drawFlashButton } from "./ui";
import { PIECE_OPENINGS, sidesOf, JUNK_TYPES } from "../core/pieces";
import {
  Side,
  type Cell,
  type Coord,
  type FlowEvent,
  type GameState,
  type JunkType,
  type PowerType,
  type QueuePiece,
} from "../core/types";

const CELL = 80;
const GRID_X = 0; // the grid fills the whole canvas now (no reserved sidebar)
const HUD_H = 40; // reserved top band for the score + poo-o-meter (the grid sits below it)
const POND_H = 100;
// The queue + gauge no longer reserve a column — they OVERLAY the left of the board
// on a translucent layer so the board reclaims the full width.
const QUEUE_W = 72; // width of the translucent queue/gauge overlay strip
const QUEUE_ALPHA = 0.7; // 70% opacity so the board shows through the HUD

const ARCADE_FONT = "'Press Start 2P', monospace";

export const GAME_WIDTH = CONFIG.cols * CELL;
export const GAME_HEIGHT = HUD_H + CONFIG.rows * CELL + POND_H;

const COLORS = {
  grassBase: 0x2f4a1c, // surface (around the toilet + first pipe)
  grassBlade: 0x4f8129,
  grassBladeDark: 0x3a6020,
  soilBase: 0x382819, // underground (where the player digs/lays pipe)
  soilSpeckle: 0x2b1e12,
  soilSpeckleLight: 0x4a3520,
  plant: 0x2fa37a, // aquatic plants in the pond
  plantDark: 0x247c5d,
  hotspot: 0x3fd0ff, // bright blue target rings on the plughole
  mystery: 0x8a7fb0, // neutral box for the speed tiles (don't reveal up vs down)
  pipe: 0x6b7280,
  sewage: 0x7a6a2e,
  source: 0x8a5a26,
  clog: 0x3b3128,
  hud: 0x0c0b0a,
  queueBg: 0x0c0b0a,
  slot: 0x161310,
  slotCurrent: 0x2a2114,
  current: 0xffd24a,
  quality: 0x29c2a6,
  profit: 0xe6b422,
  pondClean: 0x2a9d8f,
  pondDirty: 0x5b4a2a, // sewage filling the pond
  pondShitTop: 0x7a6638, // lighter muck at the rising surface
  fishAlive: 0x9be15d,
  fishDead: 0x9aa0a6, // grey belly-up
  leak: 0x9aae3a,
  speed: 0x4ec3ff,
  protest: 0x4ade80,
  dividend: 0xff5c5c,
  text: "#e8e2d4",
  dim: "#9a8f78",
} as const;

const JUNK_TINT: Record<JunkType, number> = {
  "wet-wipes": 0xc3c8cd,
  "cotton-buds": 0xe8e2d4,
  condom: 0xc9b8d8,
  "sanitary-pad": 0xded6c8,
};

const POWER_SPRITE: Record<PowerType, string> = {
  "speed-up": "power-faucet",
  "speed-down": "power-faucet",
  protest: "power-fist",
  score: "power-star",
  freeze: "power-snowflake",
  poison: "power-poison",
  rain: "power-rain",
  blitz: "power-blitz",
};

/** Marker frame colour — good powers read friendly, the poison hazard reads as a warning. */
const POWER_TINT: Record<PowerType, number> = {
  "speed-up": 0x6fd3ff,
  "speed-down": 0x6fd3ff,
  protest: 0x9be15d,
  score: 0xffd24a,
  freeze: 0x8fe3ff,
  poison: 0xff5c5c,
  rain: 0x7fb8ff,
  blitz: 0xffe14a,
};

const TOAST_MS = 1700;

// Mario-Kart-style "next pipe" roulette: cycle shapes rapidly, then lock in.
const EXPLOSION_MS = 700;

const JUNK_NAMES: JunkType[] = ["condom", "wet-wipes", "cotton-buds", "sanitary-pad"];

// World rows 0..SURFACE_ROWS-1 are grassy surface (toilet + first pipe); below is soil.
const SURFACE_ROWS = 1; // a single row of grass at the surface

// Spilled-sewage gravity drips that cascade from leaks into the pond.
const DRIP_GRAVITY = 1300; // px/s^2 — gentle enough that the fall reads, not a flicker
const DRIP_SPAWN_MS = 60;
const DRIP_MAX = 200;
interface Drip {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/** A splash particle thrown up when a drip hits the pond (or a spreading ripple). */
interface Splash {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // ms remaining
  ripple: boolean;
}


/** An unflushable tumbling down into the pond after the sewage carried it through. */
interface JunkDrop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  icon: string;
  size: number;
  floating: boolean; // true once it has landed on the pond surface
}

// Camera: only scroll once the flood reaches the bottom `MARGIN` tiles.
const FOLLOW_BOTTOM_MARGIN = 2;
const SCROLL_SMOOTH_MS = 140;

const Z_GRID_SPRITE = 10;
const Z_UI = 20;
const Z_UI_SPRITE = 25;
const Z_TEXT = 30;

/** Stable pseudo-random in [0,1) from three ints — for fixed texture placement. */
function hash3(a: number, b: number, c: number): number {
  const n = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

/** Scale a packed RGB colour's brightness (f>1 lightens, f<1 darkens). */
function shade(color: number, f: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * f));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * f));
  const b = Math.min(255, Math.round((color & 0xff) * f));
  return (r << 16) | (g << 8) | b;
}

/** Blend two packed RGB colours (t=0 -> a, t=1 -> b). */
function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const r = Math.round(ar + (((b >> 16) & 0xff) - ar) * t);
  const g = Math.round(ag + (((b >> 8) & 0xff) - ag) * t);
  const bl = Math.round(ab + ((b & 0xff) - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

// the poo runs from mustard-yellow through to dark brown, varied per segment
const SEWAGE_YELLOW = 0xcaa53e;
const SEWAGE_BROWN = 0x5c3c19;
const FROZEN_TINT = 0x6fd6c8; // icy greeny-blue the poo takes on while a freeze is active

// fish species palette — picked per fish so each level's pond looks different
const FISH_COLORS = [0x9be15d, 0xffb347, 0x6fd3ff, 0xff8da3, 0xc792ea, 0xf6e05e];

const PLACE_ANIM_MS = 170;
const INTRO_MS = 1150; // board reveal after START: obstacles spin in, queue slides, hints appear
const WIN_DRAIN_MS = 1500; // on a win, the flow eases to a stop + the pipes drain before the card
const OVERWRITE_BUSY_MS = 1100; // re-laying a tile blocks the next placement while the smoke clears (time penalty)
const GAUGE_STEPS = 12; // the spill strip is divided into this many "major steps" (one tick each)
const FACTS: { fact: string; source: string }[] = factsData.facts;
// End-screen gut-punch: the player's single spill vs the real 2024 scale (one per level, cycled).
const COMPARISONS: string[] = [
  "In 2024, Thames Water alone dumped\nraw sewage for 298,081 HOURS.\nThis was one spill.",
  "England's water firms spilled sewage for\n3.61 MILLION hours in 2024.\nThis was one of them.",
  "There were 450,398 sewage spills in\nEngland in 2024 — 1,200 a day.\nThis was one.",
  "In 2024 a sewage discharge began\nroughly every 30 seconds.\nThis was one.",
  "Not one river in England is in good\noverall health. This spill is why.",
];
// SFX names: a real sample at assets/sfx/<name>.mp3 plays in preference to the synth fallback.
const SFX_NAMES = ["place", "flow", "leak", "cap", "tick", "win", "lose", "splosh", "junk", "score", "freeze", "poison", "rain", "blitz", "speedup"] as const;

/** Ease-out with a little overshoot — the "ta-da" pop. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

type G = Phaser.GameObjects.Graphics;

export class GameScene extends Phaser.Scene {
  private model!: Game;
  private gfxWorld!: G;
  private gfxUi!: G;
  private gfxQueue!: G; // translucent overlay layer for the queue + gauge HUD
  /** Dedicated, masked layer for the next-piece reel so symbols clip at the box rim.
   *  The mask is applied ONLY while spinning — a persistent mask does a per-frame
   *  stencil pass even when idle, which is slow on software WebGL. */
  private statusText!: Phaser.GameObjects.Text;
  private fpsText!: Phaser.GameObjects.Text;
  private centerText!: Phaser.GameObjects.Text;

  private scrollPx = 0;
  private scrollTargetPx = 0;
  private clock = 0;
  private flowPhase = 0; // accumulated flow-texture drift in px (moves with the sewage front)
  private runBeganAt = -1e9; // clock time the run started (drives the board-reveal intro)
  private intro = 0; // 0..1 board-reveal progress, recomputed each render

  /** Falling spilled-sewage particles (leak -> pond). */
  private drips: Drip[] = [];
  private splashes: Splash[] = [];
  /** Dead fish, each rising from where it died up to the pond surface (then bobbing). */
  private deadFloaters: { kind: number; x: number; startY: number; bornAt: number }[] = [];
  private dripTimer = 0;
  /** Unflushables tumbling into the pond after being flowed through. */
  private junkDrops: JunkDrop[] = [];
  /** cellKey -> clock time placed, for the pipe draw-in animation. */
  private placedAnim = new Map<string, number>();
  private prevState: GameState = "COUNTDOWN";
  /** Pending (re)start — deferred out of the input callback to the next tick. */
  private pendingRestart: { level: number; fishSaved: number; runScore: number; seenHints: string[] } | null = null;
  /** Pending return to the title screen (run ended) — deferred out of the input callback. */
  private pendingMenu: { pendingScore: number; pendingLevel: number } | null = null;
  /** Dev FPS readout — hidden by default, toggled with the backtick key. */
  private showFps = false;
  /** While the smoke from a re-laid tile clears, placement is blocked (the overwrite time penalty). */
  private overwriteBusyUntil = 0;
  /** Player paused the run ("P"); the sim freezes and a RESUME overlay shows. */
  private paused = false;
  /** RESUME button hit rect while paused (null otherwise). */
  private pauseButton: { x: number; y: number; w: number; h: number } | null = null;
  /** Smoothed X of the next-pipe box — slides right when the action is behind it. */
  /** Active dynamite blasts (world row/col so they scroll with the grid). */
  private explosions: { row: number; col: number; start: number; seed: number }[] = [];
  /** Blast debris — embers (fire) and muck chunks — flung out under gravity (screen space). */
  private blastBits: { x: number; y: number; vx: number; vy: number; r: number; color: number; born: number; life: number }[] = [];
  /** Rising smoke puffs after a blast. */
  private smokePuffs: { x: number; y: number; vy: number; r: number; born: number; life: number; color: number }[] = [];
  /** Floating "+N BONUS" score pops that rise and fade (score markers). */
  private scorePops: { x: number; y: number; value: number; born: number }[] = [];
  /** Lightning strikes that zap each blitzed tile in (row/col so they track the scroll). */
  private blitzStrikes: { row: number; col: number; born: number; seed: number }[] = [];
  /** Hit-rect of the end-of-level dialog button (null when no dialog is shown). */
  private endButton: { x: number; y: number; w: number; h: number } | null = null;
  /** Hit-rect of the pre-run Start button (null once the run has begun). */
  private startButton: { x: number; y: number; w: number; h: number } | null = null;
  // drag-to-scroll: distinguish a tap (place) from a drag (pan), and peek away
  // from the auto-follow camera until `manualScrollUntil`, then drift back.
  private dragStartX = 0;
  private dragStartY: number | null = null;
  private dragStartScroll = 0;
  private dragging = false;
  private manualScrollUntil = 0;
  private buttonText!: Phaser.GameObjects.Text;
  /** A real UK water-pollution fact shown on each level's start popup. */
  private factText!: Phaser.GameObjects.Text;
  /** The end-screen real-world comparison line (the awareness gut-punch). */
  private compareText!: Phaser.GameObjects.Text;
  // SNES-style level-clear tally (count-up + beeps)
  private audio?: AudioContext;

  /** Current on-screen "Oh No. Condom!"-style toast. */
  private toast: { label: string; icon: string; start: number } | null = null;
  private toastText!: Phaser.GameObjects.Text;

  /** Llamatron-style instruction banners ("REMOVE THE FATBERG WITH THE DYNAMITE!") that flash
   *  at key moments. A small queue so several can play back-to-back. */
  private banner: { lines: string[]; start: number; hold: number } | null = null;
  private bannerQueue: { lines: string[]; hold: number }[] = [];
  private bannerText!: Phaser.GameObjects.Text;
  private countdownLabel!: Phaser.GameObjects.Text; // small "SPILL" caption under the gauge
  private countdownNum!: Phaser.GameObjects.Text; // the gauge's centre readout (3·2·1 / segments left)
  private gaugeF = 0; // smoothed marker position (0 = SAFE, 1 = SPILL)
  private lastGaugeStep = -999; // last quantised gauge step that ticked
  /** One-time hints already shown THIS RUN (survives level restarts via the scene data). */
  private seenHints = new Set<string>();
  private prevStarted = false;
  private devPowerIdx = 0; // dev "P" key cycles through the power types
  // --- juice / SFX state ---
  private prevContained = 0; // for the per-segment flow blip
  private prevLeaking = false; // for leak-start / cap sounds
  private easedBanner = false; // "SPILL EASING" banner fired once per level
  private lastSploshAt = 0; // throttle the river-splash sound
  private flashUntil = -1; // full-screen colour flash (surge / win)
  private flashColor = 0xffffff;
  private winDrainStart = -1; // clock when the win-drain began (pipes empty out)

  /** Pooled sprite images, re-used each frame. */
  private sprites: Phaser.GameObjects.Image[] = [];
  private spriteIdx = 0;
  /** Pooled text labels (e.g. the faucet 2x/3x/4x tags), re-used each frame. */
  private labels: Phaser.GameObjects.Text[] = [];
  private labelIdx = 0;

  /** Roulette bookkeeping for the "next pipe" box. */
  private prevFront: QueuePiece | undefined;
  private slideOff: QueuePiece | undefined; // the piece that just left the active slot (slides off left)
  private rouletteStart = -9999; // reused as the queue slide-start clock
  private queueShiftT = 0; // 0 = queue at its left home, 1 = slid to the right (out of the way)

  constructor() {
    super("GameScene");
  }

  preload(): void {
    // a 404 on the optional PNG overrides below is harmless — we fall back to SVG
    this.load.on("loaderror", () => {});
    for (const j of JUNK_NAMES) {
      this.load.svg(`junk-${j}`, `assets/junk/${j}.svg`, { width: 72, height: 72 });
      this.load.image(`junk-${j}-hd`, `assets/junk/${j}.png`); // drop a PNG to override
    }
    // tight-trimmed PNGs (the SVGs sat off-centre in their square viewBoxes)
    this.load.image("power-faucet", "assets/power/faucet.png");
    this.load.svg("power-fist", "assets/power/fist.svg", { width: 128, height: 128 });
    this.load.image("power-star", "assets/power/star.png");
    this.load.image("power-snowflake", "assets/power/snowflake.png");
    this.load.image("power-poison", "assets/power/poison.png");
    this.load.image("power-rain", "assets/power/rain.png");
    this.load.image("power-blitz", "assets/power/lightning.png");
    this.load.svg("decor-toilet-svg", "assets/decor/toilet.svg", { width: 256, height: 256 });
    this.load.svg("decor-arrow", "assets/decor/arrow-down.svg", { width: 64, height: 64 });
    this.load.svg("hint", "assets/decor/hint.svg", { width: 64, height: 64 });
    this.load.svg("fatberg", "assets/decor/fatberg.svg", { width: 200, height: 200 });
    this.load.svg("rock", "assets/decor/rock.svg", { width: 128, height: 128 });
    this.load.svg("poo", "assets/decor/poo.svg", { width: 64, height: 64 });
    for (let i = 1; i <= 5; i++) {
      this.load.svg(`fish-${i}`, `assets/decor/fish-${i}.svg`, { width: 96, height: 96 });
      // a greyscale copy of the SAME species shape — a corpse should read as the same fish, drained
      this.load.svg(`fish-${i}-dead`, `assets/decor/fish-${i}-dead.svg`, { width: 96, height: 96 });
    }
    this.load.image("decor-toilet", "assets/decor/toilet.png"); // drop your PNG to override
    // optional SFX samples — drop assets/sfx/<name>.mp3 and it overrides the synth fallback
    for (const s of SFX_NAMES) this.load.audio(`sfx-${s}`, `assets/sfx/${s}.mp3`);
  }

  create(data?: { level?: number; fishSaved?: number; runScore?: number; seenHints?: string[] }): void {
    this.model = new Game(undefined, data?.level ?? 1, data?.fishSaved ?? 0, data?.runScore ?? 0);
    this.seenHints = new Set(data?.seenHints ?? []);
    this.banner = null;
    this.bannerQueue = [];
    this.prevStarted = false;
    this.runBeganAt = -1e9;
    this.intro = 0;
    this.scrollPx = 0;
    this.scrollTargetPx = 0;
    this.clock = 0;
    this.flowPhase = 0;
    this.spriteIdx = 0;
    this.drips = [];
    this.splashes = [];
    this.deadFloaters = [];
    this.dripTimer = 0;
    this.junkDrops = [];
    this.placedAnim.clear();
    this.prevState = "COUNTDOWN";
    this.pendingRestart = null;
    this.pendingMenu = null;
    this.overwriteBusyUntil = 0;
    this.paused = false;
    this.pauseButton = null;
    this.explosions = [];
    this.blastBits = [];
    this.smokePuffs = [];
    this.scorePops = [];
    this.blitzStrikes = [];
    this.prevContained = 0;
    this.prevLeaking = false;
    this.easedBanner = false;
    this.lastSploshAt = 0;
    this.flashUntil = -1;
    this.winDrainStart = -1;
    this.gaugeF = 0;
    this.lastGaugeStep = -999;
    this.endButton = null;
    this.startButton = null;
    this.dragStartY = null;
    this.dragging = false;
    this.manualScrollUntil = 0;
    this.queueShiftT = 0;
    this.toast = null;
    this.prevFront = undefined;
    this.rouletteStart = -9999;
    this.sprites = []; // pooled images were destroyed on restart — rebuild fresh
    this.labels = [];

    this.gfxWorld = this.add.graphics();
    this.gfxUi = this.add.graphics().setDepth(Z_UI);
    // queue/gauge overlay: above the grid + its sprites, below text, at 70% opacity
    this.gfxQueue = this.add.graphics().setDepth(Z_UI_SPRITE + 1).setAlpha(QUEUE_ALPHA);

    // SCORE — overlaid at the top of the grid (the queue band is the left sidebar now)
    this.statusText = this.add
      .text(GRID_X + 10, 8, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "13px",
        color: COLORS.text,
        align: "left",
        stroke: "#06101a",
        strokeThickness: 4,
      })
      .setOrigin(0, 0)
      .setDepth(Z_TEXT);
    this.centerText = this.add
      .text(GAME_WIDTH / 2, (CONFIG.rows * CELL) / 2, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "15px",
        color: COLORS.text,
        align: "center",
        lineSpacing: 12,
      })
      .setOrigin(0.5)
      .setDepth(Z_TEXT);
    this.fpsText = this.add // dev FPS readout (bottom-left)
      .text(8, 8, "", { fontFamily: "monospace", fontSize: "12px", color: "#9fe" })
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(Z_TEXT);
    this.toastText = this.add
      .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "13px", color: COLORS.text })
      .setOrigin(0, 0.5)
      .setDepth(Z_TEXT)
      .setVisible(false);
    this.factText = this.add
      .text(GAME_WIDTH / 2, 0, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "10px",
        color: "#bfe0c4",
        align: "center",
        lineSpacing: 5,
        wordWrap: { width: 360 },
        stroke: "#06101a",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(Z_TEXT)
      .setVisible(false);
    this.compareText = this.add
      .text(GAME_WIDTH / 2, 0, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "11px",
        color: "#cfe6ff",
        align: "center",
        lineSpacing: 6,
        wordWrap: { width: 360 },
        stroke: "#06101a",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0)
      .setDepth(Z_TEXT)
      .setVisible(false);
    this.bannerText = this.add
      .text(GAME_WIDTH / 2, 0, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "22px",
        color: "#ffd24a",
        align: "center",
        lineSpacing: 10,
        stroke: "#06101a",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(Z_TEXT)
      .setVisible(false);
    this.countdownLabel = this.add
      .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "9px", color: "#cdd3da", align: "center", stroke: "#06101a", strokeThickness: 3 })
      .setOrigin(0.5)
      .setDepth(Z_TEXT + 5)
      .setScrollFactor(0)
      .setVisible(false);
    this.countdownNum = this.add
      .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "19px", color: "#ffffff", align: "center", stroke: "#06101a", strokeThickness: 4 })
      .setOrigin(0.5)
      .setDepth(Z_TEXT + 5)
      .setScrollFactor(0)
      .setVisible(false);
    this.buttonText = this.add
      .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "14px", color: "#12100e" })
      .setOrigin(0.5)
      .setDepth(Z_TEXT)
      .setVisible(false);

    this.input.on("pointerdown", this.onDown, this);
    this.input.on("pointermove", this.onMove, this);
    this.input.on("pointerup", this.onUp, this);
    // player keys: Q = quit to title, P = pause/resume, Enter/Space = the shown button
    this.input.keyboard?.on("keydown-Q", () => this.quitToTitle());
    this.input.keyboard?.on("keydown-P", () => this.togglePause());
    this.input.keyboard?.on("keydown-BACKTICK", () => (this.showFps = !this.showFps)); // ` toggles FPS
    this.input.keyboard?.on("keydown-ENTER", () => this.activatePrimaryButton());
    this.input.keyboard?.on("keydown-SPACE", () => this.activatePrimaryButton());
    // dev shortcuts: N = next level; D = kill a fish; F = fire the next power (cycles)
    this.input.keyboard?.on("keydown-N", () => {
      this.pendingRestart = {
        level: this.model.level + 1,
        fishSaved: this.model.fishSaved,
        runScore: this.model.runScore,
        seenHints: [...this.seenHints],
      };
    });
    this.input.keyboard?.on("keydown-D", () => this.model.killFish());
    this.input.keyboard?.on("keydown-F", () => {
      const cycle: PowerType[] = ["score", "freeze", "poison", "rain", "blitz", "speed-up"];
      const power = cycle[this.devPowerIdx % cycle.length];
      this.devPowerIdx++;
      this.model.devFirePower(power);
    });
  }

  /** Point-in-rect test for the modal buttons. */
  private hit(b: { x: number; y: number; w: number; h: number } | null, x: number, y: number): boolean {
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }

  /** Fire whichever modal button is currently shown — shared by taps and the Enter key. */
  private activatePrimaryButton(): void {
    if (this.paused) {
      this.paused = false;
    } else if (!this.model.started) {
      this.unlockAudio();
      this.model.beginRun();
    } else if (this.model.state === "WON") {
      this.advanceLevel();
    } else if (this.model.state === "GAMEOVER") {
      this.quitToTitle();
    }
  }

  /** Advance to the next level, carrying the score + seen hints forward. */
  private advanceLevel(): void {
    this.pendingRestart = {
      level: this.model.level + 1,
      fishSaved: this.model.fishSaved,
      runScore: this.model.runScore,
      seenHints: [...this.seenHints],
    };
  }

  /** Quit the current run back to the title (the score rides along for the table). */
  private quitToTitle(): void {
    this.paused = false;
    this.pendingMenu = { pendingScore: this.model.runScore, pendingLevel: this.model.level };
  }

  /** Toggle pause — only meaningful while a run is actually in progress. */
  private togglePause(): void {
    if (!this.model.started || this.model.state === "WON" || this.model.state === "GAMEOVER") return;
    this.paused = !this.paused;
  }

  /** Lazily create + unlock the WebAudio context on the first user gesture. */
  private unlockAudio(): void {
    try {
      if (!this.audio) this.audio = new AudioContext();
      if (this.audio.state === "suspended") void this.audio.resume();
    } catch {
      /* audio unavailable — silent */
    }
  }

  /** A tone with an optional pitch glide and start delay — the SFX building block. */
  private tone(freq: number, durMs: number, type: OscillatorType, vol: number, endFreq?: number, delayMs = 0): void {
    const ctx = this.audio;
    if (!ctx || ctx.state !== "running") return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      const now = ctx.currentTime + delayMs / 1000;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), now + durMs / 1000);
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durMs / 1000);
    } catch {
      /* ignore */
    }
  }

  /** A white-noise burst through a (optionally swept, optionally resonant) lowpass — the filter
   *  glide from `startHz` to `endHz` is what turns hiss into a splash/squelch; `q` adds the wet
   *  resonant "vowel". `attackMs` lets the gain swell (a rising splash) instead of just decay. */
  private noise(durMs: number, vol: number, startHz: number, endHz = startHz, q = 0.7, attackMs = 0): void {
    const ctx = this.audio;
    if (!ctx || ctx.state !== "running") return;
    try {
      const n = Math.floor((ctx.sampleRate * durMs) / 1000);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.Q.value = q;
      const now = ctx.currentTime;
      const end = now + durMs / 1000;
      filt.frequency.setValueAtTime(startHz, now);
      filt.frequency.exponentialRampToValueAtTime(Math.max(40, endHz), end);
      const gain = ctx.createGain();
      const peakAt = now + Math.min(attackMs, durMs * 0.6) / 1000;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(vol, peakAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      src.connect(filt);
      filt.connect(gain);
      gain.connect(ctx.destination);
      src.start(now);
      src.stop(end);
    } catch {
      /* ignore */
    }
  }

  /** Play SFX `name`: a real sample at assets/sfx/<name>.mp3 if present, else the synth fallback. */
  private playSfx(name: string, fallback: () => void, vol = 0.5): void {
    if (this.cache.audio.exists(`sfx-${name}`)) {
      try { this.sound.play(`sfx-${name}`, { volume: vol }); return; } catch { /* fall through */ }
    }
    fallback();
  }

  // ---- named game SFX (sample if provided, else synthesized) ----
  private sfxPlace(): void { this.playSfx("place", () => { this.noise(55, 0.025, 1400); this.tone(150, 80, "sine", 0.022, 90); }, 0.14); }
  private sfxFlow(pct: number): void { this.playSfx("flow", () => this.tone(170 + pct * 160, 55, "sine", 0.028, 230 + pct * 160), 0.35); }
  private sfxLeak(): void { this.playSfx("leak", () => { this.tone(440, 300, "sawtooth", 0.05, 170); this.tone(300, 300, "square", 0.03, 150, 50); }); }
  private sfxCap(): void { this.playSfx("cap", () => this.tone(260, 130, "square", 0.05, 540)); }
  private sfxTick(): void { this.playSfx("tick", () => this.tone(1100, 26, "square", 0.02, 1100), 0.22); }
  private sfxWin(): void { this.playSfx("win", () => [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 200, "triangle", 0.06, f, i * 110))); }
  private sfxLose(): void { this.playSfx("lose", () => this.tone(330, 650, "sawtooth", 0.06, 80)); }
  private sfxSplosh(): void { this.playSfx("splosh", () => { this.noise(240, 0.03, 2600, 280, 2, 40); this.tone(420, 200, "sine", 0.02, 150); }, 0.16); }
  private sfxJunk(): void { this.playSfx("junk", () => { this.noise(190, 0.09, 2400, 190, 9, 8); this.tone(150, 160, "sine", 0.05, 52); }); }
  private sfxPower(power: PowerType): void {
    const name = power === "speed-up" ? "speedup" : power;
    this.playSfx(name, () => {
      switch (power) {
        case "score": [660, 880, 1100].forEach((f, i) => this.tone(f, 90, "triangle", 0.05, f, i * 55)); break;
        case "freeze": this.tone(820, 420, "sine", 0.05, 200); break;
        case "poison": this.tone(160, 300, "sawtooth", 0.06, 60); this.noise(220, 0.04, 700); break;
        case "rain": this.noise(520, 0.05, 950); break;
        case "blitz": this.noise(70, 0.06, 3200); this.tone(1200, 130, "square", 0.05, 220); break;
        default: this.tone(300, 180, "square", 0.04, 900); // speed-up whoosh
      }
    });
  }

  private onDown(p: Phaser.Input.Pointer): void {
    this.unlockAudio();
    this.dragStartX = p.x;
    this.dragStartY = p.y;
    this.dragStartScroll = this.scrollPx;
    this.dragging = false;
  }

  /** Drag up/down to pan the grid (peek above/below the auto-follow view). */
  private onMove(p: Phaser.Input.Pointer): void {
    if (this.dragStartY === null || !p.isDown) return;
    const dx = p.x - this.dragStartX;
    const dy = p.y - this.dragStartY;
    if (!this.dragging && Math.hypot(dx, dy) > 10) this.dragging = true; // tap vs drag
    if (this.dragging) {
      this.manualScrollUntil = this.clock + 2500; // hold the peek, then drift back
      this.scrollPx = Math.max(0, Math.min(this.maxScroll(), this.dragStartScroll - dy));
      this.scrollTargetPx = this.scrollPx;
    }
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const wasDrag = this.dragging;
    this.dragStartY = null;
    this.dragging = false;
    if (wasDrag) return; // it was a scroll, not a placement

    // Paused: the board is frozen — only the RESUME button responds.
    if (this.paused) {
      if (this.hit(this.pauseButton, p.x, p.y)) this.activatePrimaryButton();
      return;
    }

    // Pre-run Start screen: only the Start button does anything.
    if (!this.model.started) {
      if (this.hit(this.startButton, p.x, p.y)) this.activatePrimaryButton();
      return;
    }

    // Defer scene restarts to the next update tick (restarting inside an input
    // callback can leave the scene half-torn-down -> blank screen).
    if (this.model.state === "WON" || this.model.state === "GAMEOVER") {
      if (this.hit(this.endButton, p.x, p.y)) this.activatePrimaryButton();
      return;
    }
    // No placing until the board-reveal has settled — the game proper starts after the reel.
    if (this.clock - this.runBeganAt < INTRO_MS) return;
    // Overwrite time penalty: can't place again until the smoke from the last re-laid tile clears.
    if (this.clock < this.overwriteBusyUntil) return;
    const coord = this.toCell(p.x, p.y);
    if (coord && this.model.placePiece(coord)) {
      this.placedAnim.set(`${coord.row},${coord.col}`, this.clock); // animate it drawing in
      this.manualScrollUntil = 0; // resume auto-follow now that you've acted
      this.sfxPlace(); // a satisfying clunk
    }
  }

  /** How far down the player may pan — a few rows past the deepest action. */
  private maxScroll(): number {
    const deepest = Math.max(this.model.buildRow, this.model.frontRow);
    return Math.max(0, (deepest - this.visRows + 4) * CELL);
  }

  private toCell(x: number, y: number): Coord | null {
    if (x < GRID_X || y < HUD_H || y > this.gridBottom) return null; // taps in the sidebar / pond aren't cells
    const col = Math.floor((x - GRID_X) / CELL);
    const row = Math.floor((y - HUD_H + this.scrollPx) / CELL);
    const coord = { row, col };
    return this.model.grid.inBounds(coord) ? coord : null;
  }

  private rowScreenY(row: number): number {
    return HUD_H + row * CELL - this.scrollPx;
  }

  /** Screen X of a column's left edge (the grid is shifted right by the left sidebar). */
  private colX(col: number): number {
    return GRID_X + col * CELL;
  }

  // ---- responsive layout (canvas height matches the device, pond pinned to bottom) ----
  private get viewH(): number {
    return this.scale.gameSize.height;
  }
  /** Screen Y where the grid ends and the pond begins. */
  private get pondTop(): number {
    return this.viewH - POND_H;
  }
  /** Bottom of the scrolling grid (the river begins here; the queue band is up top). */
  private get gridBottom(): number {
    return this.pondTop;
  }
  /** Number of grid rows that fit between the top band and the pond. */
  private get visRows(): number {
    return Math.max(1, Math.floor((this.gridBottom - HUD_H) / CELL));
  }

  update(_time: number, deltaMs: number): void {
    // a tap on the win/lose screen queued a restart — do it cleanly here
    if (this.pendingRestart) {
      const data = this.pendingRestart;
      this.pendingRestart = null;
      this.scene.restart(data);
      return;
    }
    // run ended -> hand the final score to the title screen (initials entry + table)
    if (this.pendingMenu) {
      const data = this.pendingMenu;
      this.pendingMenu = null;
      this.scene.start("TitleScene", data);
      return;
    }

    this.clock += deltaMs; // UI clock always ticks (overlays/buttons keep animating while paused)
    // While paused the simulation gets zero elapsed time — everything freezes in place.
    const simDt = this.paused ? 0 : deltaMs;
    // Advance the flow-texture phase at exactly the speed the sewage front moves (one CELL
    // per ring). Accumulated (not clock×rate) so a rate change — superflow, speed powers —
    // changes future drift without teleporting every speck.
    let flowRate = CELL / Math.max(1, this.model.ringFlowMs);
    if (this.model.state === "WON" && this.winDrainStart >= 0) {
      // contained! the held sewage eases to a stop instead of freezing dead (it's NOT drained)
      flowRate *= Math.max(0, 1 - (this.clock - this.winDrainStart) / WIN_DRAIN_MS);
    }
    if (!this.model.frozen) this.flowPhase += simDt * flowRate;
    // Hold the countdown while the board is still revealing (obstacles reeling in). The reveal is
    // a pure scene animation; the game proper only begins once every tile has settled.
    const revealing = this.model.started && this.clock - this.runBeganAt < INTRO_MS;
    this.model.update(revealing ? 0 : simDt);

    // level cleared: fanfare + green flash, then the contained sewage eases to a stop.
    if (this.model.state === "WON" && this.prevState !== "WON") {
      this.sfxWin();
      this.flashUntil = this.clock + 450;
      this.flashColor = 0x9be15d;
      this.winDrainStart = this.clock;
      this.queueBanner(["SPILL CONTAINED!"], 1500); // the settle beat before the report card
    }
    if (this.model.state === "GAMEOVER" && this.prevState !== "GAMEOVER") {
      this.sfxLose();
      this.flashUntil = this.clock + 450;
      this.flashColor = 0xff5c5c;
    }
    this.prevState = this.model.state;

    // --- juice: flow blip, leak alarm / cap, and the spill SURGE -> EASE phase callouts ---
    const m = this.model;
    if (m.started && m.state === "FLOWING") {
      if (m.overflowContained > this.prevContained) this.sfxFlow(m.overflowPct / 100);
      if (m.leaking && !this.prevLeaking) { this.sfxLeak(); this.cameras.main.shake(180, 0.01); }
      if (!m.leaking && this.prevLeaking) this.sfxCap();
      // the surge subsiding near the end — flashed in the banner spot
      if (!this.easedBanner && m.overflowTotal > 0 && m.overflowContained / m.overflowTotal >= 0.75) {
        this.easedBanner = true;
        this.queueBanner(["SPILL EASING"], 1400);
      }
    }
    this.prevContained = m.overflowContained;
    this.prevLeaking = m.leaking;

    this.updateCamera(simDt);
    this.updateDrips(simDt);
    this.updateBlast(simDt);

    // each special tile the sewage hits: clogs tumble into the pond; newest pops a toast
    // message popups are disabled for now — keep only the physical effects
    // (junk tumbling into the pond, the dynamite blast)
    for (const e of this.model.consumeEvents()) {
      if (e.kind === "clog") { this.spawnJunkDrop(e); this.sfxJunk(); } // wet squelch as you clear it
      else if (e.kind === "overwrite") this.spawnSmoke(e.coord.row, e.coord.col); // re-laid tile: a puff + time penalty
      else if (e.kind === "explosion") this.spawnBlast(e.coord.row, e.coord.col);
      else if (e.kind === "power" && e.power === "score") { this.spawnScorePop(e.coord, e.value ?? 0); this.sfxPower("score"); }
      else if (e.kind === "power" && e.power === "blitz") {
        this.spawnBlitz(e.coords ?? []);
        this.onPowerFired(e.power);
      } else if (e.kind === "power" && e.power) this.onPowerFired(e.power);
    }

    // Llamatron-style instruction banners + board-reveal intro kick-off
    if (this.model.started && !this.prevStarted) {
      this.runBeganAt = this.clock; // start the obstacles-spin-in / queue-slide reveal
      this.queueBanner([`LEVEL ${this.model.level}`], 1900); // level-start flash
      this.queueBanner(["SPILL STARTING!"], 1400); // ...then the spill-starting cue (after LEVEL N)
    }
    this.prevStarted = this.model.started;
    // first fatberg of the run — flashed once it scrolls into view
    if (!this.seenHints.has("fatberg") && this.model.fatbergAt) {
      const fy = this.rowScreenY(this.model.fatbergAt.row);
      if (fy <= this.pondTop && fy >= HUD_H - CELL * 2) {
        this.seenHints.add("fatberg");
        this.queueBanner(["REMOVE THE FATBERG", "WITH THE DYNAMITE!"], 3200);
      }
    }

    this.render();
  }

  /** A flowed-through unflushable tumbles out of its tile and falls into the pond. */
  private spawnJunkDrop(e: FlowEvent): void {
    if (this.junkDrops.length > 40) return;
    const x = this.colX(e.coord.col) + CELL / 2;
    const y = Math.max(HUD_H, this.rowScreenY(e.coord.row) + CELL / 2);
    this.junkDrops.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 70,
      vy: 30 + Math.random() * 40,
      rot: 0,
      vr: (Math.random() - 0.5) * 9,
      icon: `junk-${e.junk}`,
      size: CELL * 0.5,
      floating: false,
    });
  }

  /** Spawn + integrate the falling sewage that spills from leaks into the pond. */
  private updateDrips(dtMs: number): void {
    const dt = dtMs / 1000;
    const pondTop = this.pondTop;
    const impactY = pondTop + 3; // splash at the pond's surface
    const frozen = this.model.frozen; // a freeze stops the leak: drips hang in mid-air
    if (!frozen) {
      const survivors: Drip[] = [];
      for (const d of this.drips) {
        d.vy += DRIP_GRAVITY * dt; // accelerate under gravity
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        if (d.y >= impactY) this.spawnSplash(d.x, impactY, d.vy);
        else survivors.push(d);
      }
      this.drips = survivors;
    }
    this.updateSplashes(dtMs, pondTop);

    // junk falls, then FLOATS on the pond surface (it doesn't vanish)
    const floatLine = pondTop + 14;
    for (const j of this.junkDrops) {
      if (j.floating) {
        j.x += j.vx * dt; // gentle drift on the surface
        if (j.x < 14 || j.x > GAME_WIDTH - 14) j.vx *= -1;
      } else {
        j.vy += DRIP_GRAVITY * 0.6 * dt; // a touch floatier than liquid
        j.x += j.vx * dt;
        j.y += j.vy * dt;
        j.rot += j.vr * dt;
        if (j.y >= floatLine) {
          j.floating = true; // landed — settle and bob
          j.y = floatLine;
          j.vx = (Math.random() - 0.5) * 22;
          if (this.model.state === "FLOWING" && this.clock - this.lastSploshAt > 750) {
            this.lastSploshAt = this.clock;
            this.sfxSplosh();
          }
        }
      }
    }
    // keep the pond from overflowing — drop the oldest floaters
    if (this.junkDrops.length > 16) this.junkDrops.splice(0, this.junkDrops.length - 16);

    if (this.model.leaking && !frozen) {
      this.dripTimer += dtMs;
      while (this.dripTimer >= DRIP_SPAWN_MS) {
        this.dripTimer -= DRIP_SPAWN_MS;
        for (const leak of this.model.leaks) {
          if (this.drips.length >= DRIP_MAX) break;
          const [ux, uy] = GameScene.ARROW_VEC[leak.out];
          // spawn at the pipe MOUTH (cell edge in the spill direction), not the cell centre
          const mx = this.colX(leak.from.col) + CELL / 2 + ux * CELL * 0.5;
          const my = this.rowScreenY(leak.from.row) + CELL / 2 + uy * CELL * 0.5;
          if (my < HUD_H - CELL) continue; // leak off the top of the view
          this.drips.push({
            x: mx + (Math.random() - 0.5) * CELL * 0.2,
            y: my,
            vx: ux * 70 + (Math.random() - 0.5) * 40, // shoots out the mouth, then gravity takes over
            vy: uy * 50 + 20 + Math.random() * 40,
            r: 3 + Math.random() * 2.5,
          });
        }
      }
    } else {
      this.dripTimer = 0;
    }
  }

  private updateCamera(deltaMs: number): void {
    // While the player is peeking (drag-to-scroll), leave the camera where they put
    // it; otherwise deadzone-follow the latest placement and drift back smoothly.
    if (this.clock >= this.manualScrollUntil) {
      const margin = FOLLOW_BOTTOM_MARGIN;
      const focusViewRow = this.model.buildRow - this.scrollPx / CELL;
      if (focusViewRow > this.visRows - margin) {
        this.scrollTargetPx = (this.model.buildRow - (this.visRows - margin)) * CELL;
      } else if (focusViewRow < margin) {
        this.scrollTargetPx = (this.model.buildRow - margin) * CELL;
      }
      this.scrollTargetPx = Math.max(0, this.scrollTargetPx);
      const k = Math.min(1, deltaMs / SCROLL_SMOOTH_MS);
      this.scrollPx += (this.scrollTargetPx - this.scrollPx) * k;
    }
  }

  // ---- sprite pool -----------------------------------------------------------

  private useSprite(
    key: string,
    x: number,
    y: number,
    size: number,
    depth: number,
    rot = 0,
    opts?: { flipX?: boolean; flipY?: boolean; tint?: number; alpha?: number },
  ): boolean {
    if (!this.textures.exists(key)) return false;
    let img = this.sprites[this.spriteIdx];
    if (!img) {
      img = this.add.image(0, 0, key);
      this.sprites[this.spriteIdx] = img;
    }
    this.spriteIdx++;
    img.setTexture(key).setPosition(x, y).setDepth(depth).setRotation(rot).setVisible(true);
    img.setFlipX(opts?.flipX ?? false).setFlipY(opts?.flipY ?? false);
    img.setAlpha(opts?.alpha ?? 1);
    if (opts?.tint !== undefined) img.setTint(opts.tint);
    else img.clearTint();
    // fit within a `size` box, preserving the texture's aspect ratio (so a portrait
    // toilet PNG isn't squashed into a square)
    const s = size / Math.max(img.width, img.height);
    img.setDisplaySize(img.width * s, img.height * s);
    return true;
  }

  // ---- main render -----------------------------------------------------------

  private render(): void {
    const w = this.gfxWorld;
    w.clear();
    this.spriteIdx = 0;
    this.labelIdx = 0;
    // board-reveal intro: 0 before START, ramps to 1 over INTRO_MS once the run begins
    this.intro = this.model.started ? Math.min(1, (this.clock - this.runBeganAt) / INTRO_MS) : 0;
    const revealed = this.model.started; // obstacles / terminal / queue / hints stay hidden pre-start

    const topRow = Math.max(0, Math.floor(this.scrollPx / CELL) - 1);
    const botRow = topRow + this.visRows + 2;

    const fatbergCells: Coord[] = []; // drawn last so their bulges aren't erased by lower rows
    for (let r = topRow; r <= botRow; r++) {
      const y = this.rowScreenY(r);
      const surface = r < SURFACE_ROWS;
      w.fillStyle(surface ? COLORS.grassBase : COLORS.soilBase, 1);
      w.fillRect(GRID_X, y, GAME_WIDTH - GRID_X, CELL); // ground spans the grid only (sidebar is left)
      this.drawGroundTexture(w, r, y, surface);
      for (let c = 0; c < CONFIG.cols; c++) {
        const x = this.colX(c);
        if ((r + c) % 2 === 0) {
          w.fillStyle(0xffffff, 0.008); // barely-there chequerboard placement guide
          w.fillRect(x, y, CELL, CELL);
        }
        const coord = { row: r, col: c };
        const cx = x + CELL / 2;
        const cy = y + CELL / 2;
        const cell = this.model.grid.get(coord);
        // The source (manhole) and the player's own pipes are always drawn. Everything seeded —
        // clogs, power markers, the fatberg, the destination — is part of the BOARD and stays
        // hidden until START, then spins/pops in (see the intro helpers).
        if (cell?.type === "fatberg") {
          if (revealed) fatbergCells.push(coord);
        } else if (cell?.type === "blocker") {
          if (revealed) this.drawClogIntro(w, cx, cy, cell, coord);
        } else if (cell?.type === "rock") {
          if (revealed) this.drawRock(w, cx, cy, coord);
        } else if (cell) {
          this.drawCell(w, cx, cy, cell, coord);
        } else {
          const marker = this.model.powerMarkerAt(coord);
          if (marker && revealed) this.drawPowerMarkerIntro(w, cx, cy, marker, coord);
        }
      }
    }
    const haveBergSprite = this.textures.exists("fatberg");
    for (const c of fatbergCells) {
      const isBerg = (dr: number, dc: number) =>
        this.model.grid.get({ row: c.row + dr, col: c.col + dc })?.type === "fatberg";
      const ci = this.cellIntro(c);
      if (ci <= 0) continue; // not yet revealed
      const sc = easeOutBack(ci); // scale-pop the boss in
      if (haveBergSprite) {
        if (isBerg(-1, 0) || isBerg(0, -1)) continue; // one sprite, drawn at the 2x2 anchor
        const ccx = this.colX(c.col) + CELL; // centre of the 2x2 block
        const ccy = this.rowScreenY(c.row) + CELL;
        w.fillStyle(0x000000, 0.16);
        w.fillEllipse(ccx, ccy + CELL * 0.85, CELL * 1.5 * sc, CELL * 0.3 * sc); // ground shadow
        this.useSprite("fatberg", ccx, ccy, CELL * 2.2 * sc, Z_GRID_SPRITE + 1);
      } else {
        this.drawFatbergCell(w, this.colX(c.col) + CELL / 2, this.rowScreenY(c.row) + CELL / 2, c);
      }
    }

    const over = this.model.state === "WON" || this.model.state === "GAMEOVER";
    if (!over) this.drawBuildHints(); // freeze the build arrows once the level's decided

    const ringStart = this.model.ringStart;
    const progress = this.model.fillProgress;
    // On a win the contained spill drains OUT of the pipes (hauled away) — the leading edge retreats
    // back toward the source over the settle. `drain` 0..1 is the win-settle progress.
    const drain = this.winDrainNow();
    const segs = this.model.filled;
    const keep = drain > 0 ? Math.ceil(segs.length * (1 - drain)) : segs.length;
    for (let i = 0; i < segs.length; i++) {
      if (drain > 0 && i >= keep) continue; // this length has drained away
      const seg = segs[i];
      if (seg.coord.row < topRow || seg.coord.row > botRow) continue;
      const cell = this.model.grid.get(seg.coord);
      if (!cell) continue;
      const cx = this.colX(seg.coord.col) + CELL / 2;
      const cy = this.rowScreenY(seg.coord.row) + CELL / 2;
      if (seg.at === ringStart && progress < 1) {
        // leading tile: poo grows along the centre-line, nose-first (drawn directly, no mask)
        this.drawSewageNose(w, cx, cy, cell.openings, seg.entry, progress, seg.coord);
      } else {
        this.drawSewageFill(w, cx, cy, cell.openings, seg.coord);
      }
    }

    if (!over) {
      this.drawLeak(w); // the spill gush + its red guide arrows freeze once the level's decided
      this.drawLeakArrows();
    }
    this.renderExplosions(w);

    const u = this.gfxUi;
    u.clear();
    this.gfxQueue.clear();
    this.renderFreeze(u); // icy tint over the grid while the flow is paused
    this.renderRain(u); // rain pour while a rain marker is active
    this.renderPond(u);
    this.renderHud();
    this.renderQueue(this.gfxQueue); // the next-pipe queue overlays the board (translucent layer)
    this.renderGauge(u); // the spill strip — full opacity so the RAG colours read clearly
    this.renderDrips(u); // falling spilled sewage, on top of everything
    this.renderJunkDrops();
    this.renderToast(u);
    this.renderBlitz(u); // lightning strikes zapping blitzed tiles in
    this.renderScorePops(); // rising "+N BONUS" stars
    this.renderFlash(u); // full-screen surge/win/lose flash
    this.renderBanner(); // big instruction flash (hidden behind the end/start cards)
    this.renderEndDialog(u); // modal card, drawn on top of everything
    this.renderStartOverlay(u); // pre-run Start screen (mutually exclusive with the end card)
    this.renderPauseOverlay(u); // PAUSED scrim (only mid-run; last so it sits on top)

    for (let i = this.spriteIdx; i < this.sprites.length; i++) this.sprites[i].setVisible(false);
    for (let i = this.labelIdx; i < this.labels.length; i++) this.labels[i].setVisible(false);
  }

  // ---- tiles -----------------------------------------------------------------

  private drawCell(g: G, cx: number, cy: number, cell: Cell, coord: Coord): void {
    if (cell.type === "fatberg") {
      this.drawFatbergCell(g, cx, cy, coord);
      return;
    }
    if (cell.type === "blocker") {
      // muck mound base so it reads as an impassable clog, not a floating sticker
      g.fillStyle(0x000000, 0.22);
      g.fillEllipse(cx, cy + CELL * 0.36, CELL * 0.62, CELL * 0.14); // ground shadow
      g.fillStyle(COLORS.clog, 1);
      g.fillCircle(cx, cy + CELL * 0.05, CELL * 0.38);
      g.fillCircle(cx - CELL * 0.22, cy + CELL * 0.18, CELL * 0.2);
      g.fillCircle(cx + CELL * 0.22, cy + CELL * 0.16, CELL * 0.19);
      const hd = `junk-${cell.junk}-hd`;
      const junkKey = this.textures.exists(hd) ? hd : `junk-${cell.junk}`; // PNG overrides SVG
      if (!this.useSprite(junkKey, cx, cy - CELL * 0.02, CELL * 0.56, Z_GRID_SPRITE)) {
        this.drawClogFallback(g, cx, cy, cell.junk);
      }
      return;
    }
    if (cell.type === "source") {
      // a big sewer-pipe mouth (concrete rim, dark bore) the sewage pours out of
      const r = CELL * 0.42;
      g.fillStyle(0x000000, 0.2);
      g.fillEllipse(cx, cy + CELL * 0.34, r * 1.4, r * 0.35); // ground shadow
      g.fillStyle(0x8b8f96, 1); // outer concrete rim
      g.fillCircle(cx, cy, r);
      g.fillStyle(0x6b7077, 1);
      g.fillCircle(cx, cy, r * 0.82);
      g.fillStyle(0x33373d, 1); // inner bore
      g.fillCircle(cx, cy, r * 0.66);
      g.fillStyle(0x14171b, 1);
      g.fillCircle(cx, cy, r * 0.5); // dark depth
      g.fillStyle(COLORS.sewage, 1); // sewage welling at the mouth
      g.fillCircle(cx, cy + r * 0.12, r * 0.4);
      return;
    }
    if (cell.type === "terminal") {
      // four inlet nubs (it accepts the sewage from any side)
      g.fillStyle(COLORS.pipe, 1);
      const t2 = CELL * 0.13;
      const arm = CELL * 0.2;
      g.fillRect(cx - t2 / 2, cy - CELL * 0.5, t2, arm); // N
      g.fillRect(cx - t2 / 2, cy + CELL * 0.3, t2, arm); // S
      g.fillRect(cx - CELL * 0.5, cy - t2 / 2, arm, t2); // W
      g.fillRect(cx + CELL * 0.3, cy - t2 / 2, arm, t2); // E
      // a plug-hole drain: metal rim, concentric rings, dark hole, cross bars
      g.fillStyle(0x2a2d33, 1);
      g.fillCircle(cx, cy, CELL * 0.4);
      g.lineStyle(3, 0xaeb6c0, 0.95);
      g.strokeCircle(cx, cy, CELL * 0.36);
      g.lineStyle(2, 0x7d858f, 0.9);
      g.strokeCircle(cx, cy, CELL * 0.28);
      g.fillStyle(0x05080c, 1);
      g.fillCircle(cx, cy, CELL * 0.22);
      g.lineStyle(3, 0x3a4048, 1);
      g.lineBetween(cx - CELL * 0.2, cy, cx + CELL * 0.2, cy);
      g.lineBetween(cx, cy - CELL * 0.2, cx, cy + CELL * 0.2);
      g.lineStyle(2, COLORS.hotspot, 0.55); // a hint of bright water swirling in
      g.strokeCircle(cx, cy, CELL * 0.15);
      return;
    }
    this.drawPipe(g, cx, cy, cell.openings, COLORS.pipe, 0.3, this.pipeGrow(coord));
    if (cell.power) {
      // armed-and-waiting: a power sits under this laid pipe (it clears once the flow fires it), so
      // flash/pulse it to tell the player a power is loaded and the flow's about to hit it.
      const bx = cx + CELL * 0.28;
      const by = cy - CELL * 0.28;
      const flash = 0.5 + 0.5 * Math.sin(this.clock / 130 + cx * 0.05);
      g.fillStyle(POWER_TINT[cell.power], 0.12 + 0.32 * flash); // pulsing glow ring
      g.fillCircle(bx, by, 11 + 9 * flash);
      this.drawPowerBadge(g, bx, by, cell.power, 13 + 2.5 * flash, Z_GRID_SPRITE + 1, 0.65 + 0.35 * flash);
    }
    const fuse = this.model.fuseAt(coord); // any piece can carry a lit fuse
    if (fuse !== undefined) this.drawDynamite(g, cx, cy, fuse);
  }

  /** Per-cell board-reveal progress (0 hidden -> 1 settled). Settles LEFT -> RIGHT with a little
   *  row jitter, so columns land at different times (not all in unison). The last column's spin
   *  finishes exactly at intro=1. 0 before START; 1 once the intro is done (steady state). */
  private cellIntro(coord: Coord): number {
    if (!this.model.started) return 0;
    if (this.intro >= 1) return 1;
    const cols = Math.max(1, CONFIG.cols - 1);
    const stagger = (coord.col / cols) * 0.5 + ((coord.row % 4) / 4) * 0.05; // ≤0.55 start delay
    return Math.max(0, Math.min(1, (this.intro - stagger) / 0.45)); // 0.55 + 0.45 = 1.0
  }

  /** Fruit-machine reel slots for a revealing tile: 1-2 symbols sliding UP and decelerating, the
   *  real one (i=0) landing dead-centre. Alpha-windowed at the cell edges so it needs no mask. */
  private reelSlots(ci: number): { i: number; dy: number; fade: number }[] {
    const eased = 1 - Math.pow(1 - ci, 3); // ease-out momentum
    const s = 9 * (1 - eased); // scroll distance in symbols, slowing to 0 (the target)
    const out: { i: number; dy: number; fade: number }[] = [];
    for (let i = Math.floor(s) - 1; i <= Math.floor(s) + 1; i++) {
      if (i < 0) continue;
      const dy = (s - i) * CELL; // i==0 -> centred as s->0
      const fade = Math.max(0, 1 - Math.abs(dy) / (CELL * 0.6));
      if (fade > 0.02) out.push({ i, dy, fade });
    }
    return out;
  }

  /** A clog revealing itself: the unflushable spins through the junk types like a fruit-machine
   *  reel (smooth vertical slide, decelerating) before settling on the one it'll actually be. */
  /** A faceted boulder — impassable, blow-up-able. Pops in on the board reveal. */
  private drawRock(g: G, cx: number, cy: number, coord: Coord): void {
    const ci = this.cellIntro(coord);
    if (ci <= 0) return; // not yet revealed
    const sc = easeOutBack(Math.min(1, ci));
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(cx, cy + CELL * 0.34, CELL * 0.5 * sc, CELL * 0.14 * sc); // ground shadow
    if (this.useSprite("rock", cx, cy - CELL * 0.04, CELL * 0.96 * sc, Z_GRID_SPRITE)) return;
    // fallback: a procedural grey boulder if the svg didn't load
    const r = CELL * 0.4 * sc;
    g.fillStyle(0x6b7078, 1);
    g.fillCircle(cx, cy, r); // boulder body
    g.fillStyle(0x565b62, 1);
    g.fillCircle(cx + r * 0.24, cy + r * 0.2, r * 0.68); // shaded lower-right
    g.fillStyle(0x888e97, 1);
    g.fillCircle(cx - r * 0.3, cy - r * 0.28, r * 0.4); // highlight upper-left
    g.lineStyle(2, 0x3c4046, 0.7); // facet cracks
    g.lineBetween(cx - r * 0.12, cy - r * 0.5, cx + r * 0.05, cy + r * 0.12);
    g.lineBetween(cx + r * 0.05, cy + r * 0.12, cx + r * 0.5, cy + r * 0.22);
    g.lineStyle(2.5, 0x2b2e33, 0.85);
    g.strokeCircle(cx, cy, r); // dark outline
  }

  private drawClogIntro(g: G, cx: number, cy: number, cell: Cell, coord: Coord): void {
    const ci = this.cellIntro(coord);
    if (ci <= 0) return; // not yet revealed
    if (ci >= 1) {
      this.drawCell(g, cx, cy, cell, coord); // settled — the real clog
      return;
    }
    // muck mound base (stationary "machine" frame)
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(cx, cy + CELL * 0.36, CELL * 0.62, CELL * 0.14);
    g.fillStyle(COLORS.clog, 1);
    g.fillCircle(cx, cy + CELL * 0.05, CELL * 0.38);
    g.fillCircle(cx - CELL * 0.22, cy + CELL * 0.18, CELL * 0.2);
    g.fillCircle(cx + CELL * 0.22, cy + CELL * 0.16, CELL * 0.19);
    // reel the junk glyph through the unflushables, landing on the real one
    for (const { i, dy, fade } of this.reelSlots(ci)) {
      const idx = ((i % JUNK_TYPES.length) + JUNK_TYPES.length) % JUNK_TYPES.length;
      const junk = i === 0 ? cell.junk : JUNK_TYPES[idx];
      const hd = `junk-${junk}-hd`;
      const key = this.textures.exists(hd) ? hd : `junk-${junk}`;
      this.useSprite(key, cx, cy + dy - CELL * 0.02, CELL * 0.56, Z_GRID_SPRITE, 0, { alpha: fade });
    }
  }

  /** A power marker revealing itself: the box settles into place while its glyph reels in, same
   *  fruit-machine motion as the clogs and the next-piece indicator. */
  private drawPowerMarkerIntro(
    g: G,
    cx: number,
    cy: number,
    marker: { power: PowerType; mag: number },
    coord: Coord,
  ): void {
    const ci = this.cellIntro(coord);
    if (ci <= 0) return;
    if (ci >= 1) {
      this.drawPowerMarker(g, cx, cy, marker.power, marker.mag);
      return;
    }
    const s = CELL * 0.34;
    const col = POWER_TINT[marker.power];
    const hasLabel = marker.power === "speed-up" || marker.power === "speed-down" || marker.power === "score";
    g.fillStyle(0x000000, 0.16);
    g.fillEllipse(cx, cy + CELL * 0.33, s * 1.7, s * 0.45); // shadow
    g.fillStyle(col, 0.22);
    g.fillRoundedRect(cx - s, cy - s, s * 2, s * 2, 8); // box (stationary frame)
    g.lineStyle(3, col, 0.95);
    g.strokeRoundedRect(cx - s, cy - s, s * 2, s * 2, 8);
    for (const { dy, fade } of this.reelSlots(ci)) {
      this.drawPowerBadge(g, cx, cy - (hasLabel ? s * 0.18 : 0) + dy, marker.power, s * 0.72, Z_GRID_SPRITE + 1, fade);
    }
  }

  /** 0..1 draw-in progress for a freshly placed pipe (1 = fully drawn). */
  private pipeGrow(coord: Coord): number {
    const key = `${coord.row},${coord.col}`;
    const placed = this.placedAnim.get(key);
    if (placed === undefined) return 1;
    const p = (this.clock - placed) / PLACE_ANIM_MS;
    if (p >= 1) {
      this.placedAnim.delete(key);
      return 1;
    }
    return 1 - Math.pow(1 - p, 3); // ease-out: arms shoot out from the centre
  }

  /** Blades of grass (swaying) on the surface; speckled dirt below. */
  private drawGroundTexture(g: G, r: number, y: number, surface: boolean): void {
    if (surface) {
      for (let i = 0; i < 26; i++) {
        const bx = GRID_X + hash3(r, i, 1) * (GAME_WIDTH - GRID_X);
        const h = 9 + hash3(r, i, 2) * 15;
        const baseY = y + CELL - 1;
        const sway = Math.sin(this.clock / 680 + bx * 0.045 + r) * (3 + h * 0.18);
        g.lineStyle(2, hash3(r, i, 3) > 0.5 ? COLORS.grassBlade : COLORS.grassBladeDark, 0.9);
        g.lineBetween(bx, baseY, bx + sway, baseY - h);
      }
    } else {
      for (let i = 0; i < 13; i++) {
        const dx = GRID_X + hash3(r, i, 1) * (GAME_WIDTH - GRID_X);
        const dy = y + hash3(r, i, 2) * CELL;
        const sz = 2 + hash3(r, i, 3) * 3.5;
        g.fillStyle(hash3(r, i, 4) > 0.5 ? COLORS.soilSpeckle : COLORS.soilSpeckleLight, 0.55);
        g.fillCircle(dx, dy, sz);
      }
    }
  }

  private drawClogFallback(g: G, cx: number, cy: number, junk?: JunkType): void {
    g.fillStyle(COLORS.clog, 1);
    g.fillCircle(cx, cy, CELL * 0.3);
    g.fillStyle(junk ? JUNK_TINT[junk] : 0x6b6258, 1);
    g.fillCircle(cx, cy, CELL * 0.13);
  }

  private drawPowerBadge(g: G, cx: number, cy: number, power: PowerType, r: number, depth: number, alpha = 1): void {
    // the faucet sits directly on the tile — no disc behind it
    const key = POWER_SPRITE[power];
    if (this.useSprite(key, cx, cy, r * 2.1, depth, 0, { alpha })) return;

    // Fallback only (if the sprite failed to load): a plain disc + glyph.
    g.fillStyle(0x0c0b0a, 1);
    g.fillCircle(cx, cy, r + 2);
    g.fillStyle(COLORS.speed, 1);
    g.fillCircle(cx, cy, r);
    g.fillStyle(0xffffff, 1);
    if (power === "speed-up") {
      g.fillCircle(cx, cy + r * 0.18, r * 0.5);
      g.fillRect(cx - r * 0.34, cy - r * 0.85, r * 0.2, r * 0.7);
      g.fillRect(cx + r * 0.14, cy - r * 0.85, r * 0.2, r * 0.7);
    } else if (power === "speed-down") {
      g.fillEllipse(cx - r * 0.1, cy, r * 1.25, r * 0.85);
      g.fillCircle(cx + r * 0.7, cy, r * 0.3);
    } else {
      g.fillCircle(cx, cy, r * 0.55); // coin / placard blob
    }
  }

  /** Kick off a dynamite blast: fireball + shockwave (tracked by row/col so it scrolls), a burst
   *  of ember + muck debris, rising smoke, and a camera shake for the punch. */
  private spawnBlast(row: number, col: number): void {
    this.explosions.push({ row, col, start: this.clock, seed: Math.random() * 6.28 });
    const x = this.colX(col) + CELL / 2;
    const y = this.rowScreenY(row) + CELL / 2;
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 130 + Math.random() * 380;
      const ember = i % 2 === 0;
      this.blastBits.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 110, // a touch of upward bias
        r: ember ? 2.5 + Math.random() * 4 : 5 + Math.random() * 7,
        color: ember ? (Math.random() < 0.5 ? 0xffd24a : 0xff7a1a) : 0x4a3016, // fire vs muck
        born: this.clock,
        life: 520 + Math.random() * 420,
      });
    }
    for (let i = 0; i < 8; i++) {
      this.smokePuffs.push({
        x: x + (Math.random() - 0.5) * CELL,
        y: y + (Math.random() - 0.5) * CELL * 0.5,
        vy: -28 - Math.random() * 46,
        r: CELL * 0.28 + Math.random() * CELL * 0.3,
        born: this.clock,
        life: 700 + Math.random() * 600,
        color: 0x35302b, // dark muck for the dynamite blast
      });
    }
    this.cameras.main.shake(320, 0.018);
  }

  /** A puff of smoke where a tile was re-laid — and the time penalty: placement is blocked
   *  for the duration of the smoke (the flow keeps running, so you lose that time). */
  private spawnSmoke(row: number, col: number): void {
    const x = this.colX(col) + CELL / 2;
    const y = this.rowScreenY(row) + CELL / 2;
    for (let i = 0; i < 8; i++) {
      this.smokePuffs.push({
        x: x + (Math.random() - 0.5) * CELL * 0.6,
        y: y + (Math.random() - 0.5) * CELL * 0.4,
        vy: -24 - Math.random() * 40,
        r: CELL * 0.2 + Math.random() * CELL * 0.24,
        born: this.clock,
        life: OVERWRITE_BUSY_MS * (0.85 + Math.random() * 0.3), // spans the block window
        color: 0xeef1f4, // white puff for a re-laid tile
      });
    }
    this.overwriteBusyUntil = this.clock + OVERWRITE_BUSY_MS; // block the next placement until it clears
    this.sfxJunk(); // a soft poof/squelch as the old pipe is torn out
  }

  private updateBlast(dtMs: number): void {
    const dt = dtMs / 1000;
    this.blastBits = this.blastBits.filter((b) => this.clock - b.born < b.life);
    for (const b of this.blastBits) {
      b.vy += 1100 * dt; // gravity
      b.vx *= 0.985;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    this.smokePuffs = this.smokePuffs.filter((s) => this.clock - s.born < s.life);
    for (const s of this.smokePuffs) {
      s.y += s.vy * dt;
      s.vy *= 0.97;
      s.r += 26 * dt;
    }
  }

  /** A soft turbulent fireball lobe: a core disc ringed by offset blobs so the edge churns. */
  private fireLobe(g: G, x: number, y: number, r: number, color: number, a: number, seed: number): void {
    if (a <= 0.02) return;
    g.fillStyle(color, a);
    g.fillCircle(x, y, r);
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2 + seed;
      const lr = r * (0.5 + 0.22 * Math.sin(seed * 2.3 + k));
      g.fillCircle(x + Math.cos(ang) * r * 0.72, y + Math.sin(ang) * r * 0.72, lr);
    }
  }

  private renderExplosions(g: G): void {
    // smoke sits behind the fireball
    for (const s of this.smokePuffs) {
      const t = (this.clock - s.born) / s.life;
      const a = Math.min(1, t * 4) * (1 - t) * 0.45; // fade in fast, drift out
      if (a <= 0.02) continue;
      g.fillStyle(s.color, a);
      g.fillCircle(s.x, s.y, s.r * (0.6 + t * 0.9));
    }

    this.explosions = this.explosions.filter((e) => this.clock - e.start < EXPLOSION_MS);
    for (const e of this.explosions) {
      const t = (this.clock - e.start) / EXPLOSION_MS; // 0..1
      const x = this.colX(e.col) + CELL / 2;
      const y = this.rowScreenY(e.row) + CELL / 2;
      // shockwave ring — fast, thinning, gone by mid-blast
      if (t < 0.6) {
        const sw = CELL * (0.4 + t * 3);
        g.lineStyle(7 * (1 - t / 0.6), 0xffe7a0, (1 - t / 0.6) * 0.85);
        g.strokeCircle(x, y, sw);
      }
      // fireball — outer orange, mid yellow, white-hot core; expands then fades
      const fr = CELL * (0.5 + Math.min(1, t * 2.4) * 1.25);
      const fa = 1 - Math.min(1, t * 1.25);
      this.fireLobe(g, x, y, fr, 0xff6a16, 0.72 * fa, e.seed);
      this.fireLobe(g, x, y, fr * 0.66, 0xffd24a, 0.9 * fa, e.seed + 2.1);
      const ca = 1 - Math.min(1, t * 2.2);
      if (ca > 0.02) {
        g.fillStyle(0xfff6e0, 0.95 * ca);
        g.fillCircle(x, y, fr * 0.42);
      }
    }

    // embers + muck chunks on top
    for (const b of this.blastBits) {
      const t = (this.clock - b.born) / b.life;
      const a = 1 - t;
      if (a <= 0.02) continue;
      g.fillStyle(b.color, a);
      g.fillCircle(b.x, b.y, b.r * (1 - t * 0.35));
    }
  }

  /** One quadrant of a fatberg: bulges on its OUTER edges, merges flush on the inner
   *  seams, and is lit across the whole 2x2 (top-left bright -> bottom-right dark). */
  private drawFatbergCell(g: G, cx: number, cy: number, coord: Coord): void {
    const half = CELL / 2;
    const F = (dr: number, dc: number) =>
      this.model.grid.get({ row: coord.row + dr, col: coord.col + dc })?.type === "fatberg";
    const n = F(-1, 0);
    const s = F(1, 0);
    const w = F(0, -1);
    const e = F(0, 1);
    const ext = CELL * 0.07; // how far it bulges past an outer edge
    const x0 = cx - half - (w ? 0.5 : ext);
    const x1 = cx + half + (e ? 0.5 : ext);
    const y0 = cy - half - (n ? 0.5 : ext);
    const y1 = cy + half + (s ? 0.5 : ext);
    const r = CELL * 0.46;
    // greasy tan-grey, a touch darker toward the bottom-right of the whole mass
    const base = shade(0xc9bd9c, 1 - 0.06 * ((n ? 1 : 0) + (w ? 1 : 0)));
    const light = shade(base, 1.22);
    const dark = shade(base, 0.74);

    if (!s) {
      g.fillStyle(0x000000, 0.16);
      g.fillEllipse(cx, y1 - 1, CELL * 0.78, CELL * 0.16); // ground shadow on the bottom edge
    }
    // body: rounded only on OUTER corners, square on the inner seams so the 2x2 fuses
    g.fillStyle(base, 1);
    g.fillRoundedRect(x0, y0, x1 - x0, y1 - y0, {
      tl: !n && !w ? r : 0,
      tr: !n && !e ? r : 0,
      bl: !s && !w ? r : 0,
      br: !s && !e ? r : 0,
    });
    // knobbly bulges along the outer edges (deterministic, so they don't shimmer)
    const lump = (lx: number, ly: number, lr: number, col: number) => {
      g.fillStyle(col, 1);
      g.fillCircle(lx, ly, lr);
    };
    const h = (k: number) => hash3(coord.row, coord.col, k);
    if (!n) {
      lump(cx - CELL * 0.18, y0 + ext, CELL * (0.18 + h(1) * 0.06), base);
      lump(cx + CELL * 0.2, y0 + ext, CELL * (0.15 + h(2) * 0.06), base);
    }
    if (!s) {
      lump(cx - CELL * 0.2, y1 - ext, CELL * (0.18 + h(3) * 0.06), base);
      lump(cx + CELL * 0.18, y1 - ext, CELL * (0.2 + h(4) * 0.06), base);
    }
    if (!w) {
      lump(x0 + ext, cy - CELL * 0.12, CELL * (0.17 + h(5) * 0.06), base);
      lump(x0 + ext, cy + CELL * 0.2, CELL * (0.16 + h(6) * 0.06), base);
    }
    if (!e) {
      lump(x1 - ext, cy - CELL * 0.2, CELL * (0.18 + h(7) * 0.06), base);
      lump(x1 - ext, cy + CELL * 0.14, CELL * (0.18 + h(8) * 0.06), base);
    }
    // shading: bright rim on the N/W (lit) edges, shadow on the S/E edges.
    // Inset away from rounded corners so the band never paints onto the background.
    const band = CELL * 0.15;
    if (!n) {
      const a = x0 + (!w ? r : 0);
      const b = x1 - (!e ? r : 0);
      g.fillStyle(light, 0.5);
      g.fillRect(a, y0, b - a, band);
    }
    if (!w) {
      const a = y0 + (!n ? r : 0);
      const b = y1 - (!s ? r : 0);
      g.fillStyle(light, 0.45);
      g.fillRect(x0, a, band, b - a);
    }
    if (!s) {
      const a = x0 + (!w ? r : 0);
      const b = x1 - (!e ? r : 0);
      g.fillStyle(dark, 0.5);
      g.fillRect(a, y1 - band, b - a, band);
    }
    if (!e) {
      const a = y0 + (!n ? r : 0);
      const b = y1 - (!s ? r : 0);
      g.fillStyle(dark, 0.45);
      g.fillRect(x1 - band, a, band, b - a);
    }
    if (!n && !w) {
      g.fillStyle(0xffffff, 0.13); // glossy top-left highlight
      g.fillEllipse(cx - CELL * 0.12, cy - CELL * 0.14, CELL * 0.42, CELL * 0.24);
    }
    // embedded gunk: dark grime, a couple of pale wet-wipe smears, a yellow fat globule
    g.fillStyle(0x8d8468, 1);
    for (let i = 0; i < 5; i++) {
      g.fillCircle(cx + (h(i + 10) - 0.5) * CELL * 0.7, cy + (h(i + 20) - 0.5) * CELL * 0.7, 2 + h(i + 30) * 1.5);
    }
    g.fillStyle(0xe9e6da, 0.8);
    g.fillEllipse(cx + (h(40) - 0.5) * CELL * 0.5, cy + (h(41) - 0.5) * CELL * 0.5, CELL * 0.18, CELL * 0.08);
    g.fillStyle(0xd8b24a, 0.7);
    g.fillCircle(cx + (h(42) - 0.5) * CELL * 0.5, cy + (h(43) - 0.5) * CELL * 0.5, CELL * 0.08);
  }

  /** A stick of dynamite with a burning fuse that shrinks as it counts down. */
  private drawDynamite(g: G, cx: number, cy: number, fuse: number): void {
    const frac = Math.max(0, Math.min(1, fuse / CONFIG.dynamiteFuseMs));
    g.fillStyle(0xc0392b, 1); // red stick
    g.fillRoundedRect(cx - CELL * 0.11, cy - CELL * 0.2, CELL * 0.22, CELL * 0.4, 4);
    g.fillStyle(0x000000, 0.18);
    g.fillRect(cx - CELL * 0.11, cy - CELL * 0.02, CELL * 0.22, CELL * 0.05); // band
    g.fillStyle(0xe8c07a, 1);
    g.fillRect(cx - CELL * 0.05, cy - CELL * 0.12, CELL * 0.1, CELL * 0.08); // label
    // fuse burns down toward the stick
    const topX = cx;
    const topY = cy - CELL * 0.2;
    const ex = topX + CELL * 0.12 * frac;
    const ey = topY - CELL * 0.16 * frac;
    g.lineStyle(2, 0x3a3a3a, 1);
    g.lineBetween(topX, topY, ex, ey);
    const s = 2.5 + Math.abs(Math.sin(this.clock / 55)) * 3; // flickering spark
    g.fillStyle(0xffd24a, 1);
    g.fillCircle(ex, ey, s);
    g.fillStyle(0xff7a1a, 0.85);
    g.fillCircle(ex, ey, s * 0.55);
  }

  /** Hub + arms. Arms keep square ends (connections stay flush); only the exposed
   *  hub corners — those with no arm on either side — are rounded, for curved elbows. */
  private pipeShape(g: G, cx: number, cy: number, openings: number, t: number, half: number): void {
    const n = openings & Side.N;
    const s = openings & Side.S;
    const w = openings & Side.W;
    const e = openings & Side.E;
    if (n) g.fillRect(cx - t / 2, cy - half, t, half);
    if (s) g.fillRect(cx - t / 2, cy, t, half);
    if (w) g.fillRect(cx - half, cy - t / 2, half, t);
    if (e) g.fillRect(cx, cy - t / 2, half, t);
    const r = t * 0.5;
    g.fillRoundedRect(cx - t / 2, cy - t / 2, t, t, {
      tl: !n && !w ? r : 0,
      tr: !n && !e ? r : 0,
      bl: !s && !w ? r : 0,
      br: !s && !e ? r : 0,
    });
  }

  /** A shaded tube: drop shadow, body, then a smooth many-step cylinder gradient
   *  across the tube width (so it reads as a rounded 16-bit tube, not a flat slab). */
  private drawPipe(g: G, cx: number, cy: number, openings: number, color: number, widthFrac: number, grow = 1): void {
    const half = (CELL / 2) * grow; // arms shoot out from the centre when drawing in
    const t = CELL * widthFrac;
    const n = openings & Side.N;
    const s = openings & Side.S;
    const w = openings & Side.W;
    const e = openings & Side.E;

    // drop shadow, offset down-right so the pipe sits proud of the soil
    g.fillStyle(0x000000, 0.13);
    this.pipeShape(g, cx + 2, cy + 3, openings, t, half);
    // base body (also fills the rounded ends/elbows the gradient strips won't reach)
    g.fillStyle(color, 1);
    this.pipeShape(g, cx, cy, openings, t, half);

    // slim cylinder shading on the edges only (keeps the rounded corners neat):
    // a crisp lit rim + a soft falloff on the top/left, a dark rim on the bottom/right
    const light = shade(color, 1.55);
    const dark = shade(color, 0.5);
    const b1 = t * 0.12;
    const b2 = t * 0.16;
    const rim = (alpha: number, col: number, off: number, bw: number) => {
      g.fillStyle(col, alpha);
      if (n) g.fillRect(cx - t / 2 + off, cy - half, bw, half);
      if (s) g.fillRect(cx - t / 2 + off, cy, bw, half);
      if (w) g.fillRect(cx - half, cy - t / 2 + off, half, bw);
      if (e) g.fillRect(cx, cy - t / 2 + off, half, bw);
    };
    rim(0.7, light, 0, b1); // bright lit edge
    rim(0.3, light, b1, b2); // soft falloff just inside it
    rim(0.5, dark, t - b1, b1); // dark far edge
  }

  /** The poo inside a filled pipe: varied yellow/brown, with specks that drift
   *  steadily DOWN/RIGHT along the pipe (a continuous flow, not a back-and-forth jump). */
  /** While a freeze is active, shift a poo colour toward icy greeny-blue (reverts on thaw). */
  private chill(color: number): number {
    return this.model.frozen ? lerpColor(color, FROZEN_TINT, 0.6) : color;
  }

  private drawSewageFill(g: G, cx: number, cy: number, openings: number, coord: { row: number; col: number }): void {
    const t = CELL * 0.22;
    const half = CELL / 2;
    const seed = hash3(coord.row, coord.col, 2);
    const base = this.chill(lerpColor(SEWAGE_YELLOW, SEWAGE_BROWN, 0.4 + seed * 0.25)); // per-segment variance
    const dark = shade(base, 0.72);
    const lite = shade(base, 1.18);

    g.fillStyle(base, 1);
    this.pipeShape(g, cx, cy, openings, t, half);

    const n = openings & Side.N;
    const s = openings & Side.S;
    const w = openings & Side.W;
    const e = openings & Side.E;
    // WORLD-anchored specks so the poo flows as one continuous stream across cells.
    // (the old per-cell random phase made every tile animate on its own — the "jump".)
    // Channels stop at the hub centre on a CLOSED side (not the rounded-off stub at ±t/2),
    // so a bend's specks turn the corner instead of poking past the rounded pipe edge.
    if (n || s) this.flowSpecks(g, true, cx, n ? cy - half : cy, s ? cy + half : cy, t, dark, lite);
    if (w || e) this.flowSpecks(g, false, cy, w ? cx - half : cx, e ? cx + half : cx, t, dark, lite);
    g.fillStyle(dark, 0.28); // subtle dark core
    g.fillCircle(cx, cy, t * 0.34);
  }

  /** Specks drifting down a vertical channel (or right along a horizontal one), anchored
   *  to WORLD coordinates so adjacent tiles line up into one continuous flowing stream. */
  private flowSpecks(g: G, vertical: boolean, fixed: number, lo: number, hi: number, t: number, dark: number, lite: number): void {
    if (hi - lo < 3) return;
    const SPACING = CELL * 0.42;
    const r = t * 0.24; // speck radius
    const laneMax = t * 0.14; // perpendicular jitter — kept well inside the pipe wall (r+lane < t/2)
    // MONOTONIC flow offset — no modulo. A speck's identity is its integer index k, so its
    // lane and colour never re-shuffle (the old `% SPACING` wrap re-indexed every speck each
    // cycle, which read as the whole stream "resetting" and jumping toward the rim). The phase
    // accumulates at the real sewage speed, so the texture moves in lockstep with the front.
    // No end-fade: each speck belongs to exactly one tile and spills its radius into the neighbour
    // (hidden by the neighbour's poo), so the stream stays continuous across a seam. Fading at the
    // seam instead DIMMED every speck as it crossed — a per-tile-boundary stutter. The leading
    // tile's front is clipped by the reveal mask, not by a fade, so nothing pops there either.
    const flow = this.flowPhase;
    const wLo = vertical ? lo - HUD_H + this.scrollPx : lo; // vertical scrolls with the camera; horizontal doesn't
    const wHi = vertical ? hi - HUD_H + this.scrollPx : hi;
    const kStart = Math.ceil((wLo - flow) / SPACING);
    const kEnd = Math.floor((wHi - flow) / SPACING);
    for (let k = kStart; k <= kEnd; k++) {
      const world = k * SPACING + flow;
      const pos = vertical ? world - this.scrollPx + HUD_H : world;
      const lane = ((((k % 3) + 3) % 3) - 1) * laneMax;
      g.fillStyle(k % 2 === 0 ? lite : dark, 0.5);
      if (vertical) g.fillCircle(fixed + lane, pos, r);
      else g.fillCircle(pos, fixed + lane, r);
    }
  }

  /** The leading (filling) tile's poo, drawn DIRECTLY (no geometry mask — which didn't reliably
   *  clip on software WebGL, leaving the whole tile showing as a hard edge that just sat there a
   *  whole slow tick). The poo is a fat round-capped stroke swept along the pipe's centre-PATH
   *  (entry edge -> hub -> exit) up to arc-length CELL*p. Centred + round-joined, it fills a
   *  bend's elbow symmetrically, rounds the advancing nose, and grows smoothly with p. */
  private drawSewageNose(
    g: G,
    cx: number,
    cy: number,
    openings: number,
    entry: Side | null,
    p: number,
    coord: { row: number; col: number },
  ): void {
    const half = CELL / 2;
    const t = CELL * 0.22; // match a settled tile's poo width
    const seed = hash3(coord.row, coord.col, 2);
    const base = this.chill(lerpColor(SEWAGE_YELLOW, SEWAGE_BROWN, 0.4 + seed * 0.25));
    const R = t / 2; // stroke radius -> a t-wide round-capped line, same width as the settled poo
    const STEP = CELL * 0.05; // heavy overlap -> a clean fat line
    const dir = (s: Side): [number, number] =>
      s === Side.N ? [0, -1] : s === Side.S ? [0, 1] : s === Side.W ? [-1, 0] : [1, 0];
    const stroke = (sx: number, sy: number, dx: number, dy: number, len: number): void => {
      for (let s = 0; s < len; s += STEP) g.fillCircle(sx + dx * s, sy + dy * s, R);
      g.fillCircle(sx + dx * len, sy + dy * len, R); // exact endpoint (the round nose)
    };
    g.fillStyle(base, 1);
    const exits = sidesOf(openings).filter((s) => s !== entry) as Side[];
    let hubWet = entry === null;
    if (entry === null) {
      for (const ex of exits) {
        const [dx, dy] = dir(ex);
        stroke(cx, cy, dx, dy, half * p);
      }
    } else {
      const [ex, ey] = dir(entry); // hub -> entry edge
      const d = CELL * p; // arc length from the entry edge (half in to the hub, half out to an exit)
      stroke(cx + ex * half, cy + ey * half, -ex, -ey, Math.min(d, half)); // entry edge -> hub
      if (d > half) {
        hubWet = true;
        const out = Math.min(d - half, half);
        for (const exit of exits) {
          const [dx, dy] = dir(exit);
          stroke(cx, cy, dx, dy, out); // hub -> exit
        }
      }
    }
    if (hubWet) {
      g.fillStyle(shade(base, 0.72), 0.28); // textured core, matches a settled tile's hub
      g.fillCircle(cx, cy, t * 0.34);
    }
  }

  /** Sewage actually pouring OUT of a leaking pipe's open mouth — a poo-coloured stream that
   *  wells at the end and arcs down under gravity (the falling drips below carry it to the pond). */
  private drawLeak(g: G): void {
    const frozen = this.model.frozen; // a freeze stops the leak gushing — it ices over at the mouth
    const stream = lerpColor(SEWAGE_YELLOW, SEWAGE_BROWN, 0.55);
    for (const leak of this.model.leaks) {
      const cx = this.colX(leak.from.col) + CELL / 2;
      const cy = this.rowScreenY(leak.from.row) + CELL / 2;
      if (cy < HUD_H - CELL) continue; // leak off the top of the view
      const [ux, uy] = GameScene.ARROW_VEC[leak.out];
      const ex = cx + ux * CELL * 0.5; // the open mouth sits on the cell edge
      const ey = cy + uy * CELL * 0.5;
      if (frozen) {
        // frozen solid: a static icy lump at the mouth, no gush
        g.fillStyle(FROZEN_TINT, 0.95);
        g.fillCircle(ex, ey, CELL * 0.15);
        g.fillStyle(0xffffff, 0.45);
        g.fillCircle(ex - CELL * 0.04, ey - CELL * 0.04, CELL * 0.05);
        continue;
      }
      // a continuous gout of poo, recycled along its arc via the (monotonic) flow phase
      const N = 8;
      for (let k = 0; k < N; k++) {
        const t = (this.flowPhase / (CELL * 0.7) + k / N) % 1; // 0..1 along the spill
        const sx = ex + ux * t * CELL * 0.55;
        const sy = ey + uy * t * CELL * 0.4 + t * t * CELL * 0.85; // gravity bends the stream down
        g.fillStyle(stream, 0.92 - t * 0.35);
        g.fillCircle(sx, sy, CELL * 0.12 * (1 - t * 0.35));
      }
      g.fillStyle(SEWAGE_BROWN, 1); // a fat lip welling right at the mouth
      g.fillCircle(ex, ey, CELL * 0.12);
    }
  }

  /** Always-on, subtle white "lay the next piece here" hints on the build frontier
   *  (including the very first cell under the toilet). Cells that are actively
   *  leaking are skipped — those get the loud gold markers instead. */
  // the hint SVG points NORTH; rotate it to face the pipe's extend/spill direction
  private static readonly ARROW_ROT: Record<number, number> = {
    [Side.N]: 0,
    [Side.E]: Math.PI / 2,
    [Side.S]: Math.PI,
    [Side.W]: -Math.PI / 2,
  };
  private static readonly ARROW_VEC: Record<number, [number, number]> = {
    [Side.N]: [0, -1],
    [Side.S]: [0, 1],
    [Side.E]: [1, 0],
    [Side.W]: [-1, 0],
  };

  /** Three chevrons marching off a cell centre in `dir` (fading), like the plughole rings.
   *  `speed` scales the march cadence; `tint` recolours them (red for leaks). */
  private marchArrows(cx: number, cy: number, dir: Side, speed = 850, tint?: number): void {
    const rot = GameScene.ARROW_ROT[dir];
    const [vx, vy] = GameScene.ARROW_VEC[dir];
    for (let k = 0; k < 3; k++) {
      const phase = (this.clock / speed + k / 3) % 1;
      const a = Math.sin(phase * Math.PI) * 0.9; // fade IN at the back, out at the front
      if (a <= 0.03) continue;
      const off = (phase - 0.5) * CELL * 0.6; // marches along the direction
      // high z-order so the hint sits on top of clogs / fatbergs in the way
      this.useSprite("hint", cx + vx * off, cy + vy * off, CELL * 0.4, Z_UI_SPRITE + 2, rot, { alpha: a, tint });
    }
  }

  private drawBuildHints(): void {
    if (this.intro < 0.85) return; // position indicators come up last, once the board has revealed
    const leakSet = new Set(this.model.leakTargets.map((c) => `${c.row},${c.col}`));
    const onScreen = (y: number) => y >= HUD_H - CELL && y <= this.pondTop;
    for (const { cell: t, dir } of this.model.buildFrontier) {
      if (leakSet.has(`${t.row},${t.col}`)) continue;
      const y = this.rowScreenY(t.row);
      if (!onScreen(y)) continue;
      this.marchArrows(this.colX(t.col) + CELL / 2, y + CELL / 2, dir);
    }
  }

  /** Leak fix-here cue: the SAME marching chevrons as the build hints, but RED, on the empty
   *  cell that caps the spill, pointing the way the sewage is escaping. Driven straight off the
   *  live model, so the moment the leak is capped the arrows vanish (no lingering marker). */
  private drawLeakArrows(): void {
    const onScreen = (y: number) => y >= HUD_H - CELL && y <= this.pondTop;
    for (const { cell, dir } of this.model.leakHints) {
      const y = this.rowScreenY(cell.row);
      if (!onScreen(y)) continue;
      this.marchArrows(this.colX(cell.col) + CELL / 2, y + CELL / 2, dir, 520, COLORS.dividend);
    }
  }

  /**
   * A Mario-Kart-style item box on the ground — bobbing, glinting, colour-coded
   * (green = build through it, red = avoid) with the power icon floating inside.
   */
  private drawPowerMarker(g: G, cx: number, cy: number, power: PowerType, mag = 1): void {
    const col = POWER_TINT[power]; // good = friendly, poison = red warning
    const phase = cx * 0.05;
    const bob = Math.sin(this.clock / 320 + phase) * 5;
    const py = cy + bob;
    const s = CELL * 0.34; // half-size

    g.fillStyle(0x000000, 0.16);
    g.fillEllipse(cx, cy + CELL * 0.33, s * 1.7, s * 0.45); // ground shadow

    g.fillStyle(col, 0.22);
    g.fillRoundedRect(cx - s, py - s, s * 2, s * 2, 8); // translucent box...
    g.lineStyle(3, col, 0.95);
    g.strokeRoundedRect(cx - s, py - s, s * 2, s * 2, 8); // ...bright frame

    // the 2x/3x/4x magnitude only means something for the multiplier powers
    const hasLabel = power === "speed-up" || power === "speed-down" || power === "score";
    // the icon pulses so it draws the eye; nudge it up only when a label sits below it (else centre)
    const pulse = 1 + 0.12 * Math.sin(this.clock / 200);
    this.drawPowerBadge(g, cx, py - (hasLabel ? s * 0.18 : 0), power, s * 0.72 * pulse, Z_GRID_SPRITE + 1);
    if (hasLabel) this.useLabel(`${mag}x`, cx, py + s * 0.62, Z_GRID_SPRITE + 2, 13);
  }

  /** A pooled text label positioned at a world point (e.g. a faucet's 2x/3x/4x tag). */
  private useLabel(
    text: string,
    x: number,
    y: number,
    depth: number,
    fontPx: number,
    opts?: { alpha?: number; color?: string },
  ): void {
    let t = this.labels[this.labelIdx];
    if (!t) {
      t = this.add
        .text(0, 0, "", { fontFamily: ARCADE_FONT, color: "#ffffff", stroke: "#06101a", strokeThickness: 4 })
        .setOrigin(0.5);
      this.labels[this.labelIdx] = t;
    }
    this.labelIdx++;
    t.setText(text)
      .setFontSize(fontPx)
      .setPosition(x, y)
      .setDepth(depth)
      .setAlpha(opts?.alpha ?? 1)
      .setColor(opts?.color ?? "#ffffff")
      .setVisible(true);
  }

  /** Flashing "build here" prompt under the toilet at the very start. */
  /** A subtle iridescent item box: rainbow frame + faint twinkle, no movement. */
  private drawItemBox(g: G, cx: number, cy: number, size: number, hue: number): void {
    const half = size / 2;
    const edge = Phaser.Display.Color.HSVToRGB((hue + 0.08) % 1, 0.7, 1).color;
    const shade = Phaser.Display.Color.HSVToRGB((hue + 0.5) % 1, 0.55, 0.6).color;

    g.fillStyle(0x12100e, 0.82); // dark panel so the pipe reads
    g.fillRoundedRect(cx - half, cy - half, size, size, 14);
    g.lineStyle(4, edge, 0.95); // bright iridescent frame
    g.strokeRoundedRect(cx - half, cy - half, size, size, 14);
    g.lineStyle(3, shade, 0.5); // bottom-right shadow edge for a little depth
    g.lineBetween(cx - half + 12, cy + half, cx + half, cy + half);
    g.lineBetween(cx + half, cy - half + 12, cx + half, cy + half);
    g.fillStyle(0xffffff, 0.1); // top sheen
    g.fillRoundedRect(cx - half + 8, cy - half + 8, size - 16, size * 0.24, 8);

    const tw = 0.35 + 0.65 * Math.abs(Math.sin(this.clock / 240)); // twinkle in place
    this.drawSparkle(g, cx + half - 13, cy - half + 13, 6, tw);
  }

  private drawSparkle(g: G, x: number, y: number, r: number, a: number): void {
    g.fillStyle(0xffffff, a);
    const w = r * 0.26;
    g.fillTriangle(x, y - r, x - w, y, x + w, y);
    g.fillTriangle(x, y + r, x - w, y, x + w, y);
    g.fillTriangle(x - r, y, x, y - w, x, y + w);
    g.fillTriangle(x + r, y, x, y - w, x, y + w);
  }

  /** The dedicated vertical LEFT SIDEBAR: the current piece at the top, upcoming stacked below
   *  (Tetris-style), sliding up into the active slot as you place. The gauge sits at the bottom. */
  private renderQueue(g: G): void {
    const m = this.model;
    // No solid panel — the queue tiles float over the board (the whole layer is at 70% alpha)
    // so column 0 stays fully visible underneath.
    const bandBot = this.pondTop;

    if (m.state === "WON" || m.state === "GAMEOVER" || !m.started) return;
    const front = m.currentPiece;
    if (front !== this.prevFront) {
      this.slideOff = this.prevFront; // remember the piece leaving so it slides off the top
      this.prevFront = front;
      this.rouletteStart = this.clock; // slide start
    }
    if (!front) return;

    const tile = 56;
    const step = tile + 8;
    const topY = HUD_H + 48; // top of the queue stack, clear of the HUD band
    const n = m.queue.length; // constant (the model refills the queue to a fixed length)

    // Smart reposition: if an open end (where the next piece goes) sits under the queue's column,
    // glide the whole stack to the right edge so the player can see the cell they're building into.
    const queueTopY = topY - step;
    const queueBotY = topY + (n - 1) * step + tile / 2;
    const obscuring = m.buildFrontier.some(
      (f) =>
        f.cell.col === CONFIG.hudCol &&
        this.rowScreenY(f.cell.row) + CELL > queueTopY &&
        this.rowScreenY(f.cell.row) < queueBotY,
    );
    this.queueShiftT += ((obscuring ? 1 : 0) - this.queueShiftT) * 0.1; // smooth glide
    const cx = Phaser.Math.Linear(QUEUE_W / 2, GAME_WIDTH - QUEUE_W / 2, this.queueShiftT);
    const e = Math.min(1, (this.clock - this.rouletteStart) / 170);
    const ee = 1 - Math.pow(1 - e, 3); // ease-out

    // the active slot highlight sits at the BOTTOM of the stack — that's the current piece
    this.drawItemBox(g, cx, topY + (n - 1) * step, tile + 8, 0.13);

    const drawTile = (py: number, qp: QueuePiece) => {
      if (py < topY - step || py > bandBot - tile / 2) return; // off the top / behind the gauge
      // a soft dark chip so each floating tile reads against the board behind it
      g.fillStyle(0x0c0b0a, 0.85);
      g.fillRoundedRect(cx - tile / 2, py - tile / 2, tile, tile, 10);
      this.drawPipeGlyph(g, cx, py, PIECE_OPENINGS[qp.type], tile * 0.78);
      if (qp.dynamite) this.drawDynamiteBadge(g, cx, py, tile * 0.78);
    };

    // newest piece sits at the TOP and the current piece (queue[0]) is furthest down;
    // on each placement the stack slides down a slot and a new tile drops in from the top
    for (let i = 0; i < n; i++) {
      const qp = m.queue[i];
      if (!qp) break;
      drawTile(topY + (n - 2 - i + ee) * step, qp);
    }
    if (this.slideOff && ee < 1) drawTile(topY + (n - 1 + ee) * step, this.slideOff); // sliding down out
  }

  /** A dynamite stick + spark overlaid on the next-piece box so a bomb reads as a bomb. */
  private drawDynamiteBadge(g: G, cx: number, cy: number, u: number): void {
    g.fillStyle(0xc0392b, 1);
    g.fillRoundedRect(cx - u * 0.12, cy - u * 0.22, u * 0.24, u * 0.44, 4);
    g.fillStyle(0x000000, 0.18);
    g.fillRect(cx - u * 0.12, cy - u * 0.02, u * 0.24, u * 0.05);
    g.fillStyle(0xe8c07a, 1);
    g.fillRect(cx - u * 0.06, cy - u * 0.13, u * 0.12, u * 0.09);
    const ex = cx + u * 0.15;
    const ey = cy - u * 0.32;
    g.lineStyle(2, 0x3a3a3a, 1);
    g.lineBetween(cx, cy - u * 0.22, ex, ey);
    const s = 2.5 + Math.abs(Math.sin(this.clock / 55)) * 3;
    g.fillStyle(0xffd24a, 1);
    g.fillCircle(ex, ey, s);
    g.fillStyle(0xff7a1a, 0.85);
    g.fillCircle(ex, ey, s * 0.55);
  }

  /** A mini version of the real pipe (rounded shape + edge shading) for the next box. */
  private drawPipeGlyph(g: G, cx: number, cy: number, openings: number, box: number, color: number = COLORS.pipe): void {
    const half = box / 2;
    const t = box * 0.34;
    const n = openings & Side.N;
    const s = openings & Side.S;
    const w = openings & Side.W;
    const e = openings & Side.E;
    // centre the piece's bounding box so a bend (mass in one corner) sits in the middle
    const hx = t / 2;
    cx += ((w ? half : hx) - (e ? half : hx)) / 2;
    cy += ((n ? half : hx) - (s ? half : hx)) / 2;
    g.fillStyle(0x000000, 0.22); // drop shadow
    this.pipeShape(g, cx + 1.5, cy + 2, openings, t, half);
    g.fillStyle(color, 1); // body
    this.pipeShape(g, cx, cy, openings, t, half);
    const light = shade(color, 1.55);
    const dark = shade(color, 0.5);
    const b1 = t * 0.12;
    const b2 = t * 0.16;
    const rim = (alpha: number, col: number, off: number, bw: number) => {
      g.fillStyle(col, alpha);
      if (n) g.fillRect(cx - t / 2 + off, cy - half, bw, half);
      if (s) g.fillRect(cx - t / 2 + off, cy, bw, half);
      if (w) g.fillRect(cx - half, cy - t / 2 + off, half, bw);
      if (e) g.fillRect(cx, cy - t / 2 + off, half, bw);
    };
    rim(0.7, light, 0, b1);
    rim(0.3, light, b1, b2);
    rim(0.5, dark, t - b1, b1);
  }

  private queueBanner(lines: string[], hold: number): void {
    this.bannerQueue.push({ lines, hold });
  }

  /** Zap each blitzed tile in: cascade a lightning strike, and pop in any that became pipe. */
  private spawnBlitz(coords: Coord[]): void {
    coords.forEach((c, i) => {
      if (this.model.grid.get(c)) this.placedAnim.set(`${c.row},${c.col}`, this.clock); // a pipe -> draw in
      this.blitzStrikes.push({ row: c.row, col: c.col, born: this.clock + i * 55, seed: hash3(c.row, c.col, 5) });
    });
  }

  /** Forked lightning bolt + flash + radiating sparks at each blitzed tile (cascaded). */
  private renderBlitz(g: G): void {
    this.blitzStrikes = this.blitzStrikes.filter((s) => this.clock - s.born < 380);
    for (const s of this.blitzStrikes) {
      const age = this.clock - s.born;
      if (age < 0) continue; // staggered — not struck yet
      const x = this.colX(s.col) + CELL / 2;
      const y = this.rowScreenY(s.row) + CELL / 2;
      if (y < HUD_H - CELL || y > this.pondTop + CELL) continue;
      const t = age / 380;
      if (t < 0.45) {
        const a = 1 - t / 0.45;
        const topY = Math.max(HUD_H, y - CELL * 2.6);
        g.lineStyle(3, 0xfff6b0, a); // the bolt: jagged segments from above down to the tile
        let px = x;
        let py = topY;
        for (let k = 1; k <= 5; k++) {
          const ny = topY + (y - topY) * (k / 5);
          const jit = (hash3(Math.floor(s.seed * 97), k, 3) - 0.5) * CELL * 0.5 * (1 - k / 5);
          const nx = x + jit;
          g.lineBetween(px, py, nx, ny);
          px = nx;
          py = ny;
        }
        g.fillStyle(0xffffff, a * 0.7); // white flash at the strike point
        g.fillCircle(x, y, CELL * 0.42 * (1 - t));
      }
      const sa = (1 - t) * 0.85; // radiating sparks for the whole life
      g.lineStyle(2, 0xffe14a, sa);
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + s.seed * 6;
        const r0 = CELL * 0.18 + t * CELL * 0.5;
        g.lineBetween(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0, x + Math.cos(ang) * (r0 + CELL * 0.16), y + Math.sin(ang) * (r0 + CELL * 0.16));
      }
    }
  }

  private spawnScorePop(coord: Coord, value: number): void {
    this.scorePops.push({
      x: this.colX(coord.col) + CELL / 2,
      y: this.rowScreenY(coord.row) + CELL / 2,
      value,
      born: this.clock,
    });
  }

  /** Floating "+N BONUS" with a star, rising and fading — the classic arcade score pop. */
  private renderScorePops(): void {
    const LIFE = 1500;
    this.scorePops = this.scorePops.filter((p) => this.clock - p.born < LIFE);
    for (const p of this.scorePops) {
      const t = (this.clock - p.born) / LIFE;
      const rise = -t * CELL * 1.8; // drifts up the screen
      const a = Math.min(1, t * 10) * Math.min(1, (1 - t) / 0.35); // quick in, fade out
      const x = p.x;
      const y = p.y + rise;
      this.useSprite("power-star", x, y - 14, CELL * 0.5, Z_TEXT - 1, 0, { alpha: a });
      this.useLabel(`+${p.value}\nBONUS`, x, y + 20, Z_TEXT, 15, { alpha: a, color: "#ffd24a" });
    }
  }

  /** A power tile just fired: flash its label in the banner (same widget as "LEVEL N"). */
  private onPowerFired(power: PowerType): void {
    this.sfxPower(power);
    const LABELS: Record<PowerType, string> = {
      "speed-up": "SPILL SURGE!",
      "speed-down": "SPILL EASED",
      protest: "PROTEST!",
      score: "EXTRA SCORE!",
      freeze: "SPILL FROZEN!",
      poison: "FISH POISONED!",
      rain: "RAIN!",
      blitz: "PIPE BLITZ!",
    };
    this.queueBanner([LABELS[power]], 1300);
  }

  /** Rain pouring over the grid while a rain marker is active — obscures the view (the cost),
   *  while the water-quality meter recovers (the reward). */
  private renderRain(g: G): void {
    if (!this.model.raining) return;
    const top = HUD_H;
    const span = this.pondTop - top;
    g.fillStyle(0x6f9fd0, 0.15); // cool wash that greys the board out
    g.fillRect(0, top, GAME_WIDTH, span);
    g.lineStyle(2, 0xcfe6ff, 0.5); // streaks of falling rain
    for (let i = 0; i < 95; i++) {
      const x = hash3(i, 0, 1) * GAME_WIDTH;
      const spd = 380 + hash3(i, 0, 2) * 280;
      const y = top + (((hash3(i, 0, 3) * span + (this.clock * spd) / 1000) % span) + span) % span;
      g.lineBetween(x, y, x - 5, y + 15);
    }
  }

  /** A brief full-screen colour flash (surge warning / win / lose) that fades out fast. */
  private renderFlash(g: G): void {
    const left = this.flashUntil - this.clock;
    if (left <= 0) return;
    g.fillStyle(this.flashColor, Math.min(0.5, left / 900));
    g.fillRect(0, 0, GAME_WIDTH, this.viewH);
  }

  /** Icy wash over the grid while a freeze marker holds the flow paused. */
  private renderFreeze(g: G): void {
    if (!this.model.frozen) return;
    const top = HUD_H;
    const bot = this.pondTop;
    const a = 0.16 + 0.06 * Math.sin(this.clock / 200);
    g.fillStyle(0x8fe3ff, a);
    g.fillRect(0, top, GAME_WIDTH, bot - top);
    g.fillStyle(0xffffff, 0.06); // frost lines at the band edges
    g.fillRect(0, top, GAME_WIDTH, 5);
    g.fillRect(0, bot - 5, GAME_WIDTH, 5);
  }

  /** Big arcade instruction flash (Llamatron-style): pops in, holds, fades; queued so several
   *  can play in turn. Hidden while a Start/Win/Lose card is up. */
  private renderBanner(): void {
    const playing = this.model.started && this.model.state !== "WON" && this.model.state !== "GAMEOVER";
    if (!this.banner && this.bannerQueue.length && playing) {
      this.banner = { ...this.bannerQueue.shift()!, start: this.clock };
    }
    const age = this.banner ? this.clock - this.banner.start : 0;
    if (!this.banner || !playing || age > this.banner.hold) {
      this.banner = null;
      this.bannerText.setVisible(false);
      return;
    }
    const fadeIn = Math.min(1, age / 180);
    const fadeOut = Math.min(1, Math.max(0, (this.banner.hold - age) / 450));
    const alpha = Math.min(fadeIn, fadeOut);
    const pop = age < 300 ? easeOutBack(Math.min(1, age / 300)) : 1;
    const cy = HUD_H + (this.pondTop - HUD_H) * 0.3;
    this.bannerText
      .setText(this.banner.lines.join("\n"))
      .setPosition(GAME_WIDTH / 2, cy)
      .setScale(pop)
      .setAlpha(alpha)
      .setVisible(true);
  }

  /** "Oh No. Condom!"-style banner that pops, holds, and fades when sewage hits a special tile. */
  private renderToast(g: G): void {
    if (!this.toast) {
      this.toastText.setVisible(false);
      return;
    }
    const age = this.clock - this.toast.start;
    if (age > TOAST_MS) {
      this.toast = null;
      this.toastText.setVisible(false);
      return;
    }
    const fadeIn = Math.min(1, age / 150);
    const fadeOut = Math.min(1, Math.max(0, (TOAST_MS - age) / 400));
    const alpha = Math.min(fadeIn, fadeOut);
    const pop = age < 240 ? easeOutBack(age / 240) : 1;

    const label = this.toast.label;
    const cy = HUD_H + 96;
    const padX = 16;
    const iconBox = 40 * pop;
    const textW = label.length * 11.5; // rough width estimate
    const w = iconBox + textW + padX * 2 + 8;
    const cx = GAME_WIDTH / 2;
    const x0 = cx - w / 2;

    g.fillStyle(0x0c0b0a, 0.86 * alpha);
    g.fillRoundedRect(x0, cy - 32 * pop, w, 64 * pop, 14);
    g.lineStyle(2, COLORS.current, 0.5 * alpha);
    g.strokeRoundedRect(x0, cy - 32 * pop, w, 64 * pop, 14);

    const iconX = x0 + padX + iconBox / 2;
    this.useSprite(this.toast.icon, iconX, cy, iconBox, Z_TEXT - 1);

    this.toastText
      .setText(label)
      .setPosition(iconX + iconBox / 2 + 8, cy)
      .setScale(pop)
      .setAlpha(alpha)
      .setVisible(true);
  }

  private renderDrips(g: G): void {
    for (const d of this.drips) {
      // stretch the drop along its fall so the motion reads (a teardrop streak)
      const stretch = Math.min(2.4, 1 + Math.abs(d.vy) / 700);
      g.fillStyle(COLORS.sewage, 0.95);
      g.fillEllipse(d.x, d.y, d.r * 2, d.r * 2 * stretch);
    }
    this.renderSplashes(g);
  }

  /** Throw up a little crown of droplets + a ripple where a drip hits the pond. */
  private spawnSplash(x: number, y: number, impactVy: number): void {
    // throttled, and silenced once the level's over (drips keep falling under the end card)
    if (this.model.state === "FLOWING" && this.clock - this.lastSploshAt > 750) {
      this.lastSploshAt = this.clock;
      this.sfxSplosh();
    }
    if (this.splashes.length > 120) return;
    this.splashes.push({ x, y, vx: 0, vy: 0, life: 420, ripple: true });
    const n = 3 + Math.floor(Math.random() * 3);
    const power = Math.min(1, impactVy / 1400);
    for (let i = 0; i < n; i++) {
      this.splashes.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 120,
        vy: -(90 + Math.random() * 120) * (0.6 + power), // up and out
        life: 320 + Math.random() * 160,
        ripple: false,
      });
    }
  }

  private updateSplashes(dtMs: number, pondTop: number): void {
    if (this.splashes.length === 0) return;
    const dt = dtMs / 1000;
    const out: Splash[] = [];
    for (const s of this.splashes) {
      s.life -= dtMs;
      if (s.life <= 0) continue;
      if (!s.ripple) {
        s.vy += DRIP_GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (s.y > pondTop + 4 && s.vy > 0) continue; // fallen back into the pond
      }
      out.push(s);
    }
    this.splashes = out;
  }

  private renderSplashes(g: G): void {
    for (const s of this.splashes) {
      if (s.ripple) {
        const t = 1 - s.life / 420; // 0..1
        g.lineStyle(2, 0xffffff, (1 - t) * 0.5);
        g.strokeEllipse(s.x, s.y, 8 + t * 34, 3 + t * 12);
      } else {
        g.fillStyle(COLORS.sewage, Math.min(0.95, s.life / 320));
        g.fillCircle(s.x, s.y, 2.4);
      }
    }
  }

  private renderJunkDrops(): void {
    for (const j of this.junkDrops) {
      // floating junk bobs and sways gently on the surface
      const bob = j.floating ? Math.sin(this.clock / 420 + j.x * 0.05) * 3 : 0;
      const rot = j.floating ? Math.sin(this.clock / 700 + j.x) * 0.25 : j.rot;
      this.useSprite(j.icon, j.x, j.y + bob, j.size, Z_UI_SPRITE + 1, rot);
    }
  }

  // ---- pond ------------------------------------------------------------------

  private renderPond(g: G): void {
    const y0 = this.pondTop;
    const q = this.model.balance; // 1 = clean, 0 = full of sewage

    // clean water...
    g.fillStyle(COLORS.pondClean, 1);
    g.fillRect(0, y0, GAME_WIDTH, POND_H);
    g.fillStyle(0xffffff, 0.06);
    g.fillRect(0, y0, GAME_WIDTH, 5); // surface shimmer

    // aquatic plants rooted on the bed, swaying (drawn before the muck so it buries them)
    const bedY = y0 + POND_H;
    const plants = 7;
    for (let i = 0; i < plants; i++) {
      const px = ((i + 0.5) / plants) * GAME_WIDTH + (hash3(i, 3, 1) - 0.5) * 20;
      const h = POND_H * (0.55 + hash3(i, 7, 2) * 0.35);
      this.drawReed(g, px, bedY, h, i, hash3(i, 1, 5) > 0.5 ? COLORS.plant : COLORS.plantDark);
    }

    // ...with just a thin sediment of muck on the bed, thickening a touch as quality drops
    const shitH = 3 + (1 - q) * 11; // a few pixels of sediment, never floods the pond
    const shitTop = y0 + POND_H - shitH;
    g.fillStyle(COLORS.pondDirty, 1);
    g.fillRect(0, shitTop, GAME_WIDTH, shitH);
    g.fillStyle(COLORS.pondShitTop, 0.5); // a soft lighter crust along the top of the sediment
    g.fillRect(0, shitTop, GAME_WIDTH, 2);
    for (let i = 0; i < 26; i++) {
      // bits of settled grit sitting IN the sediment (not balls floating above it)
      const x = ((i + 0.5) / 26) * GAME_WIDTH;
      const gy = shitTop + 2 + hash3(i, 7, 2) * Math.max(1, shitH - 3);
      g.fillRect(x - 1, gy, 2, 1.5);
    }

    const cleanH = POND_H - shitH;
    const total = this.model.fishCount;
    const kinds = this.model.fishKinds;
    const dead = this.model.fishDead; // >0 only once the pond is past half-full
    const surfaceY = y0 + 9;

    // sync the dead-floater list with the model's dead count (a fish just died -> add one)
    while (this.deadFloaters.length < dead) {
      const idx = this.deadFloaters.length;
      this.deadFloaters.push({
        kind: kinds[idx] ?? 0,
        x: 24 + ((idx * 67) % (GAME_WIDTH - 48)),
        startY: y0 + cleanH * (0.4 + hash3(idx, 8, 3) * 0.4), // dies somewhere mid-pond
        bornAt: this.clock,
      });
    }
    while (this.deadFloaters.length > dead) this.deadFloaters.pop();

    // dead fish drift slowly UP from where they died to the surface, then gently bob
    const RISE_MS = 2800;
    for (let k = 0; k < this.deadFloaters.length; k++) {
      const f = this.deadFloaters[k];
      const t = Math.min(1, (this.clock - f.bornAt) / RISE_MS);
      const ease = 1 - (1 - t) * (1 - t); // ease-out rise (slow drift to the surface)
      const bob = t >= 1 ? Math.sin(this.clock / 420 + f.x) * 1.5 : 0;
      const fy = f.startY + (surfaceY - f.startY) * ease + bob;
      this.drawFish(g, f.x, fy, f.kind % 2 ? 1 : -1, f.kind, true);
    }

    // live fish swim below the surface
    const span = GAME_WIDTH + 80;
    const bandTop = y0 + 26;
    const bandBot = y0 + Math.max(40, cleanH - 10);
    for (let i = dead; i < total; i++) {
      const kind = kinds[i] ?? 0;
      const dir = hash3(i, 5, 1) > 0.5 ? 1 : -1; // some swim left, some right
      const speed = (0.018 + hash3(i, 2, 3) * 0.022) * dir; // px per ms
      const fx = (((hash3(i, 9, 2) * span + this.clock * speed) % span) + span) % span - 40;
      const fy = bandTop + hash3(i, 4, 7) * (bandBot - bandTop) + Math.sin(this.clock / 500 + i * 2) * 4;
      this.drawFish(g, fx, fy, dir, kind, false);
    }
  }

  /** A swaying aquatic reed rooted at (px, baseY), growing up `height`. */
  private drawReed(g: G, px: number, baseY: number, height: number, seed: number, color: number): void {
    const segs = 6;
    let prevx = px;
    let prevy = baseY;
    for (let i = 1; i <= segs; i++) {
      const f = i / segs;
      const sway = Math.sin(this.clock / 620 + px * 0.05 + seed) * 12 * f * f; // more at the tip
      const x = px + sway;
      const yy = baseY - height * f;
      g.lineStyle(4 * (1 - f * 0.6), color, 0.92);
      g.lineBetween(prevx, prevy, x, yy);
      if (i === segs - 1 || i === segs - 2) {
        // a little leaf blade
        g.lineStyle(2.5, color, 0.85);
        g.lineBetween(x, yy, x + 9 * (i % 2 ? 1 : -1), yy - 5);
      }
      prevx = x;
      prevy = yy;
    }
  }

  private drawFish(g: G, cx: number, cy: number, dir: number, kind = 0, dead = false): void {
    // a dead fish is the SAME species shape, just greyscaled (not a different sprite, not belly-up)
    const species = (kind % 5) + 1;
    const key = dead ? `fish-${species}-dead` : `fish-${species}`;
    const sz = 30 + (kind % 3) * 7; // species vary in size
    if (this.useSprite(key, cx, cy, sz, Z_UI_SPRITE + 1, 0, { flipX: dir < 0 })) return;
    // fallback: a simple coloured ellipse
    const color = dead ? COLORS.fishDead : FISH_COLORS[kind % FISH_COLORS.length];
    g.fillStyle(color, dead ? 0.92 : 1);
    g.fillEllipse(cx, cy, sz * 0.9, sz * 0.5);
    g.fillTriangle(cx - sz * 0.42 * dir, cy, cx - sz * 0.75 * dir, cy - sz * 0.25, cx - sz * 0.75 * dir, cy + sz * 0.25);
  }

  // ---- HUD -------------------------------------------------------------------

  /** Win-settle progress 0..1 over WIN_DRAIN_MS — the contained sewage eases to a stop.
   *  0 when not winning; reaches (and stays) 1 once the settle completes. */
  private winDrainNow(): number {
    if (this.model.state !== "WON" || this.winDrainStart < 0) return 0;
    return Math.min(1, (this.clock - this.winDrainStart) / WIN_DRAIN_MS);
  }

  /** Bookend countdowns: "SPILL STARTING 3..2..1" before the flow, and "SPILL STOPPING 5..1" over
   *  the last few segments — so both the start and the end are clearly telegraphed. */
  /** A diegetic sewer pressure gauge (top-right): the needle climbs SAFE→SPILL over the pre-flow
   *  3·2·1, then sweeps SPILL→SAFE as you contain the dump. Centre readout = seconds, then segments
   *  left. Both phases of "the spill clock" in one widget. */
  /** The spill meter: a full-width LED strip that lights up from the left (SAFE green) toward the
   *  right (SPILL red) as the sewage gathers speed, dimming as it slows. A tick per LED change. */
  private renderGauge(g: G): void {
    const m = this.model;
    // empty until the sewage is actually flowing (and zero while frozen — it isn't moving)
    const flowing = m.started && m.state === "FLOWING";
    const target = flowing && !m.frozen ? m.flowSpeedNorm : 0;
    this.gaugeF += (target - this.gaugeF) * 0.2; // smooth the per-ring jumps into a glow
    const f = Math.max(0, Math.min(1, this.gaugeF));

    const STEPS = GAUGE_STEPS;
    const lit = Math.round(f * STEPS);
    // tick on every LED step the flow lights/extinguishes (only while flowing)
    if (flowing && lit !== this.lastGaugeStep) {
      if (this.lastGaugeStep !== -999) this.sfxTick();
      this.lastGaugeStep = lit;
    }

    // --- reserved top band: masks any grid content scrolled up into it, behind the score + meter ---
    g.fillStyle(0x0c0b0a, 1);
    g.fillRect(0, 0, GAME_WIDTH, HUD_H);

    // --- the band, left to right: poo icon, the LED strip, then the two-line SCORE on the right ---
    const h = 10;
    const mid = HUD_H / 2;
    const y = mid - h / 2; // strip top
    const pad = 6;
    const pooSz = 28;
    this.useSprite("poo", pad + pooSz / 2, mid, pooSz, Z_UI_SPRITE); // the poo dial face
    // SCORE block pinned to the right edge; the strip fills the gap between the poo and it
    this.statusText.setFontSize(11).setAlign("right").setOrigin(1, 0.5).setLineSpacing(2).setPosition(GAME_WIDTH - pad, mid);
    const x0 = pad + pooSz + 8; // strip starts after the poo icon
    const stripW = GAME_WIDTH - pad - this.statusText.width - 12 - x0; // ...and stops before the score
    const gap = 2;
    const cellW = (stripW - gap * (STEPS + 1)) / STEPS;
    g.fillStyle(0x05070c, 0.9); // dark backing so the LEDs read as cells
    g.fillRect(x0 - 2, y - 3, stripW + 4, h + 6);
    for (let i = 0; i < STEPS; i++) {
      const frac = (i + 0.5) / STEPS;
      const col = frac < 0.4 ? 0x4ade80 : frac < 0.62 ? 0xf6c453 : 0xff5c5c; // RAG by position
      const on = i < lit;
      g.fillStyle(col, on ? 1 : 0.14); // lit vs dim
      g.fillRect(x0 + gap + i * (cellW + gap), y, cellW, h);
    }

    this.countdownLabel.setVisible(false);
    this.countdownNum.setVisible(false);
  }

  private renderHud(): void {
    const m = this.model;
    this.statusText.setText(`SCORE\n${m.runScore}`); // two lines; positioned by the meter band
    this.fpsText.setVisible(this.showFps);
    if (this.showFps) this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} fps`).setPosition(8, this.viewH - 18);

    if (m.state === "WON" || m.state === "GAMEOVER") return; // the end dialog owns the text

    this.centerText.setPosition(GAME_WIDTH / 2, this.pondTop / 2);
    if (m.state === "COUNTDOWN") {
      this.centerText.setText(""); // no "flow in" countdown text — the spill just starts
    } else if (m.state === "FLOWING") {
      this.centerText.setText(m.leaking ? "LEAK!" : "");
    } else {
      this.centerText.setText("");
    }
  }

  /** Modal end-of-level card framed as a real spill report — the player's single spill (duration,
   *  litres discharged, fish lost) set against the real 2024 scale. The awareness IS the payoff. */
  private renderEndDialog(g: G): void {
    const m = this.model;
    // hold the card back while the pipes drain on a win, then show the report
    const draining = m.state === "WON" && this.clock - this.winDrainStart < WIN_DRAIN_MS;
    if ((m.state !== "WON" && m.state !== "GAMEOVER") || draining) {
      this.endButton = null;
      this.buttonText.setVisible(false);
      this.compareText.setVisible(false);
      return;
    }
    const won = m.state === "WON";
    const accent = won ? COLORS.protest : COLORS.dividend;

    g.fillStyle(0x05070c, 0.66); // dim the whole screen so it reads as modal
    g.fillRect(0, 0, GAME_WIDTH, this.viewH);

    // this level reframed as one real spill event
    const hours = Math.max(1, Math.round(m.overflowTotal * 0.4));
    const litres = (hours * 140000).toLocaleString();
    const title = won ? "WELL DONE!" : "RIVER OVERWHELMED";
    // on a game over (run end), flag a high-score so the player knows the table awaits
    const highScore = !won && qualifies(m.runScore);
    const report =
      `${title}\n\n` +
      `DURATION    ${hours} HOURS\n` +
      `DISCHARGED    ${litres} L\n` +
      `FISH LOST    ${m.fishDead}\n\n` +
      `SCORE    ${m.runScore}` +
      (highScore ? `\n\nNEW HIGH SCORE!` : "");
    // Set the text first, then size the card to fit it — no leftover gap where the tanker used to sit.
    this.centerText.setOrigin(0.5, 0).setText(report);
    this.compareText
      .setOrigin(0.5, 0)
      .setText(COMPARISONS[(m.level - 1) % COMPARISONS.length])
      .setVisible(true);

    const bw = 240;
    const bh = 54;
    const padTop = 30;
    const gap = 22;
    const padBottom = 22;
    const pw = 420;
    const contentH = padTop + this.centerText.height + gap + this.compareText.height + gap + bh + padBottom;
    const ph = Math.min(this.viewH - 24, contentH);
    const px = GAME_WIDTH / 2 - pw / 2;
    const py = this.viewH / 2 - ph / 2;
    g.fillStyle(0x12100e, 0.97);
    g.fillRoundedRect(px, py, pw, ph, 18);
    g.lineStyle(3, accent, 0.95);
    g.strokeRoundedRect(px, py, pw, ph, 18);

    let cy = py + padTop;
    this.centerText.setPosition(GAME_WIDTH / 2, cy);
    cy += this.centerText.height + gap;
    this.compareText.setPosition(GAME_WIDTH / 2, cy); // the gut-punch: one spill vs the real annual scale

    const bx = GAME_WIDTH / 2 - bw / 2;
    const by = py + ph - bh - padBottom;
    // the throbbing neon button, shared with the title screen's PLAY
    drawFlashButton(g, this.clock, bx, by, bw, bh);
    this.endButton = { x: bx, y: by, w: bw, h: bh };
    this.buttonText
      .setPosition(GAME_WIDTH / 2, by + bh / 2)
      .setText(won ? "NEXT LEVEL" : "CONTINUE")
      .setVisible(true);
  }

  /** Pre-run Start screen: a title, instructions (level 1), and a Start button that
   *  kicks off the run (the poo then starts welling out and the countdown ticks). */
  private renderStartOverlay(g: G): void {
    const m = this.model;
    if (m.started) {
      this.startButton = null;
      this.factText.setVisible(false);
      return;
    }
    g.fillStyle(0x05070c, 0.66); // dim the board behind it
    g.fillRect(0, 0, GAME_WIDTH, this.viewH);

    const pw = 440;
    const ph = Math.min(this.viewH - 24, 452);
    const px = GAME_WIDTH / 2 - pw / 2;
    const py = this.viewH / 2 - ph / 2;
    g.fillStyle(0x12100e, 0.97);
    g.fillRoundedRect(px, py, pw, ph, 18);
    g.lineStyle(3, COLORS.pondClean, 0.95);
    g.strokeRoundedRect(px, py, pw, ph, 18);

    const intro =
      m.level === 1
        ? "SPILLZ\n\nWater firms pump sewage\ninto our rivers.\n\nYou can't stop them —\nonly limit the damage."
        : `LEVEL ${m.level}\n\nLimit the damage.\nSave what fish you can.`;
    this.centerText.setPosition(GAME_WIDTH / 2, py + 86).setText(intro);

    // a real UK water-pollution fact, one per level (cycles through the data set)
    const f = FACTS[(m.level - 1) % FACTS.length];
    this.factText
      .setPosition(GAME_WIDTH / 2, py + 196)
      .setText(`DID YOU KNOW?\n\n${f.fact}\n\n— ${f.source}`)
      .setVisible(true);

    const bw = 240;
    const bh = 58;
    const bx = GAME_WIDTH / 2 - bw / 2;
    const by = py + ph - bh - 24;
    // the throbbing neon button, shared with the title screen's PLAY
    drawFlashButton(g, this.clock, bx, by, bw, bh);
    this.startButton = { x: bx, y: by, w: bw, h: bh };
    this.buttonText.setPosition(GAME_WIDTH / 2, by + bh / 2).setText("START").setVisible(true);
  }

  /** Mid-run PAUSED scrim: a frozen board behind a RESUME button (reuses the shared
   *  throbbing-neon button); P resumes, Q quits. Only drawn while this.paused. */
  private renderPauseOverlay(g: G): void {
    if (!this.paused) {
      this.pauseButton = null;
      return;
    }
    g.fillStyle(0x05070c, 0.72);
    g.fillRect(0, 0, GAME_WIDTH, this.viewH);

    const cx = GAME_WIDTH / 2;
    const cy = this.viewH / 2;
    this.centerText.setPosition(cx, cy - 72).setText("PAUSED").setVisible(true);

    const bw = 240;
    const bh = 56;
    const bx = cx - bw / 2;
    const by = cy - bh / 2 + 6;
    drawFlashButton(g, this.clock, bx, by, bw, bh);
    this.pauseButton = { x: bx, y: by, w: bw, h: bh };
    this.buttonText.setPosition(cx, by + bh / 2).setText("RESUME").setVisible(true);

    this.compareText.setPosition(cx, by + bh + 30).setText("P RESUME   -   Q QUIT").setVisible(true);
  }

}
