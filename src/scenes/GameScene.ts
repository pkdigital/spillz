import Phaser from "phaser";
import { CONFIG, Game } from "../core/game";
import { PIECE_OPENINGS, sidesOf } from "../core/pieces";
import {
  Side,
  type Cell,
  type Coord,
  type FlowEvent,
  type GameState,
  type JunkType,
  type PieceType,
  type PowerType,
  type QueuePiece,
} from "../core/types";

const CELL = 80;
const HUD_H = 0; // no top bar — level + next-pipe show as overlays
const QUEUE_H = 0; // next-pipe box is now a top-left overlay, no bottom band

const ARCADE_FONT = "'Press Start 2P', monospace";
const POND_H = 100;

export const GAME_WIDTH = CONFIG.cols * CELL;
export const GAME_HEIGHT = HUD_H + CONFIG.rows * CELL + QUEUE_H + POND_H;

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
};

const TOAST_MS = 1700;

// Mario-Kart-style "next pipe" roulette: cycle shapes rapidly, then lock in.
const EXPLOSION_MS = 450;
const ROULETTE_MS = 720;
const ROULETTE_REEL = 14; // how many pieces scroll past over a spin (eased deceleration)
const ROULETTE_PIECES: PieceType[] = [
  "straight-v",
  "bend-ne",
  "straight-h",
  "tee-nes",
  "bend-sw",
  "cross",
  "bend-nw",
  "tee-esw",
  "bend-se",
];

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

/** A confetti ribbon flung out on level completion. */
interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: number;
}

const CONFETTI_COLORS = [0xff5c5c, 0xffd24a, 0x4ade80, 0x3fd0ff, 0xc06cff, 0xff8a3d, 0xffffff];

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

// fish species palette — picked per fish so each level's pond looks different
const FISH_COLORS = [0x9be15d, 0xffb347, 0x6fd3ff, 0xff8da3, 0xc792ea, 0xf6e05e];

