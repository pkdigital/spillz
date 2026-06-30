import Phaser from "phaser";
import { GameScene, GAME_WIDTH, GAME_HEIGHT } from "./scenes/GameScene";
import { TitleScene } from "./scenes/TitleScene";

// Fixed-resolution render (the 7-column board); we stretch the canvas to fill the whole
// window below (Scale.NONE so Phaser doesn't impose its own aspect-preserving sizing).
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#0b1020",
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  scale: {
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene: [TitleScene, GameScene],
});

// Stretch the canvas edge-to-edge (distorting to fit on non-portrait screens). Phaser's pointer
// mapping divides by displayScale (gameSize / on-screen size), so we feed it the real display size
// and refresh the canvas bounds — that keeps taps landing on the right cell despite the stretch.
function stretchToWindow(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (game.canvas) {
    game.canvas.style.width = `${w}px`;
    game.canvas.style.height = `${h}px`;
  }
  game.scale.displaySize.setSize(w, h);
  game.scale.displayScale.set(GAME_WIDTH / w, GAME_HEIGHT / h);
  game.scale.updateBounds();
}

game.events.once("ready", stretchToWindow);
window.addEventListener("resize", stretchToWindow);
