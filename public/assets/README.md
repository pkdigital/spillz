# Assets

Placeholder art for Flowz. These are original SVGs (CC0 — safe to ship, replace
freely). To swap in final art, **keep the same filenames** and the game picks
them up automatically (loaded in `GameScene.preload()`).

```
public/assets/
  junk/      one icon per clog/unflushable (filename = JunkType in src/core/types.ts)
    condom.svg  wet-wipes.svg  cotton-buds.svg  oil.svg  fat.svg  sanitary-pad.svg
  power/     speed power-tile icons
    hare.svg (speed-up)   tortoise.svg (speed-down)
```

Notes:
- SVGs are rasterised at load (see the `load.svg(..., { width, height })` calls).
  For crisp final art, supply PNGs at ~2× the cell size, or bump the load size.
- Sourcing leads for richer art: **Kenney.nl** (CC0 packs), **game-icons.net**
  (CC-BY silhouettes, recolourable), **ambientCG/Poly Haven** (CC0 textures for
  soil/water). Avoid CC-BY-NC / GPL / unlicensed images for a store release.
- Pipes, sewage, the pond/fish, and dividend/protest badges are still drawn
  procedurally in `GameScene.ts`; they can move to sprites the same way later.
