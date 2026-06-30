import Phaser from "phaser";
import { GameScene, GAME_WIDTH, GAME_HEIGHT } from "./scenes/GameScene";
import { TitleScene } from "./scenes/TitleScene";

// Match the game's height to the device aspect so a tall phone shows more grid above the pond
// (width stays fixed at the 7 columns). On desktop this is just GAME_HEIGHT.
function fitHeight(): number {
  const aspect = window.innerHeight / window.innerWidth;
  return Math.max(GAME_HEIGHT, Math.round(GAME_WIDTH * aspect));
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#0b1020",
  width: GAME_WIDTH,
  height: fitHeight(),
  scale: {
    // FIT preserves the aspect ratio and scales the board up to fill the viewport (letterboxed
    // on the sides for a portrait board on a wide screen); CENTER_BOTH keeps it centred.
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [TitleScene, GameScene],
});

window.addEventListener("resize", () => game.scale.setGameSize(GAME_WIDTH, fitHeight()));
