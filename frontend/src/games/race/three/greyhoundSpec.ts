/**
 * Measurements of the placeholder greyhound, in model-space metres (faces +x, origin on the
 * ground under the body). Shared by the asset script, which builds the mesh, and the shader,
 * which animates and paints it, so the two can't drift.
 *
 * Dependency-free so scripts/race3d/build-assets.mjs can import it directly.
 */

/// Hip pivots the legs swing about: front left, front right, hind left, hind right.
export const HIPS: readonly (readonly [number, number, number])[] = [
  [0.3, 0.47, 0.07],
  [0.3, 0.47, -0.07],
  [-0.3, 0.49, 0.07],
  [-0.3, 0.49, -0.07],
];

/// The racing jacket: body surface between x0 and x1, above y0. The number panel spans
/// y0..y1. Worked out per pixel in the shader, so it stays crisp on a coarse mesh.
export const JACKET = { x0: -0.26, x1: 0.2, y0: 0.45, y1: 0.67 } as const;
