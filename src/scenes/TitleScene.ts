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

interface TitleData {
  pendingScore?: number;
  pendingLevel?: number;
}

export class TitleScene extends Phaser.Scene {
  private bg!: Phaser.GameObjects.Graphics;
  private ui!: Phaser.GameObjects.Graphics;
  private clock = 0;

  private stars: Star[] = [];
  private drifters: Drifter[] = [];

  // text pool
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

  // hit rects rebuilt each frame; tapped in pointerdown
  private playBtn: Phaser.Geom.Rectangle | null = null;
  private okBtn: Phaser.Geom.Rectangle | null = null;
  private arrowBtns: { rect: Phaser.Geom.Rectangle; slot: number; dir: number }[] = [];

  constructor() {
    super("TitleScene");
  }

  create(data?: TitleData): void {
    this.clock = 0;
    this.scores = loadScores();
    this.cameras.main.setBackgroundColor("#000000");
    // Phaser reuses the scene instance across scene.start — drop stale (destroyed)
    // GameObject references before we recreate them all below.
    this.texts = {};
    this.titleLayers = [];
    this.playBtn = null;
    this.okBtn = null;
    this.arrowBtns = [];

    this.bg = this.add.graphics().setDepth(0);
    this.ui = this.add.graphics().setDepth(5);

    // starfield + drifting critters
    this.stars = Array.from({ length: 70 }, () => ({
      x: Math.random() * GAME_WIDTH,
      y: Math.random() * this.viewH,
      z: 0.2 + Math.random() * 0.8,
    }));
    this.drifters = Array.from({ length: 10 }, (_, i) => this.spawnDrifter(i % 2 === 0));

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
    mk("howHead", 13, "#fff200");
    mk("doHead", 11, "#39ff14");
    mk("doBody", 10, "#cfe8d0"); // body lines
    mk("avoidHead", 11, "#ff2d95");
    mk("avoidBody", 10, "#f0cdd8");
    mk("scoreHead", 13, "#fff200");
    mk("scoreBody", 12, "#e8e2d4");
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
    }

    this.input.on("pointerdown", this.onTap, this);
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

