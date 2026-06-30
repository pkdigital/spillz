import Phaser from "phaser";

// Shared retro/Llamatron UI bits used by both the title screen and the in-game
// modal cards, so the "throbbing neon button" looks identical everywhere.

/** Saturated neon palette, hue-cycled for that "everything throbs" arcade feel. */
export const NEON = [0xff2d95, 0x00f6ff, 0xfff200, 0x39ff14, 0xff7b00, 0xb026ff];

/** 0xRRGGBB number -> "#rrggbb" string for Text styles. */
export function hex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}

/**
 * Draw a primary action button that pulses (white glow) and cycles through the
 * neon palette. The caller positions the label text itself; this only paints the
 * fill + glow frame. `clock` is the scene's running ms timer.
 */
export function drawFlashButton(
  g: Phaser.GameObjects.Graphics,
  clock: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 12,
): void {
  const glow = 0.6 + Math.sin(clock / 200) * 0.4;
  const accent = NEON[Math.floor(clock / 350) % NEON.length];
  g.fillStyle(accent, 1);
  g.fillRoundedRect(x, y, w, h, radius);
  g.lineStyle(3, 0xffffff, glow);
  g.strokeRoundedRect(x - 4, y - 4, w + 8, h + 8, radius + 2);
}
