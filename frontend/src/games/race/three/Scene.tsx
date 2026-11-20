"use client";

import { useEffect, useMemo } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  PlaneGeometry,
  type BufferGeometry,
  type Material,
  type MeshBasicMaterial,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { type RaceSkin } from "../../skins";
import { createBlobShadowMaterial, createGreyhoundMaterial } from "./greyhoundMaterial";
import { sceneAt, type ReplayModel, type SceneState } from "./replayModel";

export const ASSET_BASE = "/race3d";

/// One KTX2 loader per renderer: it owns the Basis transcoder workers.
let ktx2: { gl: WebGLRenderer; loader: KTX2Loader } | null = null;
function ktx2For(gl: WebGLRenderer): KTX2Loader {
  if (!ktx2 || ktx2.gl !== gl) {
    ktx2?.loader.dispose();
    ktx2 = { gl, loader: new KTX2Loader().setTranscoderPath(`${ASSET_BASE}/basis/`).detectSupport(gl) };
  }
  return ktx2.loader;
}

function useAsset(url: string) {
  const gl = useThree((s) => s.gl);
  return useLoader(GLTFLoader, url, (loader) => {
    loader.setKTX2Loader(ktx2For(gl));
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
}

/// The replay clock, owned by Replay3D. `wallTime()` is the only input to every frame.
export type ReplayClock = {
  /// Seconds since the off, from `performance.now()`; or a fixed moment when paused.
  wallTime: () => number;
  /// False once the replay is over and the result frame is pinned.
  running: () => boolean;
};

/// Frame timings and renderer counters, read by the fps overlay and the measurement script.
/// Mutable on purpose: it is written every frame and never drives a React render.
export class FrameStats {
  frameMs: number[] = [];
  calls = 0;
  triangles = 0;

  record(deltaMs: number, info: { calls: number; triangles: number }) {
    this.frameMs.push(deltaMs);
    if (this.frameMs.length > 600) this.frameMs.splice(0, this.frameMs.length - 600);
    this.calls = info.calls;
    this.triangles = info.triangles;
  }

  reset() {
    this.frameMs.length = 0;
  }
}

export function Track({ url, detail }: { url: string; detail: boolean }) {
  const gltf = useAsset(url);
  useEffect(() => {
    gltf.scene.traverse((o) => {
      if (o.name.startsWith("detail")) o.visible = detail;
    });
  }, [gltf, detail]);
  return <primitive object={gltf.scene} />;
}

const FUR = ["#c8a27a", "#2b2522", "#8d6e57", "#d9cbb8", "#5b4636", "#a9a39b", "#3e3a36", "#b88c5c"];
const PATTERN = { solid: 0, stripes: 1, hoops: 2 } as const;

/// The runners as two instanced draw calls (dogs, contact shadows), plus the camera. Built
/// once per (model, skin); `draw` poses everything for one `SceneState`.
class RaceView {
  readonly dogs: InstancedMesh;
  readonly shadows: InstancedMesh;
  private readonly gait: InstancedBufferAttribute;
  private readonly matrix = new Matrix4();

  constructor(source: Mesh, skin: RaceSkin, n: number) {
    const numbers = (source.material as MeshBasicMaterial).map;
    if (!numbers) throw new Error("greyhound asset has no number atlas");
    const geometry = (source.geometry as BufferGeometry).clone();
    const colour = (hex: string) => new Color(hex).toArray();
    const attr = (size: number, fill: (r: number) => number[]) =>
      new InstancedBufferAttribute(new Float32Array(Array.from({ length: n }, (_, r) => fill(r)).flat()), size);
    geometry.setAttribute("iFur", attr(3, (r) => colour(FUR[r % FUR.length])));
    geometry.setAttribute("iColour", attr(3, (r) => colour(skin.runners[r].colour)));
    geometry.setAttribute("iAccent", attr(3, (r) => colour(skin.runners[r].accent)));
    geometry.setAttribute("iText", attr(3, (r) => colour(skin.runners[r].text)));
    geometry.setAttribute("iStyle", attr(2, (r) => [PATTERN[skin.runners[r].pattern], r + 1]));
    this.gait = attr(2, () => [0, 0]);
    this.gait.setUsage(DynamicDrawUsage);
    geometry.setAttribute("iGait", this.gait);

    this.dogs = new InstancedMesh(geometry, createGreyhoundMaterial(numbers), n);
    this.dogs.frustumCulled = false; // instances move; the source bounds don't cover them
    const blob = new PlaneGeometry(1.5, 0.6).rotateX(-Math.PI / 2);
    this.shadows = new InstancedMesh(blob, createBlobShadowMaterial(), n);
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
  }

  draw(scene: SceneState, camera: PerspectiveCamera) {
    const m = this.matrix;
    scene.runners.forEach((s, r) => {
      m.makeRotationY(s.yaw).setPosition(s.x, 0, s.z);
      this.dogs.setMatrixAt(r, m);
      m.setPosition(s.x - 0.05, 0.02, s.z);
      this.shadows.setMatrixAt(r, m);
      this.gait.setXY(r, s.gait, s.stride);
    });
    this.dogs.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.gait.needsUpdate = true;

    const { position, target, fov } = scene.camera;
    camera.position.set(position[0], position[1], position[2]);
    camera.lookAt(target[0], target[1], target[2]);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  dispose() {
    for (const mesh of [this.dogs, this.shadows]) {
      mesh.geometry.dispose();
      (mesh.material as Material).dispose();
    }
  }
}

/// The runners and the camera, both set every frame from `sceneAt(model, clock.wallTime())`.
export function Race({
  url,
  model,
  skin,
  clock,
  stats,
}: {
  url: string;
  model: ReplayModel;
  skin: RaceSkin;
  clock: ReplayClock;
  stats: FrameStats;
}) {
  const gltf = useAsset(url);
  const n = model.timeline.runners;

  const view = useMemo(() => {
    let source: Mesh | undefined;
    gltf.scene.traverse((o) => {
      if (!source && o instanceof Mesh) source = o;
    });
    if (!source) throw new Error(`${url} has no mesh`);
    return new RaceView(source, skin, n);
  }, [gltf, url, n, skin]);

  useEffect(() => () => view.dispose(), [view]);

  useFrame((state, delta) => {
    const wall = clock.wallTime();
    view.draw(sceneAt(model, wall), state.camera as PerspectiveCamera);
    // Only race frames count. The first frame's delta spans asset loading, and frames after
    // the finish are drawn on demand, seconds apart; either would wreck the fps figures.
    if (clock.running() && wall > 0) stats.record(delta * 1000, state.gl.info.render);
  });

  return (
    <>
      <primitive object={view.dogs} />
      <primitive object={view.shadows} />
    </>
  );
}
