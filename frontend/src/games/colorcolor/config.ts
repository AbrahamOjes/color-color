import { type Abi } from "viem";
import ColorColorABI from "@/lib/abi/ColorColor.json";
import { type GameDefaults } from "../types";

// Foundry-extracted JSON widens every literal to `string`, so the array needs an explicit
// `Abi` assertion — `useReadContracts` rejects it otherwise, unlike the singular hook.
export const colorColorDefaults: GameDefaults = {
  kind: "colorcolor",
  title: "ColorColor",
  tagline: "6 balls · 49 numbers · 4 colours · fixed odds",
  abi: ColorColorABI as Abi,
};
