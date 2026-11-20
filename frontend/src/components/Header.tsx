"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { GAMES, playHref } from "@/games/registry";
import { isActive } from "@/lib/utils";

// Desktop nav. Previously only Home and Play were reachable by click on desktop, which
// left /vault, /results and /referrals as URL-only pages.
const LINKS = [
  { href: playHref(GAMES[0]), label: "Play" },
  { href: "/stats", label: "Stats" },
  { href: "/bets", label: "My Bets" },
  { href: "/results", label: "Results" },
  { href: "/vault", label: "Vault" },
  { href: "/referrals", label: "Refer" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-slate-100 bg-white/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="text-xl font-black tracking-tight text-slate-900">
          Color
          <span className="bg-gradient-to-r from-red-500 via-yellow-400 to-blue-500 bg-clip-text text-transparent">
            Color
          </span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={`rounded-full px-3 py-2 text-sm font-semibold transition-colors ${
                isActive(pathname, href)
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>

        <ConnectButton accountStatus="avatar" chainStatus="icon" showBalance={false} />
      </div>
    </header>
  );
}
