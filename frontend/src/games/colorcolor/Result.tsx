"use client";

import { getColour, COLOUR_BG, COLOUR_ON_BG } from "@/lib/colours";

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-14 w-14 text-lg",
} as const;

/// A drawn number, coloured by the contract's ranges.
///
/// `revealIndex` staggers the drop animation so a settled draw plays out ball by ball
/// instead of appearing all at once — this is what makes it read as a live event.
export function Ball({
  n,
  size = "md",
  revealIndex,
}: {
  n: number;
  size?: keyof typeof SIZES;
  revealIndex?: number;
}) {
  const colour = getColour(n);
  const animated = revealIndex !== undefined;

  return (
    <span
      className={`inline-flex items-center justify-center rounded-full font-bold shadow-sm ring-1 ring-black/5 ${
        SIZES[size]
      } ${COLOUR_BG[colour]} ${COLOUR_ON_BG[colour]} ${animated ? "ball-drop" : ""}`}
      style={animated ? { animationDelay: `${revealIndex * 140}ms` } : undefined}
    >
      {n}
    </span>
  );
}

/// A row of six drawn balls. Pass `reveal` to play the drop animation.
export function BallRow({
  numbers,
  size = "md",
  reveal = false,
}: {
  numbers: number[];
  size?: keyof typeof SIZES;
  reveal?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {numbers.map((n, i) => (
        <Ball key={`${n}-${i}`} n={n} size={size} revealIndex={reveal ? i : undefined} />
      ))}
    </div>
  );
}

/// Six empty sockets, shown while a draw is pending so the layout does not jump when the
/// real balls land.
export function BallPlaceholders({ size = "md" }: { size?: keyof typeof SIZES }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {Array.from({ length: 6 }, (_, i) => (
        <span
          key={i}
          className={`inline-flex items-center justify-center rounded-full border-2 border-dashed border-slate-200 bg-slate-50 ${SIZES[size]} ball-pulse`}
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}
