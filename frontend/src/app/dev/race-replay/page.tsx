import type { Metadata } from "next";
import { Suspense } from "react";
import { RaceReplayLab } from "./RaceReplayLab";

export const metadata: Metadata = {
  title: "3D replay lab",
  robots: { index: false, follow: false },
};

/// Graphics spike test page: replays any (order, seed) from the URL. Not linked from the nav.
export default function RaceReplayPage() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-400">Loading…</div>}>
      <RaceReplayLab />
    </Suspense>
  );
}
