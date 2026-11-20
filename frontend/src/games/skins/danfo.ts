import { type RaceSkin } from "./types";

/// Six danfo buses. Every danfo is yellow, so runners are told apart by stripe colour.
/// Names are body-panel sayings, not real unions, operators or routes.
export const danfo: RaceSkin = {
  id: "danfo-v1",
  title: "Danfo Derby",
  runnerLabel: "Bus",
  runners: [
    { name: "Shine Your Eye", colour: "#facc15", accent: "#dc2626", text: "#0f172a", pattern: "stripes" },
    { name: "No Food For Lazy Man", colour: "#facc15", accent: "#2563eb", text: "#0f172a", pattern: "stripes" },
    { name: "Sharp Sharp", colour: "#facc15", accent: "#16a34a", text: "#0f172a", pattern: "stripes" },
    { name: "Hold Body", colour: "#facc15", accent: "#0f172a", text: "#0f172a", pattern: "stripes" },
    { name: "Who Dey Breathe", colour: "#facc15", accent: "#9333ea", text: "#0f172a", pattern: "stripes" },
    { name: "Last Bus", colour: "#facc15", accent: "#ea580c", text: "#0f172a", pattern: "stripes" },
  ],
  track: { lengthM: 800, surface: "road" },
  replay: { durationMs: 25_000 },
};
