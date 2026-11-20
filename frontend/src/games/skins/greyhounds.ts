import { type RaceSkin } from "./types";

/// Six traps in the UK standard colours, so the card reads like a real greyhound card.
export const greyhounds: RaceSkin = {
  id: "greyhounds-v1",
  title: "Dog Racing",
  runnerLabel: "Trap",
  runners: [
    { name: "Swift Bandit", colour: "#dc2626", accent: "#dc2626", text: "#ffffff", pattern: "solid" },
    { name: "Midnight Rex", colour: "#2563eb", accent: "#2563eb", text: "#ffffff", pattern: "solid" },
    { name: "Snowy Comet", colour: "#ffffff", accent: "#ffffff", text: "#0f172a", pattern: "solid" },
    { name: "Coal Runner", colour: "#0f172a", accent: "#0f172a", text: "#ffffff", pattern: "solid" },
    { name: "Tango Flash", colour: "#f97316", accent: "#f97316", text: "#0f172a", pattern: "solid" },
    { name: "Zebra Dash", colour: "#0f172a", accent: "#ffffff", text: "#dc2626", pattern: "stripes" },
  ],
  track: { lengthM: 480, surface: "sand" },
  replay: { durationMs: 25_000 },
};
