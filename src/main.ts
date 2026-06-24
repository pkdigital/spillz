import Phaser from "phaser";
import { GameScene, GAME_WIDTH, GAME_HEIGHT } from "./scenes/GameScene";

// Size the canvas to the device's aspect ratio so FIT doesn't pad it with black
// letterbox bars on tall phones. Width stays fixed (the 7 columns); the extra
// height just shows more grid above the pond (which is pinned to the bottom).
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
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [GameScene],
});

window.addEventListener("resize", () => game.scale.setGameSize(GAME_WIDTH, fitHeight()));