const PLACE_ANIM_MS = 170;

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
  /** Dedicated, masked layer for the next-piece reel so symbols clip at the box rim.
   *  The mask is applied ONLY while spinning — a persistent mask does a per-frame
   *  stencil pass even when idle, which is slow on software WebGL. */
  private reelGfx!: G;
  private reelMaskG!: G;
  private reelMask!: Phaser.Display.Masks.GeometryMask;
  private statusText!: Phaser.GameObjects.Text;
  private fpsText!: Phaser.GameObjects.Text;
  private centerText!: Phaser.GameObjects.Text;

  private scrollPx = 0;
  private scrollTargetPx = 0;
  private clock = 0;

  /** Falling spilled-sewage particles (leak -> pond). */
  private drips: Drip[] = [];
  private splashes: Splash[] = [];
  private dripTimer = 0;
  /** Unflushables tumbling into the pond after being flowed through. */
  private junkDrops: JunkDrop[] = [];
  /** cellKey -> clock time placed, for the pipe draw-in animation. */
  private placedAnim = new Map<string, number>();
  /** Confetti ribbons + win bookkeeping for the level-clear celebration. */
  private confetti: Confetti[] = [];
  private prevState: GameState = "COUNTDOWN";
  /** Pending (re)start — deferred out of the input callback to the next tick. */
  private pendingRestart: { level: number; fishSaved: number; runScore: number } | null = null;
  /** Smoothed X of the next-pipe box — slides right when the action is behind it. */
  private boxX = 0;
  /** Active dynamite blasts (world row/col so they scroll with the grid). */
  private explosions: { row: number; col: number; start: number }[] = [];
  /** Hit-rect of the end-of-level dialog button (null when no dialog is shown). */
  private endButton: { x: number; y: number; w: number; h: number } | null = null;
  // drag-to-scroll: distinguish a tap (place) from a drag (pan), and peek away
  // from the auto-follow camera until `manualScrollUntil`, then drift back.
  private dragStartX = 0;
  private dragStartY: number | null = null;
  private dragStartScroll = 0;
  private dragging = false;
  private manualScrollUntil = 0;
  private buttonText!: Phaser.GameObjects.Text;

  /** Current on-screen "Oh No. Condom!"-style toast. */
  private toast: { label: string; icon: string; start: number } | null = null;
  private toastText!: Phaser.GameObjects.Text;

  /** Pooled sprite images, re-used each frame. */
  private sprites: Phaser.GameObjects.Image[] = [];
  private spriteIdx = 0;
  /** Pooled text labels (e.g. the faucet 2x/3x/4x tags), re-used each frame. */
  private labels: Phaser.GameObjects.Text[] = [];
  private labelIdx = 0;

  /** Roulette bookkeeping for the "next pipe" box. */
  private prevFront: QueuePiece | undefined;
  private rouletteStart = -9999;

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
    this.load.svg("power-faucet", "assets/power/faucet.svg", { width: 72, height: 72 });
    this.load.svg("power-fist", "assets/power/fist.svg", { width: 48, height: 48 });
    this.load.svg("decor-toilet-svg", "assets/decor/toilet.svg", { width: 256, height: 256 });
    this.load.svg("decor-arrow", "assets/decor/arrow-down.svg", { width: 64, height: 64 });
    this.load.svg("hint", "assets/decor/hint.svg", { width: 64, height: 64 });
    this.load.svg("fatberg", "assets/decor/fatberg.svg", { width: 200, height: 200 });
    for (let i = 1; i <= 5; i++) {
      this.load.svg(`fish-${i}`, `assets/decor/fish-${i}.svg`, { width: 96, height: 96 });
    }
    this.load.svg("fish-dead", "assets/decor/fish.svg", { width: 96, height: 96 }); // greyscale, for goners
    this.load.image("decor-toilet", "assets/decor/toilet.png"); // drop your PNG to override
  }

  create(data?: { level?: number; fishSaved?: number; runScore?: number }): void {
    this.model = new Game(undefined, data?.level ?? 1, data?.fishSaved ?? 0, data?.runScore ?? 0);
    this.scrollPx = 0;
    this.scrollTargetPx = 0;
    this.clock = 0;
    this.spriteIdx = 0;
    this.drips = [];
    this.splashes = [];
    this.dripTimer = 0;
    this.junkDrops = [];
    this.placedAnim.clear();
    this.confetti = [];
    this.prevState = "COUNTDOWN";
    this.pendingRestart = null;
    this.boxX = 0;
    this.explosions = [];
    this.endButton = null;
    this.dragStartY = null;
    this.dragging = false;
    this.manualScrollUntil = 0;
    this.toast = null;
    this.prevFront = undefined;
    this.rouletteStart = -9999;
    this.sprites = []; // pooled images were destroyed on restart — rebuild fresh
    this.labels = [];

    this.gfxWorld = this.add.graphics();
    this.gfxUi = this.add.graphics().setDepth(Z_UI);
    this.reelGfx = this.add.graphics().setDepth(Z_UI);
    this.reelMaskG = this.add.graphics().setVisible(false);
    this.reelMask = this.reelMaskG.createGeometryMask(); // applied only while spinning

    // level indicator — a top-right overlay (no black HUD box anymore)
    this.statusText = this.add
      .text(GAME_WIDTH - 12, 12, "", {
        fontFamily: ARCADE_FONT,
        fontSize: "13px",
        color: COLORS.text,
        align: "right",
        lineSpacing: 6,
      })
      .setOrigin(1, 0)
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
    this.buttonText = this.add
      .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "14px", color: "#12100e" })
      .setOrigin(0.5)
      .setDepth(Z_TEXT)
      .setVisible(false);

    this.input.on("pointerdown", this.onDown, this);
    this.input.on("pointermove", this.onMove, this);
    this.input.on("pointerup", this.onUp, this);
    // dev shortcuts: N = skip to next level (reach the fatberg on L3+); D = kill a fish
    this.input.keyboard?.on("keydown-N", () => {
      this.pendingRestart = { level: this.model.level + 1, fishSaved: this.model.fishSaved, runScore: this.model.runScore };
    });
    this.input.keyboard?.on("keydown-D", () => this.model.killFish());
  }

  private onDown(p: Phaser.Input.Pointer): void {
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

    // Defer scene restarts to the next update tick (restarting inside an input
    // callback can leave the scene half-torn-down -> blank screen).
    if (this.model.state === "WON" || this.model.state === "GAMEOVER") {
      const b = this.endButton; // only the dialog button advances
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        const level = this.model.state === "WON" ? this.model.level + 1 : this.model.level;
        this.pendingRestart = { level, fishSaved: this.model.fishSaved, runScore: this.model.runScore };
      }
      return;
    }
    const coord = this.toCell(p.x, p.y);
    if (coord && this.model.placePiece(coord)) {
      this.placedAnim.set(`${coord.row},${coord.col}`, this.clock); // animate it drawing in
      this.manualScrollUntil = 0; // resume auto-follow now that you've acted
    }
  }

  /** How far down the player may pan — a few rows past the deepest action. */
  private maxScroll(): number {
    const deepest = Math.max(this.model.buildRow, this.model.frontRow, this.model.terminal.row);
    return Math.max(0, (deepest - this.visRows + 4) * CELL);
  }

  private toCell(x: number, y: number): Coord | null {
    const gridY = y - HUD_H;
    if (gridY < 0 || gridY > this.pondTop) return null;
    const col = Math.floor(x / CELL);
    const row = Math.floor((gridY + this.scrollPx) / CELL);
    const coord = { row, col };
    return this.model.grid.inBounds(coord) ? coord : null;
  }

  private rowScreenY(row: number): number {
    return HUD_H + row * CELL - this.scrollPx;
  }

  // ---- responsive layout (canvas height matches the device, pond pinned to bottom) ----
  private get viewH(): number {
    return this.scale.gameSize.height;
  }
  /** Screen Y where the grid ends and the pond begins. */
  private get pondTop(): number {
    return this.viewH - POND_H;
  }
  /** Number of grid rows that fit in the play area above the pond. */
  private get visRows(): number {
    return Math.max(1, Math.floor(this.pondTop / CELL));
  }

  update(_time: number, deltaMs: number): void {
    // a tap on the win/lose screen queued a restart — do it cleanly here
    if (this.pendingRestart) {
      const data = this.pendingRestart;
      this.pendingRestart = null;
      this.scene.restart(data);
      return;
    }

    this.clock += deltaMs;
    this.model.update(deltaMs);

    // level cleared: burst confetti, then wait for a tap to move on
    if (this.model.state === "WON" && this.prevState !== "WON") {
      this.spawnConfetti();
    }
    this.prevState = this.model.state;

    this.updateCamera(deltaMs);
    this.updateDrips(deltaMs);
    this.updateConfetti(deltaMs);

    // each special tile the sewage hits: clogs tumble into the pond; newest pops a toast
    // message popups are disabled for now — keep only the physical effects
    // (junk tumbling into the pond, the dynamite blast)
    for (const e of this.model.consumeEvents()) {
      if (e.kind === "clog") this.spawnJunkDrop(e);
      else if (e.kind === "explosion") this.explosions.push({ ...e.coord, start: this.clock });
    }

    this.render();
  }

  private spawnConfetti(): void {
    const cx = GAME_WIDTH / 2;
    const cy = this.pondTop * 0.42;
    for (let i = 0; i < 130; i++) {
      const spd = 220 + Math.random() * 420;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1; // mostly upward fan
      this.confetti.push({
        x: cx + (Math.random() - 0.5) * GAME_WIDTH * 0.4,
        y: cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 14,
        w: 6 + Math.random() * 8,
        h: 11 + Math.random() * 15,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      });
    }
  }

  private updateConfetti(dtMs: number): void {
    if (!this.confetti.length) return;
    const dt = dtMs / 1000;
    for (const c of this.confetti) {
      c.vy += 760 * dt; // gravity
      c.vx *= 0.99;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
    }
    this.confetti = this.confetti.filter((c) => c.y < this.viewH + 40);
  }

  private renderConfetti(g: G): void {
    for (const c of this.confetti) {
      const cos = Math.cos(c.rot);
      const sin = Math.sin(c.rot);
      const hw = c.w / 2;
      const hh = c.h / 2;
      const px = (dx: number, dy: number) => c.x + dx * cos - dy * sin;
      const py = (dx: number, dy: number) => c.y + dx * sin + dy * cos;
      g.fillStyle(c.color, 0.95);
      g.fillTriangle(px(-hw, -hh), py(-hw, -hh), px(hw, -hh), py(hw, -hh), px(hw, hh), py(hw, hh));
      g.fillTriangle(px(-hw, -hh), py(-hw, -hh), px(hw, hh), py(hw, hh), px(-hw, hh), py(-hw, hh));
    }
  }

  /** A flowed-through unflushable tumbles out of its tile and falls into the pond. */
  private spawnJunkDrop(e: FlowEvent): void {
    if (this.junkDrops.length > 40) return;
    const x = e.coord.col * CELL + CELL / 2;
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
    const survivors: Drip[] = [];
    for (const d of this.drips) {
      d.vy += DRIP_GRAVITY * dt; // accelerate under gravity
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.y >= impactY) this.spawnSplash(d.x, impactY, d.vy);
      else survivors.push(d);
    }
    this.drips = survivors;
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
        }
      }
    }
    // keep the pond from overflowing — drop the oldest floaters
    if (this.junkDrops.length > 16) this.junkDrops.splice(0, this.junkDrops.length - 16);

    if (this.model.leaking) {
      this.dripTimer += dtMs;
      while (this.dripTimer >= DRIP_SPAWN_MS) {
        this.dripTimer -= DRIP_SPAWN_MS;
        for (const leak of this.model.leaks) {
          if (this.drips.length >= DRIP_MAX) break;
          const x = leak.from.col * CELL + CELL / 2 + (Math.random() - 0.5) * CELL * 0.4;
          const y = this.rowScreenY(leak.from.row) + CELL / 2;
          if (y < HUD_H - CELL) continue; // leak off the top of the view
          this.drips.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 40,
            vy: 20 + Math.random() * 40, // starts slow, gravity does the rest
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

    const topRow = Math.max(0, Math.floor(this.scrollPx / CELL) - 1);
    const botRow = topRow + this.visRows + 2;

    const fatbergCells: Coord[] = []; // drawn last so their bulges aren't erased by lower rows
    for (let r = topRow; r <= botRow; r++) {
      const y = this.rowScreenY(r);
      const surface = r < SURFACE_ROWS;
      w.fillStyle(surface ? COLORS.grassBase : COLORS.soilBase, 1);
      w.fillRect(0, y, GAME_WIDTH, CELL);
      this.drawGroundTexture(w, r, y, surface);
      for (let c = 0; c < CONFIG.cols; c++) {
        const x = c * CELL;
        if ((r + c) % 2 === 0) {
          w.fillStyle(0xffffff, 0.008); // barely-there chequerboard placement guide
          w.fillRect(x, y, CELL, CELL);
        }
        const coord = { row: r, col: c };
        const cell = this.model.grid.get(coord);
        if (cell?.type === "fatberg") {
          fatbergCells.push(coord);
        } else if (cell) {
          this.drawCell(w, x + CELL / 2, y + CELL / 2, cell, coord);
        } else {
          const marker = this.model.powerMarkerAt(coord);
          if (marker) this.drawPowerMarker(w, x + CELL / 2, y + CELL / 2, marker.power, marker.mag);
        }
      }
    }
    const haveBergSprite = this.textures.exists("fatberg");
    for (const c of fatbergCells) {
      const isBerg = (dr: number, dc: number) =>
        this.model.grid.get({ row: c.row + dr, col: c.col + dc })?.type === "fatberg";
      if (haveBergSprite) {
        if (isBerg(-1, 0) || isBerg(0, -1)) continue; // one sprite, drawn at the 2x2 anchor
        const ccx = c.col * CELL + CELL; // centre of the 2x2 block
        const ccy = this.rowScreenY(c.row) + CELL;
        w.fillStyle(0x000000, 0.16);
        w.fillEllipse(ccx, ccy + CELL * 0.85, CELL * 1.5, CELL * 0.3); // ground shadow
        this.useSprite("fatberg", ccx, ccy, CELL * 2.2, Z_GRID_SPRITE + 1);
      } else {
        this.drawFatbergCell(w, c.col * CELL + CELL / 2, this.rowScreenY(c.row) + CELL / 2, c);
      }
    }

    this.drawTerminalBeacon(w);
    this.drawBuildHints();

    const ringStart = this.model.ringStart;
    const progress = this.model.fillProgress;
    for (const seg of this.model.filled) {
      if (seg.coord.row < topRow || seg.coord.row > botRow) continue;
      const cell = this.model.grid.get(seg.coord);
      if (!cell) continue;
      const cx = seg.coord.col * CELL + CELL / 2;
      const cy = this.rowScreenY(seg.coord.row) + CELL / 2;
      if (seg.at === ringStart && progress < 1) {
        this.drawSewagePartial(w, cx, cy, cell.openings, seg.entry, progress, seg.coord);
      } else {
        this.drawSewageFill(w, cx, cy, cell.openings, seg.coord);
      }
    }

    this.drawLeak(w);
    this.drawLeakTarget(w);
    this.renderExplosions(w);

    const u = this.gfxUi;
    u.clear();
    this.renderPond(u);
    this.renderHud(u);
    this.renderQueue(u); // after the HUD so the top-left box sits on top of it
    this.renderDrips(u); // falling spilled sewage, on top of everything
    this.renderJunkDrops();
    this.renderConfetti(u);
    this.renderToast(u);
    this.renderEndDialog(u); // modal card, drawn on top of everything

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
      this.drawPowerBadge(g, cx + CELL * 0.28, cy - CELL * 0.28, cell.power, 13, Z_GRID_SPRITE + 1);
    }
    const fuse = this.model.fuseAt(coord); // any piece can carry a lit fuse
    if (fuse !== undefined) this.drawDynamite(g, cx, cy, fuse);
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

  /** Pulsing sonar rings around the treatment works so it's obviously the target. */
  private drawTerminalBeacon(g: G): void {
    const t = this.model.terminal;
    const cx = t.col * CELL + CELL / 2;
    const cy = this.rowScreenY(t.row) + CELL / 2;
    const gridBottom = this.pondTop;

    if (cy >= HUD_H - CELL && cy <= gridBottom + CELL) {
      // on-screen: map-hotspot pings (bright-blue rings) around the plughole
      const maxR = CELL * 1.7;
      for (let k = 0; k < 3; k++) {
        const phase = (this.clock / 1200 + k / 3) % 1;
        const fade = 1 - phase;
        g.fillStyle(COLORS.hotspot, fade * 0.14);
        g.fillCircle(cx, cy, phase * maxR);
        g.lineStyle(3, COLORS.hotspot, fade * 0.85);
        g.strokeCircle(cx, cy, phase * maxR);
      }
      return;
    }
    // (off-screen down-arrow over the pond is hidden for now)
  }

  /** Blades of grass (swaying) on the surface; speckled dirt below. */
  private drawGroundTexture(g: G, r: number, y: number, surface: boolean): void {
    if (surface) {
      for (let i = 0; i < 26; i++) {
        const bx = hash3(r, i, 1) * GAME_WIDTH;
        const h = 9 + hash3(r, i, 2) * 15;
        const baseY = y + CELL - 1;
        const sway = Math.sin(this.clock / 680 + bx * 0.045 + r) * (3 + h * 0.18);
        g.lineStyle(2, hash3(r, i, 3) > 0.5 ? COLORS.grassBlade : COLORS.grassBladeDark, 0.9);
        g.lineBetween(bx, baseY, bx + sway, baseY - h);
      }
    } else {
      for (let i = 0; i < 13; i++) {
        const dx = hash3(r, i, 1) * GAME_WIDTH;
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

  private drawPowerBadge(g: G, cx: number, cy: number, power: PowerType, r: number, depth: number): void {
    // the faucet sits directly on the tile — no disc behind it
    const key = POWER_SPRITE[power];
    if (this.useSprite(key, cx, cy, r * 2.1, depth)) return;

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

  private renderExplosions(g: G): void {
    this.explosions = this.explosions.filter((e) => this.clock - e.start < EXPLOSION_MS);
    for (const e of this.explosions) {
      const t = (this.clock - e.start) / EXPLOSION_MS; // 0..1
      const x = e.col * CELL + CELL / 2;
      const y = this.rowScreenY(e.row) + CELL / 2;
      const r = CELL * (0.5 + t * 2);
      const a = 1 - t;
      g.fillStyle(0xffd24a, 0.5 * a);
      g.fillCircle(x, y, r);
      g.lineStyle(5, 0xff7a1a, a);
      g.strokeCircle(x, y, r);
      g.fillStyle(0xffffff, 0.8 * a);
      g.fillCircle(x, y, r * 0.3);
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
  private drawSewageFill(g: G, cx: number, cy: number, openings: number, coord: { row: number; col: number }): void {
    const t = CELL * 0.22;
    const half = CELL / 2;
    const seed = hash3(coord.row, coord.col, 2);
    const base = lerpColor(SEWAGE_YELLOW, SEWAGE_BROWN, 0.4 + seed * 0.25); // gentle per-segment variance
    const dark = shade(base, 0.72);
    const lite = shade(base, 1.18);

    g.fillStyle(base, 1);
    this.pipeShape(g, cx, cy, openings, t, half);

    const ph = hash3(coord.row, coord.col, 5);
    const n = openings & Side.N;
    const s = openings & Side.S;
    const w = openings & Side.W;
    const e = openings & Side.E;
    // channels span only the arms that exist (so specks never drift into a bend's
    // empty quadrant and look like they're leaking out of the pipe)
    const vTop = n ? cy - half : cy - t / 2;
    const vBot = s ? cy + half : cy + t / 2;
    const hL = w ? cx - half : cx - t / 2;
    const hR = e ? cx + half : cx + t / 2;
    // a soft speck that fades in, travels the channel, fades out (no jump at the wrap)
    const speck = (along: number, vertical: boolean, lane: number, col: number) => {
      const a = Math.sin(along * Math.PI) * 0.5; // 0 at both ends -> seamless loop
      if (a <= 0.02) return;
      g.fillStyle(col, a);
      if (vertical) g.fillCircle(cx + lane, vTop + along * (vBot - vTop), t * 0.26);
      else g.fillCircle(hL + along * (hR - hL), cy + lane, t * 0.26);
    };
    const flow = this.clock / 1500; // continuous scroll (down / right)
    if (n || s) {
      for (let k = 0; k < 3; k++) {
        const along = (flow + k / 3 + ph) % 1;
        speck(along, true, (k - 1) * t * 0.16, k === 1 ? lite : dark);
      }
    }
    if (w || e) {
      for (let k = 0; k < 3; k++) {
        const along = (flow + 0.16 + k / 3 + ph) % 1;
        speck(along, false, (k - 1) * t * 0.16, k === 1 ? lite : dark);
      }
    }
    // a subtle dark core so the centre reads as deeper sewage
    g.fillStyle(dark, 0.28);
    g.fillCircle(cx, cy, t * 0.34);
  }

  private drawSewagePartial(
    g: G,
    cx: number,
    cy: number,
    openings: number,
    entry: Side | null,
    p: number,
    coord: { row: number; col: number },
  ): void {
    const half = CELL / 2;
    const t = CELL * 0.22; // match a full tile's poo width
    // same varied yellow/brown as a settled tile, so there's no colour "pop" when it completes
    const seed = hash3(coord.row, coord.col, 2);
    const base = lerpColor(SEWAGE_YELLOW, SEWAGE_BROWN, 0.4 + seed * 0.25);
    const dark = shade(base, 0.72);
    const lite = shade(base, 1.18);
    const exits = sidesOf(openings).filter((s) => s !== entry) as Side[];

    const ph = hash3(coord.row, coord.col, 5);
    const point = (side: Side, distFromHub: number): [number, number] => {
      if (side === Side.N) return [cx, cy - distFromHub];
      if (side === Side.S) return [cx, cy + distFromHub];
      if (side === Side.W) return [cx - distFromHub, cy];
      return [cx + distFromHub, cy];
    };

    g.fillStyle(base, 1);
    let hubWet = entry === null;
    if (entry === null) {
      const L = half * p;
      for (const ex of exits) {
        this.fillArmFromHub(g, cx, cy, ex, L, t);
        const [fx, fy] = point(ex, L);
        this.flowAlong(g, cx, cy, fx, fy, dark, lite, t, ph + ex * 0.11); // hub -> front
      }
      g.fillRect(cx - t / 2, cy - t / 2, t, t);
    } else {
      const q1 = Math.min(1, p * 2);
      const Le = half * q1;
      this.fillArmFromEdge(g, cx, cy, entry, Le, t);
      const [ex0, ey0] = point(entry, half); // the cell edge
      const [ex1, ey1] = point(entry, half - Le); // the advancing front
      this.flowAlong(g, ex0, ey0, ex1, ey1, dark, lite, t, ph); // edge -> front (inflow)
      if (p >= 0.5) {
        hubWet = true;
        g.fillRect(cx - t / 2, cy - t / 2, t, t);
        const Lx = half * (p - 0.5) * 2;
        for (const ex of exits) {
          this.fillArmFromHub(g, cx, cy, ex, Lx, t);
          const [fx, fy] = point(ex, Lx);
          this.flowAlong(g, cx, cy, fx, fy, dark, lite, t, ph + ex * 0.11); // hub -> front
        }
      }
    }
    if (hubWet) {
      g.fillStyle(dark, 0.28); // textured core, matches a settled tile
      g.fillCircle(cx, cy, t * 0.34);
    }
  }

  /** Drifting poo specks flowing from A to B (used to animate the filling part of a tile). */
  private flowAlong(g: G, ax: number, ay: number, bx: number, by: number, dark: number, lite: number, t: number, ph: number): void {
    for (let k = 0; k < 2; k++) {
      const f = (this.clock / 1400 + ph + k * 0.5) % 1;
      const a = Math.sin(f * Math.PI) * 0.5; // fade in at A, out at B (the front)
      if (a <= 0.03) continue;
      g.fillStyle(k === 0 ? lite : dark, a);
      g.fillCircle(ax + (bx - ax) * f, ay + (by - ay) * f, t * 0.26);
    }
  }

  private fillArmFromHub(g: G, cx: number, cy: number, side: Side, len: number, t: number): void {
    if (side === Side.N) g.fillRect(cx - t / 2, cy - len, t, len);
    else if (side === Side.S) g.fillRect(cx - t / 2, cy, t, len);
    else if (side === Side.W) g.fillRect(cx - len, cy - t / 2, len, t);
    else g.fillRect(cx, cy - t / 2, len, t);
  }

  private fillArmFromEdge(g: G, cx: number, cy: number, side: Side, len: number, t: number): void {
    const half = CELL / 2;
    if (side === Side.N) g.fillRect(cx - t / 2, cy - half, t, len);
    else if (side === Side.S) g.fillRect(cx - t / 2, cy + half - len, t, len);
    else if (side === Side.W) g.fillRect(cx - half, cy - t / 2, len, t);
    else g.fillRect(cx + half - len, cy - t / 2, len, t);
  }

  private drawLeak(g: G): void {
    const pulse = 0.5 + 0.5 * Math.sin(this.clock / 90);
    const reach = CELL * (0.5 + 0.4 * pulse);
    for (const leak of this.model.leaks) {
      const cx = leak.from.col * CELL + CELL / 2;
      const cy = this.rowScreenY(leak.from.row) + CELL / 2;
      let dx = 0;
      let dy = 0;
      if (leak.out === Side.N) dy = -reach;
      else if (leak.out === Side.S) dy = reach;
      else if (leak.out === Side.W) dx = -reach;
      else dx = reach;
      g.fillStyle(COLORS.leak, 0.85);
      g.fillCircle(cx + dx * 0.6, cy + dy * 0.6, CELL * 0.16);
      g.fillCircle(cx + dx, cy + dy, CELL * 0.12 * (0.6 + pulse * 0.6));
      g.fillStyle(COLORS.leak, 0.45);
      g.fillCircle(cx + dx * 1.25, cy + dy * 1.25, CELL * 0.1);
    }
  }

  /** Always-on, subtle white "lay the next piece here" hints on the build frontier
   *  (including the very first cell under the toilet). Cells that are actively
   *  leaking are skipped — those get the loud gold markers instead. */
  private drawBuildHints(): void {
    const leakSet = new Set(this.model.leakTargets.map((c) => `${c.row},${c.col}`));
    const onScreen = (y: number) => y >= HUD_H - CELL && y <= this.pondTop;
    // the SVG points NORTH; rotate it to point the way the pipe extends, then march
    // 3 of them in that direction (fading) like the plughole's concentric rings
    const ROT: Record<number, number> = {
      [Side.N]: 0,
      [Side.E]: Math.PI / 2,
      [Side.S]: Math.PI,
      [Side.W]: -Math.PI / 2,
    };
    const VEC: Record<number, [number, number]> = {
      [Side.N]: [0, -1],
      [Side.S]: [0, 1],
      [Side.E]: [1, 0],
      [Side.W]: [-1, 0],
    };
    for (const { cell: t, dir } of this.model.buildFrontier) {
      if (leakSet.has(`${t.row},${t.col}`)) continue;
      const y = this.rowScreenY(t.row);
      if (!onScreen(y)) continue;
      const cx = t.col * CELL + CELL / 2;
      const cy = y + CELL / 2;
      const [vx, vy] = VEC[dir];
      for (let k = 0; k < 3; k++) {
        const phase = (this.clock / 850 + k / 3) % 1;
        const a = Math.sin(phase * Math.PI) * 0.9; // fade IN at the back, out at the front
        if (a <= 0.03) continue;
        const off = (phase - 0.5) * CELL * 0.6; // marches along the connect direction
        // high z-order so the hint sits on top of clogs / fatbergs in the way
        this.useSprite("hint", cx + vx * off, cy + vy * off, CELL * 0.4, Z_UI_SPRITE + 2, ROT[dir], {
          alpha: a,
        });
      }
    }
  }

  private drawLeakTarget(g: G): void {
    const pulse = 0.5 + 0.5 * Math.sin(this.clock / 140);
    const onScreen = (y: number) => y >= HUD_H - CELL && y <= this.pondTop;
    // build-here markers (gold) on empty cells that cap a leak
    for (const target of this.model.leakTargets) {
      const x = target.col * CELL;
      const y = this.rowScreenY(target.row);
      if (!onScreen(y)) continue;
      g.lineStyle(3 + 2 * pulse, COLORS.current, 0.5 + 0.5 * pulse);
      g.strokeRoundedRect(x + 5, y + 5, CELL - 10, CELL - 10, 8);
      const cx = x + CELL / 2;
      const cy = y + CELL / 2;
      g.fillStyle(COLORS.current, 0.5 + 0.4 * pulse);
      const s = CELL * 0.16;
      g.fillTriangle(cx - s, cy - s * 0.5, cx + s, cy - s * 0.5, cx, cy + s * 0.8);
    }
    // replace-here markers (red) on bursting tiles with no buildable escape
    for (const burst of this.model.burstTiles) {
      const x = burst.col * CELL;
      const y = this.rowScreenY(burst.row);
      if (!onScreen(y)) continue;
      g.lineStyle(3 + 2 * pulse, COLORS.dividend, 0.6 + 0.4 * pulse);
      g.strokeRoundedRect(x + 4, y + 4, CELL - 8, CELL - 8, 8);
    }
  }

  /**
   * A Mario-Kart-style item box on the ground — bobbing, glinting, colour-coded
   * (green = build through it, red = avoid) with the power icon floating inside.
   */
  private drawPowerMarker(g: G, cx: number, cy: number, power: PowerType, mag = 1): void {
    const col = COLORS.speed; // the faucet speeds the flow up
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

    // the tap pulses so it draws the eye (no sweeping glint line)
    const pulse = 1 + 0.12 * Math.sin(this.clock / 200);
    this.drawPowerBadge(g, cx, py - s * 0.18, power, s * 0.72 * pulse, Z_GRID_SPRITE + 1);
    // how much it speeds the flow up: 2x / 3x / 4x
    this.useLabel(`${mag}x`, cx, py + s * 0.62, Z_GRID_SPRITE + 2, 13);
  }

  /** A pooled text label positioned at a world point (e.g. a faucet's 2x/3x/4x tag). */
  private useLabel(text: string, x: number, y: number, depth: number, fontPx: number): void {
    let t = this.labels[this.labelIdx];
    if (!t) {
      t = this.add
        .text(0, 0, "", { fontFamily: ARCADE_FONT, color: "#ffffff", stroke: "#06101a", strokeThickness: 4 })
        .setOrigin(0.5);
      this.labels[this.labelIdx] = t;
    }
    this.labelIdx++;
    t.setText(text).setFontSize(fontPx).setPosition(x, y).setDepth(depth).setVisible(true);
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

  /** The "next pipe" item box — static, top-left (no bobbing). */
  private renderQueue(g: G): void {
    const m = this.model;
    this.reelGfx.clear(); // masked reel layer — redrawn only while spinning
    this.reelGfx.clearMask(); // default: no mask (no per-frame stencil cost when idle)
    if (m.state === "WON" || m.state === "GAMEOVER") return; // hide once the level's over

    const front = m.currentPiece;
    if (front !== this.prevFront) {
      this.prevFront = front;
      this.rouletteStart = this.clock; // new pipe -> spin the reel
    }
    if (!front) return;
    const age = this.clock - this.rouletteStart;
    const spinning = age < ROULETTE_MS;

    const box = 92;
    const cy = box / 2 + 10; // fixed at the top
    // sits top-left, but slides to the right when you're building behind it
    const left = box / 2 + 10;
    const right = GAME_WIDTH - box / 2 - 10;
    const fx = m.buildCol * CELL + CELL / 2;
    const fy = this.rowScreenY(m.buildRow) + CELL / 2;
    const behind = fx < box + 28 && fy < box + 28;
    const targetX = behind ? right : left;
    if (this.boxX === 0) this.boxX = targetX; // snap on first frame
    this.boxX += (targetX - this.boxX) * 0.12; // glide aside
    const cx = this.boxX;

    // rainbow only while the reel spins; a steady gold frame at rest
    const hue = spinning ? this.clock / 90 : 0.13;
    this.drawItemBox(g, cx, cy, box, hue);

    const glyph = box * 0.72;
    if (spinning) {
      // a fruit-machine reel: full-size symbols slide UP a full slot at a time,
      // CLIPPED at the window rim (via the mask), decelerating onto the target.
      const inner = box - 12;
      this.reelMaskG.clear();
      this.reelMaskG.fillStyle(0xffffff, 1);
      this.reelMaskG.fillRoundedRect(cx - inner / 2, cy - inner / 2, inner, inner, 10);
      this.reelGfx.setMask(this.reelMask); // clip the sliding symbols, only while spinning

      const sh = box; // one symbol per slot — clean slivers at the edges
      const eased = 1 - Math.pow(1 - age / ROULETTE_MS, 3); // ease-out = momentum
      const s = ROULETTE_REEL * (1 - eased); // scroll position, slows to 0 (the target)
      for (let i = Math.floor(s) - 1; i <= Math.floor(s) + 1; i++) {
        if (i < 0) continue;
        const dy = (s - i) * sh; // i==s -> centred; the target (i=0) rises from below
        const type = i === 0 ? front.type : ROULETTE_PIECES[(i * 5) % ROULETTE_PIECES.length];
        this.drawPipeGlyph(this.reelGfx, cx, cy + dy, PIECE_OPENINGS[type], glyph);
      }
    } else {
      // the reel already left the piece centred at full size — just rest there
      this.drawPipeGlyph(g, cx, cy, PIECE_OPENINGS[front.type], glyph);
      if (front.dynamite) this.drawDynamiteBadge(g, cx, cy, glyph);
    }
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

    // the level's own fish: live ones swim, the dead float belly-up at the surface
    const cleanH = POND_H - shitH;
    const total = this.model.fishCount;
    const kinds = this.model.fishKinds;
    const dead = this.model.fishDead; // >0 only once the pond is past half-full
    const span = GAME_WIDTH + 80;
    const bandTop = y0 + 26; // live fish swim BELOW the surface, leaving the top for floaters
    const bandBot = y0 + Math.max(40, cleanH - 10);
    for (let i = 0; i < total; i++) {
      const kind = kinds[i] ?? 0;
      if (i < dead) {
        // dead — bob lifelessly right at the surface
        const fx = 24 + ((i * 67) % (GAME_WIDTH - 48));
        const fy = y0 + 9 + Math.sin(this.clock / 360 + i) * 1.5;
        this.drawFish(g, fx, fy, i % 2 ? 1 : -1, kind, true);
      } else {
        const dir = hash3(i, 5, 1) > 0.5 ? 1 : -1; // some swim left, some right
        const speed = (0.018 + hash3(i, 2, 3) * 0.022) * dir; // px per ms
        const fx = (((hash3(i, 9, 2) * span + this.clock * speed) % span) + span) % span - 40;
        const fy = bandTop + hash3(i, 4, 7) * (bandBot - bandTop) + Math.sin(this.clock / 500 + i * 2) * 4;
        this.drawFish(g, fx, fy, dir, kind, false);
      }
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
    // dead fish use the greyscale sprite, belly-up; live fish use their species colour
    const key = dead ? "fish-dead" : `fish-${(kind % 5) + 1}`;
    const sz = 30 + (kind % 3) * 7; // species vary in size
    if (this.useSprite(key, cx, cy, sz, Z_UI_SPRITE + 1, 0, { flipX: dir < 0, flipY: dead })) return;
    // fallback: a simple coloured ellipse
    const color = dead ? COLORS.fishDead : FISH_COLORS[kind % FISH_COLORS.length];
    g.fillStyle(color, dead ? 0.92 : 1);
    g.fillEllipse(cx, cy, sz * 0.9, sz * 0.5);
    g.fillTriangle(cx - sz * 0.42 * dir, cy, cx - sz * 0.75 * dir, cy - sz * 0.25, cx - sz * 0.75 * dir, cy + sz * 0.25);
  }

  // ---- HUD -------------------------------------------------------------------

  private renderHud(_g: G): void {
    const m = this.model;
    // level + live score (purity banked + this level's remaining) + fish count
    this.statusText.setText(`LEVEL ${m.level}\nSCORE ${m.runScore + m.levelScore}\nFISH ${m.fishAlive}`);
    this.fpsText.setText(`${Math.round(this.game.loop.actualFps)} fps`);

    if (m.state === "WON" || m.state === "GAMEOVER") return; // the end dialog owns the text

    this.centerText.setPosition(GAME_WIDTH / 2, this.pondTop / 2);
    if (m.state === "COUNTDOWN") {
      // only count down once the run has actually begun (first pipe under the toilet)
      this.centerText.setText(m.started ? `FLOW IN ${Math.ceil(m.countdownRemaining / 1000)}` : "");
    } else if (m.state === "FLOWING") {
      this.centerText.setText(m.leaking ? "LEAK!" : "");
    } else {
      this.centerText.setText("");
    }
  }

  /** Modal end-of-level card with the fish tally and a single button to continue. */
  private renderEndDialog(g: G): void {
    const m = this.model;
    if (m.state !== "WON" && m.state !== "GAMEOVER") {
      this.endButton = null;
      this.buttonText.setVisible(false);
      return;
    }
    const won = m.state === "WON";
    const accent = won ? COLORS.protest : COLORS.dividend;

    g.fillStyle(0x05070c, 0.62); // dim the whole screen so it reads as modal
    g.fillRect(0, 0, GAME_WIDTH, this.viewH);

    const pw = 400;
    const ph = 300;
    const px = GAME_WIDTH / 2 - pw / 2;
    const py = this.viewH / 2 - ph / 2;
    g.fillStyle(0x12100e, 0.97);
    g.fillRoundedRect(px, py, pw, ph, 18);
    g.lineStyle(3, accent, 0.95);
    g.strokeRoundedRect(px, py, pw, ph, 18);

    const title = won ? "POND SAVED!" : "POND POLLUTED";
    const tally = won
      ? `${m.fishAlive} FISH RESCUED\n+${m.levelScore} POINTS\nSCORE: ${m.runScore}`
      : `${m.fishCount} FISH DIED\n${m.levelScore} POINTS LOST\nSCORE: ${m.runScore}`;
    this.centerText.setPosition(GAME_WIDTH / 2, py + 86).setText(`${title}\n\n${tally}`);

    const bw = 240;
    const bh = 58;
    const bx = GAME_WIDTH / 2 - bw / 2;
    const by = py + ph - bh - 28;
    g.fillStyle(accent, 0.95);
    g.fillRoundedRect(bx, by, bw, bh, 12);
    this.endButton = { x: bx, y: by, w: bw, h: bh };
    this.buttonText
      .setPosition(GAME_WIDTH / 2, by + bh / 2)
      .setText(won ? "NEXT LEVEL" : "TRY AGAIN")
      .setVisible(true);
  }
}
