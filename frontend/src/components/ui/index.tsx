"use client";

import { type ReactNode } from "react";

/// Minimal shared primitives. The pages previously repeated
/// `rounded-2xl bg-white border border-slate-200 shadow-sm` about fifteen times and
/// overrode `.btn-primary` with `!important` because it hardcodes its own padding.

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  // Only default to a white background when the caller has not supplied one. Tailwind
  // resolves conflicting utilities by stylesheet order, not by order in the class string,
  // so an unconditional `bg-white` here silently beat every `bg-slate-900` / `bg-amber-50`
  // passed in — rendering dark cards white with unreadable light text.
  const hasBackground = /(^|\s)(bg-|from-)/.test(className);

  return (
    <div
      className={`rounded-2xl border border-slate-200 shadow-sm ${
        hasBackground ? "" : "bg-white"
      } ${padded ? "p-5" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  type?: "button" | "submit";
}) {
  const base =
    "inline-flex items-center justify-center rounded-full font-bold transition-all disabled:cursor-not-allowed disabled:opacity-50";

  const variants = {
    primary: "bg-slate-900 text-white hover:bg-slate-800 disabled:hover:bg-slate-900",
    secondary: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    ghost: "text-slate-500 hover:text-slate-900",
  };

  const sizes = {
    sm: "px-4 py-2 text-xs",
    md: "px-6 py-3 text-sm",
    lg: "px-8 py-4 text-base",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "up" | "down";
}) {
  const toneClass =
    tone === "up" ? "text-emerald-600" : tone === "down" ? "text-red-600" : "text-slate-900";
  return (
    <Card className="text-center">
      <p className={`text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-400">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </Card>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const tones = {
    neutral: "bg-slate-100 text-slate-600",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    danger: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="py-10 text-center">
      <p className="font-semibold text-slate-500">{title}</p>
      {hint && <p className="mt-1 text-sm text-slate-400">{hint}</p>}
    </Card>
  );
}
