"use client";

import dynamic from "next/dynamic";

/// The 3D replay, loaded only in the browser and in its own chunk: three.js never runs on the
/// server and adds nothing to a page's initial JavaScript until a replay is shown.
export const Replay3D = dynamic(() => import("./Replay3D"), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-[16/10] w-full items-center justify-center rounded-xl bg-sky-100 text-sm text-slate-500">
      Loading the 3D replay…
    </div>
  ),
});

export type { Replay3DProps } from "./Replay3D";
