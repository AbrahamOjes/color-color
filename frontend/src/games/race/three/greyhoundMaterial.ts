import { ShaderMaterial, Vector3, type Texture } from "three";
import { HIPS, JACKET } from "./greyhoundSpec";
import { SUN } from "./trackPath";

/**
 * One material for every runner: all dogs are a single instanced draw call.
 *
 * Per-instance attributes (set by Scene.tsx):
 *   iFur, iColour, iAccent, iText  colours (linear)
 *   iStyle                         x: pattern (0 solid, 1 stripes, 2 hoops), y: number 1..8
 *   iGait                          x: gallop phase 0..1, y: stride 0..1 (updated every frame)
 *
 * Per-vertex data baked by scripts/race3d/build-assets.mjs into COLOR_0:
 *   r  ambient occlusion
 *   b  part / 4: 0 body, 1–4 legs (front left, front right, hind left, hind right)
 * The jacket and its number are worked out per pixel from the model-space position and the
 * JACKET box in greyhoundSpec.ts, not stored on vertices, so they stay crisp on the coarse
 * low-tier mesh.
 *
 * The gallop is a rotation of each leg about its hip plus a spine flex and body bob, driven
 * by `iGait`, which the CPU derives from distance travelled. No skinning, no animation mixer.
 * Lighting is fixed: baked AO, a hemisphere term and one sun direction, no realtime lights.
 */

/// A JS number as a GLSL float literal.
const glsl = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const vertexShader = /* glsl */ `
attribute vec3 iFur;
attribute vec3 iColour;
attribute vec3 iAccent;
attribute vec3 iText;
attribute vec2 iStyle;
attribute vec2 iGait;

varying vec3 vNormal;
varying vec3 vBake;
varying vec3 vLocal;
varying vec3 vFur;
varying vec3 vColour;
varying vec3 vAccent;
varying vec3 vText;
varying vec2 vStyle;

const float TAU = 6.2831853;
// Hip pivots in model space (model faces +x, origin on the ground under the body).
const vec3 HIPS[4] = vec3[4](${HIPS.map(([x, y, z]) => `vec3(${glsl(x)}, ${glsl(y)}, ${glsl(z)})`).join(", ")});
// Rotary gallop: the front pair, then the hind pair half a cycle later.
const float LEG_PHASE[4] = float[4](0.0, 0.12, 0.5, 0.62);

void main() {
  vec3 p = position;
  vec3 n = normal;
  float part = floor(color.b * 4.0 + 0.5);
  float stride = iGait.y;
  float phase = iGait.x * TAU;

  if (part > 0.5) {
    int leg = int(part) - 1;
    vec3 hip = HIPS[leg];
    float a = stride * 0.8 * sin(phase + LEG_PHASE[leg] * TAU);
    float c = cos(a);
    float s = sin(a);
    vec2 q = p.xy - hip.xy;
    p.xy = hip.xy + vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    n.xy = vec2(c * n.x - s * n.y, s * n.x + c * n.y);
  } else {
    // Spine: gathers (arches) and extends once per stride.
    p.y += stride * 0.04 * sin(phase) * (p.x * p.x * 4.0 - 0.15);
  }
  p.y += stride * 0.03 * sin(phase * 2.0);

  mat4 m = modelMatrix * instanceMatrix;
  vNormal = normalize(mat3(m) * n);
  vBake = color;
  vLocal = position; // undeformed, so the jacket doesn't swim as the spine flexes
  vFur = iFur;
  vColour = iColour;
  vAccent = iAccent;
  vText = iText;
  vStyle = iStyle;
  gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0);
}
`;

const fragmentShader = /* glsl */ `
const float JACKET_X0 = ${glsl(JACKET.x0)};
const float JACKET_X1 = ${glsl(JACKET.x1)};
const float JACKET_Y0 = ${glsl(JACKET.y0)};
const float JACKET_Y1 = ${glsl(JACKET.y1)};

uniform sampler2D uNumbers;
uniform vec3 uSunDir;

varying vec3 vNormal;
varying vec3 vBake;
varying vec3 vLocal;
varying vec3 vFur;
varying vec3 vColour;
varying vec3 vAccent;
varying vec3 vText;
varying vec2 vStyle;

void main() {
  vec3 base = vFur;
  bool body = floor(vBake.b * 4.0 + 0.5) < 0.5;
  if (body && vLocal.x >= JACKET_X0 && vLocal.x <= JACKET_X1 && vLocal.y >= JACKET_Y0) {
    // Panel coordinates, mirrored on the far side so the number reads from both sides.
    float u = (vLocal.x - JACKET_X0) / (JACKET_X1 - JACKET_X0);
    vec2 uv = vec2(vLocal.z >= 0.0 ? u : 1.0 - u, clamp((vLocal.y - JACKET_Y0) / (JACKET_Y1 - JACKET_Y0), 0.0, 1.0));
    vec3 cloth = vColour;
    if (vStyle.x > 0.5 && vStyle.x < 1.5) cloth = fract(uv.x * 4.0) < 0.5 ? vAccent : vColour;
    else if (vStyle.x > 1.5) cloth = fract(uv.y * 3.0) < 0.5 ? vAccent : vColour;
    // The number sits in a square in the middle of the jacket panel.
    vec2 nuv = (uv - 0.5) * vec2(1.7, 1.15) + 0.5;
    float ink = 0.0;
    if (nuv.x >= 0.0 && nuv.x <= 1.0 && nuv.y >= 0.0 && nuv.y <= 1.0) {
      float idx = vStyle.y - 1.0;
      vec2 cell = vec2(mod(idx, 4.0), floor(idx / 4.0));
      ink = texture2D(uNumbers, (cell + vec2(nuv.x, 1.0 - nuv.y)) / vec2(4.0, 2.0)).r;
    }
    base = mix(cloth, vText, ink);
  }
  vec3 n = normalize(vNormal);
  float hemi = 0.6 + 0.4 * n.y;
  float sun = max(dot(n, uSunDir), 0.0);
  gl_FragColor = vec4(base * vBake.r * (0.62 * hemi + 0.55 * sun), 1.0);
  #include <colorspace_fragment>
}
`;

export const SUN_DIRECTION = new Vector3(...SUN).normalize();

export function createGreyhoundMaterial(numbers: Texture): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    vertexColors: true,
    uniforms: {
      uNumbers: { value: numbers },
      uSunDir: { value: SUN_DIRECTION },
    },
  });
}

/// Soft contact shadows: one instanced quad per runner, faded in the shader.
export function createBlobShadowMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.42 * (1.0 - smoothstep(0.25, 1.0, r)));
      }
    `,
  });
}
