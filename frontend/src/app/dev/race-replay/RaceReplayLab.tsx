"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type Hex } from "viem";
import { Button, Card } from "@/components/ui";
import { Replay } from "@/games/race/Replay";
import { Replay3D } from "@/games/race/three";
import { resolveSkin } from "@/games/skins";

const DEFAULT_SKIN = "greyhounds-v1";

function randomSeed(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function randomOrder(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  const rand = crypto.getRandomValues(new Uint32Array(n));
  for (let i = n - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/// Same rule as buildTimeline: a permutation of 0..N-1 with N ≥ 2.
function parseOrder(raw: string | null): number[] | string {
  if (!raw) return "missing";
  const order = raw.split(",").map((s) => Number(s.trim()));
  const n = order.length;
  if (n < 2 || n > 12) return "needs 2–12 runners";
  if (order.some((r) => !Number.isInteger(r) || r < 0 || r >= n) || new Set(order).size !== n) {
    return "must be a permutation of 0..N-1 (0-based runner indexes, winner first)";
  }
  return order;
}

/// /dev/race-replay?order=2,0,5,1,4,3&seed=0x…&tier=auto|full|low&skin=greyhounds-v1&fps=1
export function RaceReplayLab() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [show2d, setShow2d] = useState(false);
  const [copied, setCopied] = useState(false);

  const orderParam = params.get("order");
  const seedParam = params.get("seed");
  const tier = params.get("tier");
  const skinId = params.get("skin") ?? DEFAULT_SKIN;
  const showFps = params.get("fps") !== "0";

  const setParams = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) next.set(k, v);
    router.replace(`${pathname}?${next.toString()}`);
  };

  // A link without a race gets a random one, written to the URL so it can be shared.
  useEffect(() => {
    if (orderParam && seedParam) return;
    const next = new URLSearchParams(params.toString());
    if (!orderParam) next.set("order", randomOrder(6).join(","));
    if (!seedParam) next.set("seed", randomSeed());
    router.replace(`${pathname}?${next.toString()}`);
  }, [orderParam, seedParam, params, pathname, router]);

  const order = parseOrder(orderParam);
  const seedValid = !!seedParam && /^0x[0-9a-fA-F]{1,64}$/.test(seedParam);

  if (!orderParam || !seedParam) {
    return <div className="py-20 text-center text-slate-400">Picking a race…</div>;
  }

  const errors = [
    typeof order === "string" ? `order ${order}` : null,
    seedValid ? null : "seed must be 0x followed by up to 64 hex digits (bytes32)",
  ].filter(Boolean);

  const skin = typeof order === "string" ? null : resolveSkin(skinId, undefined, order.length);
  const seed = seedParam as Hex;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">3D replay lab</h1>
        <p className="text-sm text-slate-500">
          Graphics spike. Replays any finishing order and replay seed from the URL; the same link shows the identical
          race on every device.
        </p>
      </div>

      {errors.length > 0 || !skin ? (
        <Card>
          <ul className="list-disc pl-5 text-sm text-red-600">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Card>
      ) : (
        <>
          <Replay3D
            key={`${orderParam}|${seed}|${tier}|${skin.id}`}
            finishingOrder={order as number[]}
            replaySeed={seed}
            skin={skin}
            tier={tier}
            showFps={showFps}
          />
          <Card>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-slate-600">
              <dt className="font-semibold">order</dt>
              <dd className="font-mono">{(order as number[]).join(",")}</dd>
              <dt className="font-semibold">seed</dt>
              <dd className="break-all font-mono">{seed}</dd>
              <dt className="font-semibold">skin</dt>
              <dd className="font-mono">{skin.id}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => setParams({ order: randomOrder(6).join(","), seed: randomSeed() })}>
                Random race
              </Button>
              {(["auto", "full", "low"] as const).map((t) => (
                <Button key={t} size="sm" variant={(tier ?? "auto") === t ? "primary" : "ghost"} onClick={() => setParams({ tier: t })}>
                  {t}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShow2d((s) => !s)}>
                {show2d ? "Hide" : "Show"} 2D cross-check
              </Button>
            </div>
          </Card>
          {show2d && (
            <Card>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">2D replay, same input</p>
              <Replay finishingOrder={order as number[]} replaySeed={seed} skin={skin} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
