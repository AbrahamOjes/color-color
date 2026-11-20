# 3D race replay spike: exit report

Branch `spike-race-3d`, October 2026. Goal: decide whether a 3D race replay is viable on low-end phones.

## Verdict

**Passed.** The low tier held **60 fps (1% low 48.5)** on a budget Android with a Mali-G57 MC2 GPU, against a 30 fps target. Total download is **1.2–1.4 MB**, against a 15 MB budget. Every race finished in the on-chain order on every device tested.

Recommendation: commission full art. Run one more check on a true ~$100 phone (Mali-G52 class) before launch, not before art.

## Results

### Frame rate

Each figure covers one full replay: about 28 s, including the slow-motion finish.

| Device | GPU | Tier | Average fps | 1% low | Draw calls | Triangles |
|---|---|---|---|---|---|---|
| Budget Android | Mali-G57 MC2 | low | **60.1** | **48.5** | 4 | 5.0k |
| iPhone | Apple | low | 30.0 * | 26.9 | 4 | 5.0k |
| iPhone | Apple | full | 30.0 * | 28.0 | 6 | 17.1k |
| MacBook (Chrome) | Apple M4 | low | 60.0 | 59.5 | 4 | 5.0k |
| MacBook (Chrome) | Apple M4 | full | 60.0 | 59.5 | 6 | 17.1k |

\* iOS capped the page at 30 fps, probably because Low Power Mode or Limit Frame Rate was on. Both tiers hit the cap, so the iPhone's headroom is unknown, but it holds 30.

The Mali-G57 MC2 sits in roughly $120–200 phones, one step above the cheapest. With lows near 50 fps, a GPU about half as fast should still hold 30.

### Download size

Measured in Chrome on the production build with an empty cache. These are bytes on the wire for `/dev/race-replay`.

| | Full tier | Low tier |
|---|---|---|
| Whole page | 1.43 MB | 1.18 MB |
| 3D only (not loaded by the lobby) | 0.91 MB | 0.67 MB |
| — three.js + R3F + replay code | 287 KB | 287 KB |
| — Basis KTX2 transcoder (wasm + js) | 254 KB | 254 KB |
| — track + greyhound models and textures | 357 KB | 103 KB |
| Share of the 15 MB budget | 9.6% | 7.9% |

Measured before the last two fixes. Those changed each greyhound model by under 3 KB (now 29.5 KB full, 17.0 KB low, uncompressed).

Three.js loads only in the browser (`next/dynamic`, `ssr: false`), in its own chunk. The lobby and boards download none of it.

### Determinism

Vitest, `frontend/src/games/race/three/__tests__/`, 16 tests:

- **Same race at any frame rate:** at 30, 60 and 144 fps and on an irregular clock, every runner pose, gallop phase and camera is bit-identical at fixed timestamps.
- **Finish order:** in 200 random races, runners cross the drawn finish line in `finishingOrder`. This also holds for 8 runners.
- **Lanes:** neighbouring runners never overlap.
- **Time warp:** the slow-motion warp is continuous and never runs backwards.
- **Camera:** the five shots always cut in order, including on photo finishes.
- **Assets:** rerunning the asset script writes byte-identical files.

## What was built

- **Replay:** `Replay3D` takes the same props as the 2D `Replay` (`finishingOrder`, `replaySeed`, `skin`), so it can replace it. Positions come only from `timeline.ts`. Every frame is a pure function of wall-clock time, with no state carried between frames.
- **Camera director:** five scripted shots, chosen from race time alone:
  1. start, from the infield ahead of the traps;
  2. side tracking down the back straight;
  3. high angle at the bend;
  4. head-on down the home straight;
  5. slow-motion photo finish, tracking the leader to the line.
- **Runner:** one low-poly greyhound, drawn as a single instanced call for all runners. Jacket colour, stripes or hoops and the number are tinted in the shader. The gallop is animated in the vertex shader from distance travelled, so feet never slide.
- **Assets:** generated procedurally by `npm run assets:race3d`, with no Blender or system tools. The format is glTF with meshopt compression and KTX2 textures. Lighting is baked into the ground texture (sun, soft shadows, occlusion) and into the colours of the rails, stand and traps. The scene has no realtime lights.
- **Tiers:**
  - full: crowd and trees, antialiasing, up to 2× resolution;
  - low: simpler meshes, no crowd or trees, 1.5× resolution.

  The tier is auto-selected from device memory, CPU cores and a list of budget GPUs. A device on an auto-selected tier that averages under 30 fps drops to 1× resolution and less detail.
- **Test page:** `/dev/race-replay?order=…&seed=…&tier=auto|full|low`, not linked from the nav and marked noindex. It has an fps overlay and an optional 2D cross-check of the same race.
- **Measurement:** `npm run measure:race3d` drives Chrome to record download size and frame rate.

## Departures from the prompt

| Prompt said | Did | Why |
|---|---|---|
| Danfo or greyhound | Greyhound | Matches the launch skin, and a galloping animal is the harder test for 30 fps |
| `@react-three/drei` | Not used | Large dependency; three's own loaders and a small fps monitor covered the need |
| `@react-three/fiber` latest | 9.7.0 | 9.8.1 needed a `scheduler` release that couldn't be fetched on a slow network |
| Lightmaps | Lighting baked into the ground texture and vertex colours | One texture fetch instead of two; same visual result for a static scene |

## Bugs found and fixed during device testing

- **The fps overlay counted paused frames.** Frames after the finish, and the first frame (which included loading), dragged the average down. The first iPhone reading of 13.7 fps was this bug. Only race frames count now.
- **iPhones were forced onto the low tier.** Safari under-reports CPU cores, so an iPhone looked like a budget phone. Apple GPUs now skip the core-count rule.
- **The low tier was soft on high-density screens.** It rendered at 1×, a third of an iPhone's resolution. It now renders at 1.5×, and the runtime downgrade drops it back to 1× if needed.
- **Jacket numbers were garbled on the low-tier dog.** The jacket outline was stored per vertex, so the coarse mesh cut through the number. The shader now works out the jacket and number per pixel.

## Open items

- **True ~$100 Android (Mali-G52 class):** confirm the low tier holds 30 fps. If it doesn't, the 1× fallback is already built in.
- **`?tier=full` on the Mali-G57:** if it holds 30, the auto-selection rules can let mid-range phones have the full tier.
- **iPhone headroom:** rerun with Low Power Mode and Limit Frame Rate off.
- **Final art:**
  - a rigged runner model per skin;
  - real jacket and number art;
  - lean on the bends;
  - stand, crowd and signage.
- **Not built in this spike:** sound, commentary from the timeline, the WebGPU path, and wiring `Replay3D` into the race board.
- **Measurement script:** `measure.mjs` has the macOS Chrome path hard-coded.
- **Upstream warning:** fiber 9.7 logs a `THREE.Clock` deprecation warning. Upgrade when the registry allows.

## Reproducing

```
cd frontend
npm test                                  # determinism and order tests
npm run assets:race3d                     # rebuild public/race3d/ (byte-identical)
npm run build && npm start                # production server
npm run measure:race3d -- --base http://localhost:3000
```

On a phone on the same Wi-Fi, open `http://<mac-lan-ip>:3000/dev/race-replay?tier=auto` and read the overlay after a full race. Use the production server: the dev server blocks its scripts for any host other than `localhost`.
