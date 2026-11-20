// ColorColor 4-colour system — single source of truth.
// Index = contract colour id (Red=0, Yellow=1, Green=2, Blue=3).
// Ranges match ColorColor.sol: RED_MAX=12, YELLOW_MAX=24, GREEN_MAX=36, BLUE_MAX=49.

export const COLOURS = ["Red", "Yellow", "Green", "Blue"] as const;
export type Colour = (typeof COLOURS)[number];

// dominantColour from getDrawResult: 0-3 = colour, 4 = tie ("Draw").
export const DOMINANT_LABELS = [...COLOURS, "Draw"] as const;

export function getColour(n: number): Colour {
  if (n <= 12) return "Red";
  if (n <= 24) return "Yellow";
  if (n <= 36) return "Green";
  return "Blue";
}

// Solid fill (ball backgrounds). Yellow stays light → pair with dark text.
export const COLOUR_BG = {
  Red: "bg-red-500",
  Yellow: "bg-yellow-400",
  Green: "bg-emerald-500",
  Blue: "bg-blue-500",
} as const;

// Text colour on a ball fill (yellow needs dark text for contrast).
export const COLOUR_ON_BG = {
  Red: "text-white",
  Yellow: "text-slate-900",
  Green: "text-white",
  Blue: "text-white",
} as const;

// Gradient (picker buttons).
export const COLOUR_GRAD = {
  Red: "from-red-400 to-red-600",
  Yellow: "from-yellow-300 to-yellow-500",
  Green: "from-emerald-400 to-emerald-600",
  Blue: "from-blue-400 to-blue-600",
} as const;

// Text colour on white (yellow darkened for readability).
export const COLOUR_TEXT = {
  Red: "text-red-600",
  Yellow: "text-yellow-600",
  Green: "text-emerald-600",
  Blue: "text-blue-600",
} as const;

export const COLOUR_RANGE = {
  Red: "1–12",
  Yellow: "13–24",
  Green: "25–36",
  Blue: "37–49",
} as const;
