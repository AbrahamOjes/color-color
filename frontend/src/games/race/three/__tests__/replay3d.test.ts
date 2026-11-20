import { describe, expect, it } from "vitest";
import { type Hex } from "viem";
import { distanceAt, isPhotoFinish, seededRandom } from "../../timeline";
import { SHOTS } from "../director";
import { buildReplay, sceneAt } from "../replayModel";
import { laneOffset } from "../runners";
import { raceTimeAt } from "../timewarp";
import { BEND_RADIUS, FINISH_S, LAP, poseAtDistance, poseAtS, RACE_METRES, SECTION, STRAIGHT } from "../trackPath";

/// A deterministic stream of test inputs: (order, seed) pairs from a fixed master seed.
function cases(count: number, runners = 6): { order: number[]; seed: Hex }[] {
  const rand = seededRandom("0x5eed000000000000000000000000000000000000000000000000000000000001");
  const out: { order: number[]; seed: Hex }[] = [];
  for (let i = 0; i < count; i++) {
    const order = Array.from({ length: runners }, (_, r) => r);
    for (let j = runners - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      [order[j], order[k]] = [order[k], order[j]];
    }
    const words = Array.from({ length: 8 }, () => Math.floor(rand() * 2 ** 32).toString(16).padStart(8, "0"));
    out.push({ order, seed: `0x${words.join("")}` as Hex });
  }
  return out;
}

/// Wall-clock frame times a renderer at `fps` would produce, as Replay3D computes them:
/// `performance.now() − start`, never a running sum of deltas.
function frameTimes(fps: number, until: number): number[] {
  const times: number[] = [];
  for (let k = 0; k / fps <= until; k++) times.push(k / fps);
  return times;
}

const CHECKPOINTS = [0, 0.5, 1, 2, 5, 10, 15, 18, 20, 21, 22, 24, 26];

describe("determinism across frame rates", () => {
  for (const { order, seed } of cases(5)) {
    it(`order ${order.join("")} seed ${seed.slice(0, 10)}…`, () => {
      const reference = buildReplay(order, seed);
      const expected = CHECKPOINTS.map((w) => sceneAt(reference, w));

      // 30, 60 and 144 fps, plus an irregular frame clock. Each renderer draws every frame
      // in sequence on its own model; whatever it drew at a checkpoint must be bit-identical
      // to a fresh model asked directly for that moment.
      const jitterRand = seededRandom(seed);
      const jitter: number[] = [];
      for (let w = 0; w <= 27; w += 0.004 + 0.06 * jitterRand()) jitter.push(w);
      const clocks = [frameTimes(30, 27), frameTimes(60, 27), frameTimes(144, 27), [...jitter, ...CHECKPOINTS].sort((a, b) => a - b)];

      for (const clock of clocks) {
        const model = buildReplay(order, seed);
        const drawn = new Map<number, ReturnType<typeof sceneAt>>();
        for (const w of clock) {
          const state = sceneAt(model, w);
          if (CHECKPOINTS.includes(w)) drawn.set(w, state);
        }
        CHECKPOINTS.forEach((w, i) => {
          expect(drawn.has(w)).toBe(true);
          expect(drawn.get(w)).toStrictEqual(expected[i]);
        });
      }
    });
  }

  it("the same (order, seed) builds the same model twice", () => {
    const [{ order, seed }] = cases(1);
    expect(buildReplay(order, seed)).toStrictEqual(buildReplay(order, seed));
  });
});

describe("finishing order", () => {
  const finishX = -STRAIGHT / 2 + FINISH_S;

  it("race distance 1 is on the finish line in every lane", () => {
    for (let o = 0; o <= 9; o += 0.5) {
      const p = poseAtDistance(1, o);
      expect(p.x).toBeCloseTo(finishX, 9);
      expect(p.z).toBeCloseTo(BEND_RADIUS + o, 9);
      expect(p.yaw).toBe(0);
    }
  });

  it("runners cross the drawn finish line in finishingOrder (200 races)", () => {
    for (const { order, seed } of cases(200)) {
      const model = buildReplay(order, seed);
      const { timeline, lanes } = model;
      const crossing = Array.from({ length: timeline.runners }, (_, r) => {
        // Home straight: x grows with time, so bisect for the moment x reaches the line.
        const xAt = (t: number) => {
          const d = distanceAt(timeline, r, t);
          return poseAtDistance(d, laneOffset(lanes, r, d)).x;
        };
        const onStraight = (t: number) => distanceAt(timeline, r, t) * RACE_METRES >= SECTION.bendEnd;
        let lo = 0;
        let hi = timeline.duration;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (onStraight(mid) && xAt(mid) >= finishX) hi = mid;
          else lo = mid;
        }
        return hi;
      });
      const drawnOrder = crossing.map((t, r) => ({ t, r })).sort((a, b) => a.t - b.t).map((c) => c.r);
      expect(drawnOrder).toEqual(order);
    }
  });

  it("supports 8 runners", () => {
    for (const { order, seed } of cases(20, 8)) {
      const { timeline } = buildReplay(order, seed);
      expect(timeline.order).toEqual(order);
    }
  });
});

