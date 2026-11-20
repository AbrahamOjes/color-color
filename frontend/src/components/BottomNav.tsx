"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GAMES, playHref } from "@/games/registry";
import { isActive } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/", label: "Live" },
  { href: playHref(GAMES[0]), label: "Play" },
  { href: "/stats", label: "Stats" },
  { href: "/bets", label: "My Bets" },
  { href: "/vault", label: "Vault" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-white/95 backdrop-blur-md sm:hidden">
      <div className="mx-auto flex max-w-lg items-center justify-around">
        {NAV_ITEMS.map(({ href, label }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-0.5 px-3 py-3 text-xs font-medium transition-colors ${
                active ? "text-slate-900" : "text-slate-400 hover:text-slate-600"
              }`}
            >
              <div
                className={`mb-1 h-1 w-4 rounded-full transition-colors ${
                  active ? "bg-slate-900" : "bg-transparent"
                }`}
              />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
