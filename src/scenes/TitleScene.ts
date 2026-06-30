import Phaser from "phaser";
import { GAME_WIDTH } from "./GameScene";
import { addScore, loadScores, qualifies, type HighScore } from "../core/highscores";
import { NEON, hex, drawFlashButton } from "./ui";

const ARCADE_FONT = "'Press Start 2P', monospace";

interface Star {
  x: number;
  y: number;
  z: number; // depth -> speed + brightness
}
interface Drifter {
  x: number;
  y: number;
  vx: number;
  size: number;
  hue: number;
  fish: boolean; // fish swim, sewage blobs bob upward
}

type Mode = "menu" | "entry";
// icons drawn procedurally (no in-game asset exists for these — they're Graphics in-game too)
type ProcKind = "pipe" | "source" | "dynamite" | "spill";

// the real game assets we show in the instructions (keys match GameScene's preload)
const JUNK_KEYS = ["wet-wipes", "cotton-buds", "condom", "sanitary-pad"] as const;

interface TitleData {
  pendingScore?: number;
  pendingLevel?: number;
}

// auto-scroll feel
const SCROLL_SPEED = 34; // px/s — a gentle, readable continuous crawl
const RESUME_AFTER = 4000; // ms of no touch before auto-scroll takes back over

export class TitleScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private ui!: Phaser.GameObjects.Graphics;
  private clock = 0;

  private stars: Star[] = [];
  private drifters: Drifter[] = [];

  // text pool (fixed chrome only — scrolling instructions live in the container)
  private titleLayers: Phaser.GameObjects.Text[] = [];
  private texts: Record<string, Phaser.GameObjects.Text> = {};

  private mode: Mode = "menu";
  private scores: HighScore[] = [];
  private newRank = -1; // index of the freshly-added entry to highlight

  // initials entry state
  private pendingScore = 0;
  private pendingLevel = 1;
  private initials = ["A", "A", "A"];
  private slot = 0;

  // scrolling instructions panel (seamless continuous loop — two stacked copies)
  private scrollC: Phaser.GameObjects.Container | null = null;
  private maskShape: Phaser.GameObjects.Graphics | null = null;
  private scoreTexts: Phaser.GameObjects.Text[] = [];
  private viewportTop = 0;
  private viewportH = 0;
  private loopH = 0; // one content copy + the gap before the next copy
  private scrollY = 0; // continuous offset, wrapped by loopH
  private userUntil = 0; // suppress auto-scroll until this clock time

  // pointer / drag
  private dragStartY: number | null = null;
  private dragStartScroll = 0;
  private dragging = false;
  private dragMoved = false;
  private pressingPlay = false;

  // hit rects rebuilt each frame; tapped in pointer handlers
  private playBtn: Phaser.Geom.Rectangle | null = null;
  private okBtn: Phaser.Geom.Rectangle | null = null;
  private arrowBtns: { rect: Phaser.Geom.Rectangle; slot: number; dir: number }[] = [];

  constructor() {
    super("TitleScene");
  }

  // Load the SAME art the game uses, so the instructions show the real tiles. A 404 is
  // harmless (we guard every add.image with textures.exists). Keys match GameScene.
  preload(): void {
    this.load.on("loaderror", () => {});
    for (const j of JUNK_KEYS) this.load.svg(`junk-${j}`, `assets/junk/${j}.svg`, { width: 72, height: 72 });
    this.load.image("power-faucet", "assets/power/faucet.png");
    this.load.svg("power-fist", "assets/power/fist.svg", { width: 128, height: 128 });
    this.load.image("power-star", "assets/power/star.png");
    this.load.image("power-snowflake", "assets/power/snowflake.png");
    this.load.image("power-poison", "assets/power/poison.png");
    this.load.image("power-rain", "assets/power/rain.png");
    this.load.image("power-blitz", "assets/power/lightning.png");
    this.load.svg("fatberg", "assets/decor/fatberg.svg", { width: 200, height: 200 });
    this.load.svg("rock", "assets/decor/rock.svg", { width: 128, height: 128 });
    this.load.svg("fish-1", "assets/decor/fish-1.svg", { width: 96, height: 96 });
  }

  create(data?: TitleData): void {
    this.clock = 0;
    this.scores = loadScores();
    this.cameras.main.setBackgroundColor("#000000");
    // Phaser reuses the scene instance across scene.start — drop stale (destroyed) refs.
    this.texts = {};
    this.titleLayers = [];
    this.playBtn = null;
    this.okBtn = null;
    this.arrowBtns = [];
    this.destroyScroll();

    this.bg = this.add.graphics().setDepth(0);
    this.ui = this.add.graphics().setDepth(5);

    // starfield + drifting critters
    this.stars = Array.from({ length: 70 }, () => ({
      x: Math.random() * GAME_WIDTH,
      y: Math.random() * this.viewH,
      z: 0.2 + Math.random() * 0.8,
    }));
    this.drifters = Array.from({ length: 7 }, (_, i) => this.spawnDrifter(i % 2 === 0));

    // chromatic title layers (cyan/magenta ghosts behind a white core)
    this.titleLayers = [0x00f6ff, 0xff2d95, 0xffffff].map((c) =>
      this.add
        .text(0, 0, "SPILLZ", { fontFamily: ARCADE_FONT, fontSize: "52px", color: hex(c) })
        .setOrigin(0.5)
        .setDepth(10),
    );

    const mk = (key: string, size: number, color: string, depth = 10) => {
      this.texts[key] = this.add
        .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: `${size}px`, color, align: "center", lineSpacing: 7 })
        .setOrigin(0.5)
        .setDepth(depth);
    };
    mk("tagline", 11, "#00f6ff");
    mk("playLabel", 16, "#000000", 12);
    mk("entryHead", 14, "#fff200");
    mk("entrySub", 10, "#00f6ff");
    mk("okLabel", 14, "#000000", 12);
    mk("hint", 9, "#7a7f88");

    this.mode = "menu";
    this.newRank = -1;
    const pending = data?.pendingScore ?? 0;
    if (pending > 0 && qualifies(pending)) {
      this.mode = "entry";
      this.pendingScore = pending;
      this.pendingLevel = data?.pendingLevel ?? 1;
      this.initials = ["A", "A", "A"];
      this.slot = 0;
    } else {
      this.buildScroll();
    }

    this.input.on("pointerdown", this.onDown, this);
    this.input.on("pointermove", this.onMove, this);
    this.input.on("pointerup", this.onUp, this);
    this.setupKeyboard();
  }

  private spawnDrifter(fish: boolean): Drifter {
    const fromLeft = Math.random() < 0.5;
    return {
      x: fromLeft ? -40 : GAME_WIDTH + 40,
      y: 60 + Math.random() * Math.max(120, this.viewH - 120),
      vx: (fromLeft ? 1 : -1) * (12 + Math.random() * 26),
      size: 14 + Math.random() * 18,
      hue: Math.floor(Math.random() * NEON.length),
      fish,
    };
  }

  private get viewH(): number {
    return this.scale.gameSize.height;
  }

  // ----------------------------------------------- scrolling instructions ----
  private destroyScroll(): void {
    this.scrollC?.destroy(true); // destroys child gfx + texts
    this.maskShape?.destroy();
    this.scrollC = null;
    this.maskShape = null;
    this.scoreTexts = [];
  }

  /** Build the instructions filmstrip — two stacked copies of centred content so the
   *  auto-scroll loops seamlessly (never jumps) — and mask it to a viewport. */
  private buildScroll(): void {
    this.destroyScroll();
    const H = this.viewH;
    const cx = GAME_WIDTH / 2;
    const ty = Math.min(96, H * 0.1);
    this.viewportTop = ty + 76; // below the tagline
    const playTop = H - 60 - 40; // PLAY button top (bh 60 + margin 40)
    this.viewportH = Math.max(140, playTop - 24 - this.viewportTop);

    const c = this.add.container(0, this.viewportTop).setDepth(2);
    this.scrollC = c;
    const g = this.add.graphics();
    c.add(g);
    this.scoreTexts = [];

    const rows = this.scores
      .map((h, i) => {
        const rank = String(i + 1).padStart(2, " ");
        const name = h.name.padEnd(3, " ");
        const sc = String(h.score).padStart(6, " ");
        const mark = i === this.newRank ? " <" : "";
        return `${rank} ${name} ${sc}  L${h.level}${mark}`;
      })
      .join("\n");

    // build ONE copy of the content starting at local baseY; returns its height
    const addContent = (baseY: number): number => {
      let ly = 0;
      const header = (text: string, color: string) => {
        ly += 24;
        const t = this.add
          .text(cx, baseY + ly, text, { fontFamily: ARCADE_FONT, fontSize: "15px", color, align: "center" })
          .setOrigin(0.5, 0);
        c.add(t);
        ly += t.height + 16;
      };
      // a centred row: icon (real image or procedural glyph) above centred text
      const item = (text: string, opts: { img?: string; proc?: ProcKind; color?: number }) => {
        ly += 8;
        const box = 44;
        const iconCy = baseY + ly + box / 2;
        let placed = false;
        if (opts.img && this.textures.exists(opts.img)) {
          const img = this.add.image(cx, iconCy, opts.img);
          img.setScale(box / Math.max(img.width, img.height));
          c.add(img);
          placed = true;
        }
        if (!placed && opts.proc) this.drawProcIcon(g, opts.proc, cx, iconCy, 38, opts.color ?? 0xffffff);
        ly += box + 12;
        const t = this.add
          .text(cx, baseY + ly, text, {
            fontFamily: ARCADE_FONT,
            fontSize: "10px",
            color: "#dfe6e0",
            align: "center",
            lineSpacing: 6,
          })
          .setOrigin(0.5, 0);
        c.add(t);
        ly += t.height + 28; // generous gap between rows
      };

      header("HOW TO PLAY", "#fff200");
      header("DO", "#39ff14");
      item("LAY PIPE TO GUIDE\nTHE SEWAGE DOWN", { proc: "pipe" });
      item("IT POURS FROM\nTHE OUTLET", { proc: "source" });
      item("SAVE THE FISH\nIN THE POND", { img: "fish-1" });

      header("POWER TILES", "#3fd0ff");
      item("STAR\nBONUS SCORE", { img: "power-star" });
      item("FIST - PROTEST,\nHEALS THE RIVER", { img: "power-fist" });
      item("TAP\nSPEED UP OR DOWN", { img: "power-faucet" });
      item("FREEZE\nSTOPS THE FLOW", { img: "power-snowflake" });
      item("RAIN - HEALS BUT\nHIDES THE BOARD", { img: "power-rain" });
      item("BLITZ - SCATTERS\nFREE PIPE PIECES", { img: "power-blitz" });

      header("AVOID", "#ff2d95");
      item("SPILLS - OPEN ENDS\nLEAK FILTH", { proc: "spill", color: 0xff5c5c });
      item("POISON\nKILLS A FISH", { img: "power-poison" });
      item("WET WIPES\nCLOG THE PIPE", { img: "junk-wet-wipes" });
      item("COTTON BUDS\nUNFLUSHABLE", { img: "junk-cotton-buds" });
      item("CONDOM\nUNFLUSHABLE", { img: "junk-condom" });
      item("SANITARY PAD\nUNFLUSHABLE", { img: "junk-sanitary-pad" });
      item("FATBERG\nCLEAR WITH DYNAMITE", { img: "fatberg" });
      item("ROCK - IMPASSABLE", { img: "rock" });
      item("DYNAMITE - BLASTS\nROCKS & FATBERGS", { proc: "dynamite" });

      header("HIGH SCORES", "#fff200");
      const st = this.add
        .text(cx, baseY + ly, rows, {
          fontFamily: ARCADE_FONT,
          fontSize: "12px",
          color: "#e8e2d4",
          align: "left",
          lineSpacing: 7,
        })
        .setOrigin(0.5, 0);
      c.add(st);
      this.scoreTexts.push(st);
      ly += st.height + 40;
      return ly;
    };

    const h0 = addContent(0);
    this.loopH = h0; // the gap between copies IS the trailing spacing baked into h0
    addContent(h0); // second copy, one loop-length below — makes the wrap seamless

    // geometry mask clips the container to the viewport band
    const shape = this.make.graphics();
    shape.fillStyle(0xffffff);
    shape.fillRect(0, this.viewportTop, GAME_WIDTH, this.viewportH);
    this.maskShape = shape;
    c.setMask(shape.createGeometryMask());

    this.scrollY = 0;
    this.userUntil = 0;
  }

  /** Continuous one-direction loop — content slides up forever and wraps seamlessly. */
  private updateScroll(dMs: number): void {
    if (!this.scrollC || this.loopH <= 0) return;
    const auto = this.clock >= this.userUntil && !this.dragging;
    if (auto) this.scrollY += (SCROLL_SPEED * dMs) / 1000;
    this.scrollY = ((this.scrollY % this.loopH) + this.loopH) % this.loopH;
    this.scrollC.y = this.viewportTop - this.scrollY;
  }

  // ---------------------------------------------------------------- input ----
  private setupKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.on("keydown", (e: KeyboardEvent) => {
      if (this.mode === "menu") {
        if (e.key === "Enter" || e.key === " ") this.startGame();
        else if (e.key === "ArrowDown") this.nudgeScroll(this.viewportH * 0.4);
        else if (e.key === "ArrowUp") this.nudgeScroll(-this.viewportH * 0.4);
        return;
      }
      // entry mode
      if (e.key === "Enter") {
        this.confirmEntry();
      } else if (e.key === "Backspace" || e.key === "ArrowLeft") {
        this.slot = Math.max(0, this.slot - 1);
      } else if (e.key === "ArrowRight") {
        this.slot = Math.min(2, this.slot + 1);
      } else if (e.key === "ArrowUp") {
        this.cycleSlot(this.slot, 1);
      } else if (e.key === "ArrowDown") {
        this.cycleSlot(this.slot, -1);
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        this.initials[this.slot] = e.key.toUpperCase();
        this.slot = Math.min(2, this.slot + 1);
      }
    });
  }

  private nudgeScroll(dy: number): void {
    this.scrollY += dy; // wrapped by updateScroll
    this.userUntil = this.clock + RESUME_AFTER;
  }

  private cycleSlot(slot: number, dir: number): void {
    const code = this.initials[slot].charCodeAt(0) - 65; // A=0
    const next = (code + dir + 26) % 26;
    this.initials[slot] = String.fromCharCode(65 + next);
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.mode === "entry") {
      if (this.okBtn && this.okBtn.contains(p.x, p.y)) {
        this.confirmEntry();
        return;
      }
      for (const a of this.arrowBtns) {
        if (a.rect.contains(p.x, p.y)) {
          this.slot = a.slot;
          this.cycleSlot(a.slot, a.dir);
          return;
        }
      }
      return;
    }
    // menu: start a potential drag or PLAY press
    this.pressingPlay = this.playBtn?.contains(p.x, p.y) ?? false;
    this.dragMoved = false;
    this.dragging = false;
    this.dragStartY = p.y;
    this.dragStartScroll = this.scrollY;
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.mode !== "menu" || this.dragStartY === null || !p.isDown) return;
    const dy = p.y - this.dragStartY;
    if (!this.dragMoved && Math.abs(dy) > 6) {
      this.dragMoved = true;
      // only drag-scroll if the gesture began inside the viewport band
      this.dragging = this.dragStartY >= this.viewportTop && this.dragStartY <= this.viewportTop + this.viewportH;
    }
    if (this.dragging) {
      this.scrollY = this.dragStartScroll - dy; // wrapped by updateScroll
      this.userUntil = this.clock + RESUME_AFTER;
    }
  }

  private onUp(p: Phaser.Input.Pointer): void {
    if (this.mode !== "menu") return;
    if (this.pressingPlay && !this.dragMoved && this.playBtn?.contains(p.x, p.y)) this.startGame();
    if (this.dragMoved) this.userUntil = this.clock + RESUME_AFTER; // give a flick time to settle
    this.dragging = false;
    this.dragStartY = null;
    this.pressingPlay = false;
  }

  private confirmEntry(): void {
    const name = this.initials.join("");
    this.scores = addScore(name, this.pendingScore, this.pendingLevel);
    this.newRank = this.scores.findIndex((h) => h.name === name && h.score === this.pendingScore);
    this.mode = "menu";
    this.buildScroll(); // now show the table (with the new entry) in the scroller
  }

  private startGame(): void {
    this.scene.start("GameScene");
  }

  // -------------------------------------------------------------- rendering --
  update(_t: number, dMs: number): void {
    const d = dMs / 1000;
    this.clock += dMs;
    this.bg.clear();
    this.ui.clear();
    this.arrowBtns = [];

    this.drawBackground(d);
    if (this.mode === "menu") {
      this.updateScroll(dMs);
      this.drawMenuChrome();
    } else {
      this.drawEntry();
    }
    this.drawScanlines();
  }

  private drawBackground(d: number): void {
    const g = this.bg;
    const H = this.viewH;
    const t = this.clock / 1000;
    g.lineStyle(1, 0x16203a, 1);
    for (let i = 0; i < 16; i++) {
      const y = ((i / 16 + ((t * 0.06) % (1 / 16))) % 1) * H;
      g.lineBetween(0, y, GAME_WIDTH, y);
    }
    for (let c = 0; c <= 8; c++) {
      const x = (c / 8) * GAME_WIDTH;
      g.lineBetween(x, 0, x, H);
    }

    for (const s of this.stars) {
      s.y += s.z * 40 * d;
      if (s.y > H) {
        s.y = 0;
        s.x = Math.random() * GAME_WIDTH;
      }
      const b = Math.floor(120 + s.z * 135);
      g.fillStyle((b << 16) | (b << 8) | b, 1);
      const r = s.z < 0.5 ? 1 : 2;
      g.fillRect(s.x, s.y, r, r);
    }

    for (const f of this.drifters) {
      f.x += f.vx * d;
      if (f.vx > 0 && f.x > GAME_WIDTH + 50) Object.assign(f, this.spawnDrifter(f.fish));
      if (f.vx < 0 && f.x < -50) Object.assign(f, this.spawnDrifter(f.fish));
      const col = NEON[(f.hue + Math.floor(this.clock / 200)) % NEON.length];
      if (f.fish) this.drawFish(g, f.x, f.y, f.size, f.vx < 0, col, 0.4);
      else this.drawBlob(g, f.x, f.y, f.size);
    }
  }

  private drawFish(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, flip: boolean, col: number, alpha = 0.85): void {
    const dir = flip ? -1 : 1;
    g.fillStyle(col, alpha);
    g.fillEllipse(x, y, s * 1.6, s);
    g.beginPath();
    g.moveTo(x - dir * s * 0.8, y);
    g.lineTo(x - dir * s * 1.5, y - s * 0.5);
    g.lineTo(x - dir * s * 1.5, y + s * 0.5);
    g.closePath();
    g.fillPath();
    g.fillStyle(0x000000, alpha);
    g.fillCircle(x + dir * s * 0.5, y - s * 0.1, s * 0.12);
  }

  private drawBlob(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number): void {
    g.fillStyle(0x6b5524, 0.5);
    g.fillCircle(x, y, s * 0.7);
    g.fillStyle(0x4a3a18, 0.5);
    g.fillCircle(x + s * 0.3, y - s * 0.2, s * 0.4);
  }

  /** Procedural icons for the few elements the game itself draws with Graphics (no asset):
   *  a pipe glyph, the sewer outlet, a dynamite stick, and a spill gush. */
  private drawProcIcon(g: Phaser.GameObjects.Graphics, kind: ProcKind, x: number, y: number, s: number, color: number): void {
    const r = s / 2;
    switch (kind) {
      case "pipe": {
        // a 4-way cross of grey tube, like the in-game pieces
        const t = s * 0.34;
        g.fillStyle(0x000000, 0.22);
        g.fillRoundedRect(x - t / 2 + 1.5, y - r + 2, t, s, 4);
        g.fillStyle(0x6b7280, 1);
        g.fillRoundedRect(x - t / 2, y - r, t, s, 4); // vertical arm
        g.fillRoundedRect(x - r, y - t / 2, s, t, 4); // horizontal arm
        g.fillStyle(0x9aa2af, 1);
        g.fillRect(x - t / 2 + 2, y - r, t * 0.3, s); // edge highlight
        g.fillRect(x - r, y - t / 2 + 2, s, t * 0.3);
        break;
      }
      case "source": {
        // concentric sewer-pipe mouth (matches GameScene's source draw)
        g.fillStyle(0x8b8f96, 1);
        g.fillCircle(x, y, r);
        g.fillStyle(0x6b7077, 1);
        g.fillCircle(x, y, r * 0.82);
        g.fillStyle(0x33373d, 1);
        g.fillCircle(x, y, r * 0.66);
        g.fillStyle(0x14171b, 1);
        g.fillCircle(x, y, r * 0.5);
        g.fillStyle(0x7a6a2e, 1);
        g.fillCircle(x, y + r * 0.12, r * 0.4); // sewage welling up
        break;
      }
      case "dynamite": {
        const u = s * 1.15;
        g.fillStyle(0xc0392b, 1);
        g.fillRoundedRect(x - u * 0.12, y - u * 0.22, u * 0.24, u * 0.44, 4);
        g.fillStyle(0x000000, 0.18);
        g.fillRect(x - u * 0.12, y - u * 0.02, u * 0.24, u * 0.05);
        g.fillStyle(0xe8c07a, 1);
        g.fillRect(x - u * 0.06, y - u * 0.13, u * 0.12, u * 0.09);
        const ex = x + u * 0.15;
        const ey = y - u * 0.32;
        g.lineStyle(2, 0x3a3a3a, 1);
        g.lineBetween(x, y - u * 0.22, ex, ey);
        g.fillStyle(0xffd24a, 1);
        g.fillCircle(ex, ey, 3.5);
        g.fillStyle(0xff7a1a, 0.85);
        g.fillCircle(ex, ey, 2);
        break;
      }
      case "spill": {
        g.fillStyle(0x3a3f47, 1);
        g.fillRoundedRect(x - r * 0.95, y - r * 0.45, r * 0.7, r * 0.9, 3); // broken pipe end
        g.fillStyle(color, 0.95);
        for (let i = 0; i < 6; i++) {
          const tt = i / 5;
          g.fillCircle(x - r * 0.15 + tt * r * 1.05, y - r * 0.35 + Math.sin(tt * 3) * r * 0.3 + tt * r * 0.5, r * 0.15);
        }
        break;
      }
    }
  }

  private drawScanlines(): void {
    const g = this.ui;
    g.fillStyle(0x000000, 0.16);
    for (let y = 0; y < this.viewH; y += 4) g.fillRect(0, y, GAME_WIDTH, 2);
    g.lineStyle(3, 0x00f6ff, 0.25);
    g.strokeRect(4, 4, GAME_WIDTH - 8, this.viewH - 8);
    // soft fades at the viewport edges so scrolling text dissolves rather than clips hard
    if (this.mode === "menu" && this.scrollC) {
      const fade = 18;
      g.fillStyle(0x000000, 0.55);
      g.fillRect(0, this.viewportTop, GAME_WIDTH, fade);
      g.fillRect(0, this.viewportTop + this.viewportH - fade, GAME_WIDTH, fade);
    }
  }

  private drawMenuChrome(): void {
    const cx = GAME_WIDTH / 2;
    const H = this.viewH;

    // hide the initials-entry widgets once we're back on the menu (e.g. after confirming a score)
    for (const k of ["entryHead", "entrySub", "okLabel", "slot0", "slot1", "slot2"]) this.texts[k]?.setVisible(false);

    // pulsing chromatic title
    const pulse = 1 + Math.sin(this.clock / 320) * 0.05;
    const ty = Math.min(96, H * 0.1);
    const wob = Math.sin(this.clock / 500) * 4;
    const offsets = [
      { dx: -3 + wob, dy: -3 },
      { dx: 3 - wob, dy: 3 },
      { dx: 0, dy: 0 },
    ];
    this.titleLayers.forEach((tl, i) => {
      tl.setVisible(true).setScale(pulse).setPosition(cx + offsets[i].dx, ty + offsets[i].dy);
    });
    this.show("tagline", cx, ty + 52, "STOP THE SEWAGE - SAVE THE FISH");

    // flash the freshly-set high-score row (both stacked copies)
    const flash = this.newRank >= 0 && Math.floor(this.clock / 250) % 2 ? "#fff200" : "#e8e2d4";
    for (const st of this.scoreTexts) st.setColor(flash);

    // PLAY button (bottom-anchored, throbbing)
    const bw = 240;
    const bh = 60;
    const bx = cx - bw / 2;
    const by = H - bh - 40;
    drawFlashButton(this.ui, this.clock, bx, by, bw, bh);
    this.playBtn = new Phaser.Geom.Rectangle(bx - 4, by - 4, bw + 8, bh + 8);
    this.texts["playLabel"].setVisible(true).setPosition(cx, by + bh / 2).setText("PLAY");
    this.show("hint", cx, by - 20, "TAP PLAY  -  SWIPE TO BROWSE");
  }

  private drawEntry(): void {
    const cx = GAME_WIDTH / 2;
    const H = this.viewH;
    this.texts["tagline"].setVisible(false);
    this.texts["playLabel"].setVisible(false);
    this.playBtn = null;

    const pulse = 1 + Math.sin(this.clock / 320) * 0.05;
    const ty = Math.min(80, H * 0.09);
    this.titleLayers.forEach((tl, i) => {
      tl.setVisible(true).setScale(pulse * 0.6).setPosition(cx + (i === 0 ? -2 : i === 1 ? 2 : 0), ty);
    });

    const midY = H * 0.42;
    this.show("entryHead", cx, midY - 90, "NEW HIGH SCORE!");
    this.show("entrySub", cx, midY - 56, `${this.pendingScore} PTS  -  REACHED LEVEL ${this.pendingLevel}`);

    const slotW = 70;
    const gap = 26;
    const totalW = slotW * 3 + gap * 2;
    const startX = cx - totalW / 2;
    for (let i = 0; i < 3; i++) {
      const sx = startX + i * (slotW + gap);
      const active = i === this.slot;
      const boxCol = active ? NEON[Math.floor(this.clock / 250) % NEON.length] : 0x16203a;
      this.ui.fillStyle(0x05070c, 1);
      this.ui.fillRoundedRect(sx, midY - 36, slotW, 72, 10);
      this.ui.lineStyle(3, boxCol, 1);
      this.ui.strokeRoundedRect(sx, midY - 36, slotW, 72, 10);

      const lt = this.slotText(i);
      lt.setVisible(true).setPosition(sx + slotW / 2, midY).setText(this.initials[i]);

      const ax = sx + slotW / 2;
      this.ui.fillStyle(0x39ff14, active ? 1 : 0.5);
      this.ui.fillTriangle(ax - 12, midY - 50, ax + 12, midY - 50, ax, midY - 64);
      this.ui.fillTriangle(ax - 12, midY + 50, ax + 12, midY + 50, ax, midY + 64);
      this.arrowBtns.push({ rect: new Phaser.Geom.Rectangle(sx, midY - 70, slotW, 30), slot: i, dir: 1 });
      this.arrowBtns.push({ rect: new Phaser.Geom.Rectangle(sx, midY + 40, slotW, 30), slot: i, dir: -1 });
    }

    const bw = 200;
    const bh = 54;
    const bx = cx - bw / 2;
    const by = midY + 110;
    drawFlashButton(this.ui, this.clock, bx, by, bw, bh);
    this.okBtn = new Phaser.Geom.Rectangle(bx, by, bw, bh);
    this.texts["okLabel"].setVisible(true).setPosition(cx, by + bh / 2).setText("ENTER");
    this.show("hint", cx, by + bh + 26, "ARROWS / TYPE  -  ENTER TO CONFIRM");
  }

  private slotText(i: number): Phaser.GameObjects.Text {
    const key = `slot${i}`;
    if (!this.texts[key]) {
      this.texts[key] = this.add
        .text(0, 0, "", { fontFamily: ARCADE_FONT, fontSize: "40px", color: "#39ff14" })
        .setOrigin(0.5)
        .setDepth(11);
    }
    return this.texts[key];
  }

  private show(key: string, x: number, y: number, text: string): void {
    this.texts[key].setVisible(true).setOrigin(0.5).setPosition(x, y).setText(text);
  }
}
