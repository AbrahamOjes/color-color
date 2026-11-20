/**
 * Quality tiers. "full" for anything capable; "low" for budget Android, the target device for
 * the 30 fps exit criterion. The tier only changes how the race looks, never where anyone is.
 */
export type Tier = "full" | "low";

export type TierInfo = {
  tier: Tier;
  /// Why this tier: "url", "memory", "cores", "gpu" or "default".
  reason: string;
  gpu: string;
};

/// GPUs found in ~$100 Android phones: Mali Utgard/Bifrost, older Adreno, PowerVR Rogue.
const LOW_END_GPU = /mali-(4\d\d|t\d+|g31|g51|g52|g57|g68)|adreno \(tm\) (3|4|5)\d\d|adreno (3|4|5)\d\d|powervr|sgx|videocore|swiftshader|llvmpipe/i;

export function readGpu(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "none";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return String(name);
  } catch {
    return "unknown";
  }
}

/// `override` comes from `?tier=`; anything other than "full" or "low" means auto.
export function detectTier(override?: string | null): TierInfo {
  const gpu = readGpu();
  if (override === "full" || override === "low") return { tier: override, reason: "url", gpu };
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 3) return { tier: "low", reason: "memory", gpu };
  // Core count is a budget-Android signal only. Safari caps it for privacy, so an iPhone or
  // iPad (Apple GPU) would otherwise look like a $100 phone.
  const apple = /apple/i.test(gpu);
  if (!apple && nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4) {
    return { tier: "low", reason: "cores", gpu };
  }
  if (LOW_END_GPU.test(gpu)) return { tier: "low", reason: "gpu", gpu };
  return { tier: "full", reason: "default", gpu };
}

export const TIER_SETTINGS: Record<Tier, { maxDpr: number; antialias: boolean; suffix: string }> = {
  full: { maxDpr: 2, antialias: true, suffix: "" },
  // 1.5, not 1: phones are 2–3× screens, and at 1 the jacket numbers blur to mush. The
  // runtime downgrade drops to 1 on a device that can't hold 30 fps.
  low: { maxDpr: 1.5, antialias: false, suffix: "-low" },
};
