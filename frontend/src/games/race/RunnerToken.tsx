import { type RunnerStyle } from "../skins";

const SIZES = { sm: "h-6 w-6 text-[11px]", md: "h-8 w-8 text-sm", lg: "h-10 w-10 text-base" } as const;

/// CSS background for a runner's colours: solid, vertical stripes or horizontal hoops.
export function runnerBackground(style: RunnerStyle): string {
  if (style.pattern === "stripes") {
    return `repeating-linear-gradient(90deg, ${style.colour} 0 5px, ${style.accent} 5px 10px)`;
  }
  if (style.pattern === "hoops") {
    return `repeating-linear-gradient(0deg, ${style.colour} 0 5px, ${style.accent} 5px 10px)`;
  }
  return style.colour;
}

/// A runner's number in its colours. `index` is 0-based; the token shows it 1-based.
export function RunnerToken({
  index,
  style,
  size = "md",
}: {
  index: number;
  style: RunnerStyle;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-black shadow-sm ring-1 ring-black/10 ${SIZES[size]}`}
      style={{ background: runnerBackground(style) }}
      title={style.name}
    >
      <span
        className="rounded px-0.5 leading-none"
        style={{
          color: style.text,
          // A backing chip keeps the number readable over stripes.
          background: style.pattern === "solid" ? "transparent" : style.colour,
        }}
      >
        {index + 1}
      </span>
    </span>
  );
}
