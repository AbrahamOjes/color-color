import { type Abi } from "viem";
import VirtualRaceABI from "@/lib/abi/VirtualRace.json";
import { type GameDefaults } from "../types";

const RACE_ABI = VirtualRaceABI as Abi;

/// Every skin is a separate VirtualRace deployment; only the title and tagline differ here.
/// Runner names and colours live in src/games/skins, selected by the contract's SKIN_ID.
export const raceDefaults: Record<string, GameDefaults> = {
  greyhounds: {
    kind: "race",
    skin: "greyhounds-v1",
    title: "Virtual Greyhounds",
    tagline: "6 traps · weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
  danfo: {
    kind: "race",
    skin: "danfo-v1",
    title: "Danfo Derby",
    tagline: "6 danfo buses · weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
  okada: {
    kind: "race",
    title: "Okada Rush",
    tagline: "8 okada riders · weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
  keke: {
    kind: "race",
    title: "Keke Cup",
    tagline: "6 keke napep · weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
  horses: {
    kind: "race",
    title: "Virtual Horses",
    tagline: "10 runners · weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
  race: {
    kind: "race",
    title: "Virtual Race",
    tagline: "Weighted finishing order · fixed odds",
    abi: RACE_ABI,
  },
};