describe("lanes", () => {
  it("neighbouring runners never overlap", () => {
    for (const { order, seed } of cases(50, 8)) {
      const { timeline, lanes } = buildReplay(order, seed);
      for (let t = 0; t <= timeline.duration; t += 0.05) {
        for (let r = 1; r < timeline.runners; r++) {
          const a = laneOffset(lanes, r - 1, distanceAt(timeline, r - 1, t));
          const b = laneOffset(lanes, r, distanceAt(timeline, r, t));
          expect(b - a).toBeGreaterThan(0.35);
        }
        expect(laneOffset(lanes, timeline.runners - 1, distanceAt(timeline, timeline.runners - 1, t))).toBeLessThan(9);
      }
    }
  });
});

describe("time warp", () => {
  it("is continuous, monotone, and ends on the race's last frame", () => {
    for (const { order, seed } of cases(50)) {
      const { warp } = buildReplay(order, seed);
      // Sampled every millisecond of wall time: race time never goes back and never jumps by
      // more than the step (rate ≤ 1). Worst cases tracked, asserted once.
      let prev = 0;
      let minStep = Infinity;
      let maxStep = 0;
      for (let k = 0; k * 0.001 <= warp.wallDuration + 0.5; k++) {
        const t = raceTimeAt(warp, k * 0.001);
        minStep = Math.min(minStep, t - prev);
        maxStep = Math.max(maxStep, t - prev);
        prev = t;
      }
      expect(minStep).toBeGreaterThanOrEqual(0);
      expect(maxStep).toBeLessThanOrEqual(0.001 + 1e-9);
      expect(raceTimeAt(warp, warp.wallDuration)).toBe(warp.raceDuration);
      expect(warp.wallDuration).toBeGreaterThan(24);
      expect(warp.wallDuration).toBeLessThan(30);
    }
  });
});

describe("camera director", () => {
  function shotSequence(order: number[], seed: Hex): string[] {
    const model = buildReplay(order, seed);
    const seen: string[] = [];
    for (let w = 0; w <= model.warp.wallDuration; w += 1 / 60) {
      const { shot } = sceneAt(model, w).camera;
      if (seen[seen.length - 1] !== shot) seen.push(shot);
    }
    return seen;
  }

  it("cuts through all five shots in order", () => {
    for (const { order, seed } of cases(100)) {
      expect(shotSequence(order, seed)).toEqual([...SHOTS]);
    }
  });

  it("does the same for a photo finish", () => {
    const photo = cases(2000).find(({ order, seed }) => isPhotoFinish(buildReplay(order, seed).timeline));
    expect(photo).toBeDefined();
    expect(shotSequence(photo!.order, photo!.seed)).toEqual([...SHOTS]);
    expect(buildReplay(photo!.order, photo!.seed).warp.rate).toBe(0.2);
  });

  it("the head-on camera stays ahead of every runner", () => {
    for (const { order, seed } of cases(50)) {
      const model = buildReplay(order, seed);
      for (let w = 0; w <= model.warp.wallDuration; w += 0.05) {
        const scene = sceneAt(model, w);
        if (scene.camera.shot !== "headon") continue;
        for (const runner of scene.runners) expect(scene.camera.position[0] - runner.x).toBeGreaterThan(10);
      }
    }
  });
});

describe("track path", () => {
  it("is continuous at every join", () => {
    const joins = [0, STRAIGHT, STRAIGHT + Math.PI * BEND_RADIUS, 2 * STRAIGHT + Math.PI * BEND_RADIUS, LAP];
    for (const s of joins) {
      for (const o of [0, 4, 9]) {
        const a = poseAtS(s - 1e-7, o);
        const b = poseAtS(s + 1e-7, o);
        expect(Math.abs(a.x - b.x)).toBeLessThan(1e-5);
        expect(Math.abs(a.z - b.z)).toBeLessThan(1e-5);
        const dyaw = Math.abs(((a.yaw - b.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        expect(dyaw).toBeLessThan(1e-5);
      }
    }
  });

  it("starts on the back straight and finishes on the home straight", () => {
    const start = poseAtDistance(0, 0);
    expect(start.yaw).toBe(Math.PI);
    expect(start.z).toBe(-BEND_RADIUS);
    expect(RACE_METRES).toBeGreaterThan(250);
    expect(RACE_METRES).toBeLessThan(300);
  });
});