  // ---------------------------------------------------------------- input ----
  private setupKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    kb.on("keydown", (e: KeyboardEvent) => {
      if (this.mode === "menu") {
        if (e.key === "Enter" || e.key === " ") this.startGame();
        return;
      }
      // entry mode
      if (e.key === "Enter") {
        this.confirmEntry();
      } else if (e.key === "Backspace") {
        this.slot = Math.max(0, this.slot - 1);
      } else if (e.key === "ArrowLeft") {
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

  private cycleSlot(slot: number, dir: number): void {
    const code = this.initials[slot].charCodeAt(0) - 65; // A=0
    const next = (code + dir + 26) % 26;
    this.initials[slot] = String.fromCharCode(65 + next);
  }

  private onTap(p: Phaser.Input.Pointer): void {
    if (this.mode === "menu") {
      if (this.playBtn && this.playBtn.contains(p.x, p.y)) this.startGame();
      return;
    }
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
  }

  private confirmEntry(): void {
    const name = this.initials.join("");
    this.scores = addScore(name, this.pendingScore, this.pendingLevel);
    this.newRank = this.scores.findIndex((h) => h.name === name && h.score === this.pendingScore);
    this.mode = "menu";
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
    if (this.mode === "menu") this.drawMenu();
    else this.drawEntry();
    this.drawScanlines();
  }

  private drawBackground(d: number): void {
    const g = this.bg;
    const H = this.viewH;
    // perspective neon grid creeping upward (the Minter horizon)
    const t = this.clock / 1000;
    g.lineStyle(1, 0x16203a, 1);
    for (let i = 0; i < 16; i++) {
      const y = ((i / 16 + (t * 0.06) % (1 / 16)) % 1) * H;
      g.lineBetween(0, y, GAME_WIDTH, y);
    }
    for (let c = 0; c <= 8; c++) {
      const x = (c / 8) * GAME_WIDTH;
      g.lineBetween(x, 0, x, H);
    }

    // starfield
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

    // drifting neon fish + sewage blobs
    for (const f of this.drifters) {
      f.x += f.vx * d;
      if (f.vx > 0 && f.x > GAME_WIDTH + 50) Object.assign(f, this.spawnDrifter(f.fish));
      if (f.vx < 0 && f.x < -50) Object.assign(f, this.spawnDrifter(f.fish));
      const col = NEON[(f.hue + Math.floor(this.clock / 200)) % NEON.length];
      if (f.fish) this.drawFish(g, f.x, f.y, f.size, f.vx < 0, col);
      else this.drawBlob(g, f.x, f.y, f.size, col);
    }
  }

  private drawFish(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, flip: boolean, col: number): void {
    const dir = flip ? -1 : 1;
    g.fillStyle(col, 0.85);
    g.fillEllipse(x, y, s * 1.6, s);
    // tail
    g.beginPath();
    g.moveTo(x - dir * s * 0.8, y);
    g.lineTo(x - dir * s * 1.5, y - s * 0.5);
    g.lineTo(x - dir * s * 1.5, y + s * 0.5);
    g.closePath();
    g.fillPath();
    // eye
    g.fillStyle(0x000000, 1);
    g.fillCircle(x + dir * s * 0.5, y - s * 0.1, s * 0.12);
  }

  private drawBlob(g: Phaser.GameObjects.Graphics, x: number, y: number, s: number, _col: number): void {
    g.fillStyle(0x6b5524, 0.6);
    g.fillCircle(x, y, s * 0.7);
    g.fillStyle(0x4a3a18, 0.6);
    g.fillCircle(x + s * 0.3, y - s * 0.2, s * 0.4);
  }

  private drawScanlines(): void {
    const g = this.ui;
    g.fillStyle(0x000000, 0.16);
    for (let y = 0; y < this.viewH; y += 4) g.fillRect(0, y, GAME_WIDTH, 2);
    // vignette frame
    g.lineStyle(3, 0x00f6ff, 0.25);
    g.strokeRect(4, 4, GAME_WIDTH - 8, this.viewH - 8);
  }

  private hide(...keys: string[]): void {
    for (const k of keys) this.texts[k]?.setVisible(false);
  }

  private drawMenu(): void {
    const cx = GAME_WIDTH / 2;
    const H = this.viewH;
    this.hide("entryHead", "entrySub", "initials", "okLabel");

    // --- pulsing chromatic title ---
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

    // --- how to play ---
    let y = ty + 96;
    this.show("howHead", cx, y, "HOW TO PLAY");
    y += 30;
    this.show("doHead", cx, y, "DO");
    y += 22;
    this.show(
      "doBody",
      cx,
      y,
      "LAY PIPE TO GUIDE THE SEWAGE DOWN\nCONTAIN THE DUMP TO WIN THE LEVEL\nGRAB STAR + FIST POWER TILES",
    );
    y += 64;
    this.show("avoidHead", cx, y, "AVOID");
    y += 22;
    this.show(
      "avoidBody",
      cx,
      y,
      "SPILLS - OPEN ENDS LEAK FILTH\nCLOGS - WIPES, BUDS (DUMP OFF-PATH)\nDIVIDEND + POISON TILES",
    );

    // --- high score table ---
    y += 70;
    this.show("scoreHead", cx, y, "HIGH SCORES");
    y += 30;
    const rows = this.scores
      .map((h, i) => {
        const rank = String(i + 1).padStart(2, " ");
        const name = h.name.padEnd(3, " ");
        const sc = String(h.score).padStart(6, " ");
        const mark = i === this.newRank ? " <" : "";
        return `${rank} ${name} ${sc}  L${h.level}${mark}`;
      })
      .join("\n");
    this.texts["scoreBody"]
      .setVisible(true)
      .setAlign("left")
      .setOrigin(0.5, 0)
      .setPosition(cx, y)
      .setText(rows);
    // flash the freshly-set entry
    if (this.newRank >= 0) {
      this.texts["scoreBody"].setColor(Math.floor(this.clock / 250) % 2 ? "#fff200" : "#e8e2d4");
    } else {
      this.texts["scoreBody"].setColor("#e8e2d4");
    }

    // --- PLAY button (bottom-anchored, throbbing) ---
    const bw = 240;
    const bh = 60;
    const bx = cx - bw / 2;
    const by = H - bh - 40;
    drawFlashButton(this.ui, this.clock, bx, by, bw, bh);
    this.playBtn = new Phaser.Geom.Rectangle(bx - 4, by - 4, bw + 8, bh + 8);
    this.texts["playLabel"].setVisible(true).setPosition(cx, by + bh / 2).setText("PLAY");

    this.show("hint", cx, by - 20, "TAP PLAY OR PRESS ENTER");
  }

  private drawEntry(): void {
    const cx = GAME_WIDTH / 2;
    const H = this.viewH;
    this.hide(
      "tagline",
      "howHead",
      "doHead",
      "doBody",
      "avoidHead",
      "avoidBody",
      "scoreHead",
      "scoreBody",
      "playLabel",
    );
    this.playBtn = null;

    // small pulsing title up top
    const pulse = 1 + Math.sin(this.clock / 320) * 0.05;
    const ty = Math.min(80, H * 0.09);
    this.titleLayers.forEach((tl, i) => {
      tl.setVisible(true).setScale(pulse * 0.6).setPosition(cx + (i === 0 ? -2 : i === 1 ? 2 : 0), ty);
    });

    const midY = H * 0.42;
    this.show("entryHead", cx, midY - 90, "NEW HIGH SCORE!");
    this.show("entrySub", cx, midY - 56, `${this.pendingScore} PTS  -  REACHED LEVEL ${this.pendingLevel}`);

    // three glowing initial slots with up/down arrows
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

      // letter
      const lt = this.slotText(i);
      lt.setVisible(true).setPosition(sx + slotW / 2, midY).setText(this.initials[i]);

      // arrows (graphics triangles) + hit rects
      const ax = sx + slotW / 2;
      this.ui.fillStyle(0x39ff14, active ? 1 : 0.5);
      this.ui.fillTriangle(ax - 12, midY - 50, ax + 12, midY - 50, ax, midY - 64); // up
      this.ui.fillTriangle(ax - 12, midY + 50, ax + 12, midY + 50, ax, midY + 64); // down
      this.arrowBtns.push({ rect: new Phaser.Geom.Rectangle(sx, midY - 70, slotW, 30), slot: i, dir: 1 });
      this.arrowBtns.push({ rect: new Phaser.Geom.Rectangle(sx, midY + 40, slotW, 30), slot: i, dir: -1 });
    }

    // OK button
    const bw = 200;
    const bh = 54;
    const bx = cx - bw / 2;
    const by = midY + 110;
    drawFlashButton(this.ui, this.clock, bx, by, bw, bh);
    this.okBtn = new Phaser.Geom.Rectangle(bx, by, bw, bh);
    this.texts["okLabel"].setVisible(true).setPosition(cx, by + bh / 2).setText("ENTER");

    this.show("hint", cx, by + bh + 26, "ARROWS / TYPE  -  ENTER TO CONFIRM");
  }

  // reuse the three initials text objects by index (created lazily as initials slots)
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
