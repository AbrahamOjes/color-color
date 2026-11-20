#!/usr/bin/env node
/**
 * Measures the graphics spike in a real Chrome over the DevTools protocol:
 *   - total download for /dev/race-replay per tier (every request, bytes on the wire), split
 *     by kind, against the 15 MB budget;
 *   - which of those bytes the lobby (/) also loads, so the 3D cost is shown on its own;
 *   - frame rate over a full replay: desktop, and a throttled-CPU phone-viewport proxy.
 *
 * The proxy is NOT the $100 Android result. It throttles the CPU but runs on this machine's
 * GPU. The exit criterion needs a person with the phone and the in-page fps overlay.
 *
 * Usage: npm run build && npm start   (in another shell), then
 *        npm run measure:race3d [-- --base http://localhost:3000]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3000");
const CHROME = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const PORT = 9333;
const RACE = "order=2,0,5,1,4,3&seed=0x9f1c2b7e5a4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0918273645abcd";
const BUDGET = 15 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = await mkdtemp(join(tmpdir(), "race3d-chrome-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
      "--use-angle=metal",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const pages = (await res.json()).filter((t) => t.type === "page");
      if (pages.length) return { proc, profile, wsUrl: pages[0].webSocketDebuggerUrl };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  proc.kill();
  throw new Error("Chrome did not start");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return new Promise((resolve) => ws.addEventListener("open", () => resolve({ send, on, close: () => ws.close() })));
}

async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

/// Loads `path` with an empty cache and returns every request's URL, type and wire bytes.
async function loadAndRecord(cdp, path, waitFor) {
  const requests = new Map();
  cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
    requests.set(requestId, { url: response.url, type, mime: response.mimeType, bytes: 0, done: false });
  });
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const r = requests.get(requestId);
    if (r) Object.assign(r, { bytes: encodedDataLength, done: true });
  });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${BASE}${path}` });
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    if (await evaluate(cdp, waitFor)) break;
    await sleep(250);
  }
  await sleep(1500); // let late requests (decoder workers) finish
  return [...requests.values()];
}

function kind(r) {
  const u = r.url;
  if (u.endsWith(".glb")) return "glb (meshes + KTX2 textures)";
  if (u.endsWith(".wasm")) return "wasm (Basis transcoder)";
  if (u.includes("/basis/")) return "js (Basis worker glue)";
  if (r.type === "Script" || u.endsWith(".js")) return "js";
  if (r.type === "Stylesheet") return "css";
  if (r.type === "Font") return "font";
  if (r.type === "Document") return "html";
  return "other";
}

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`;

/// Counts rAF callbacks from the first replay frame to the end of the race.
async function measureFps(cdp, path, { mobile, cpuRate }) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await cdp.send("Emulation.setDeviceMetricsOverride", mobile
    ? { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true }
    : { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.send("Page.navigate", { url: `${BASE}${path}` });
  // Wait until the replay has drawn its first frames.
  for (let i = 0; i < 240; i++) {
    if (await evaluate(cdp, "(window.__race3d?.stats?.frameMs?.length ?? 0) > 5")) break;
    await sleep(250);
  }
  await evaluate(
    cdp,
    `window.__frames = []; (function tick(t) { window.__frames.push(t); if (!window.__race3d?.done) requestAnimationFrame(tick); })(performance.now()); true`,
  );
  for (let i = 0; i < 240; i++) {
    if (await evaluate(cdp, "!!window.__race3d?.done")) break;
    await sleep(250);
  }
  const result = await evaluate(
    cdp,
    `(() => {
      const f = window.__frames;
      const gaps = f.slice(1).map((t, i) => t - f[i]);
      const total = f[f.length - 1] - f[0];
      const sorted = [...gaps].sort((a, b) => b - a);
      const worst = sorted.slice(0, Math.max(1, Math.floor(gaps.length / 100)));
      const r = window.__race3d;
      return {
        fps: (gaps.length * 1000) / total,
        low1: 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length),
        seconds: total / 1000,
        frames: gaps.length,
        tier: r.tier.tier, reason: r.tier.reason, gpu: r.tier.gpu, degraded: r.degraded,
        calls: r.stats.calls, triangles: r.stats.triangles,
      };
    })()`,
  );
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  return result;
}

async function main() {
  const chrome = await launch();
  try {
    const cdp = await connect(chrome.wsUrl);
    await cdp.send("Runtime.enable");

    // ── Download size ──
    const lobby = await loadAndRecord(cdp, "/", "document.readyState === 'complete'");
    const lobbyUrls = new Set(lobby.map((r) => r.url));
    console.log(`\nLobby (/): ${mb(lobby.reduce((a, r) => a + r.bytes, 0))} over ${lobby.length} requests\n`);

    for (const tier of ["full", "low"]) {
      const cdpTier = await connect(chrome.wsUrl);
      await cdpTier.send("Runtime.enable");
      const reqs = await loadAndRecord(cdpTier, `/dev/race-replay?${RACE}&tier=${tier}&fps=1`, "(window.__race3d?.stats?.frameMs?.length ?? 0) > 5");
      cdpTier.close();
      const total = reqs.reduce((a, r) => a + r.bytes, 0);
      const extra = reqs.filter((r) => !lobbyUrls.has(r.url));
      const byKind = {};
      for (const r of reqs) byKind[kind(r)] = (byKind[kind(r)] ?? 0) + r.bytes;
      console.log(`/dev/race-replay, tier ${tier}: ${mb(total)} total (${((100 * total) / BUDGET).toFixed(1)}% of 15 MB)`);
      for (const [k, b] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(32)} ${kb(b).padStart(9)}`);
      console.log(`  not loaded by the lobby (the 3D cost): ${mb(extra.reduce((a, r) => a + r.bytes, 0))}`);
      for (const r of extra.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) console.log(`    ${kb(r.bytes).padStart(9)}  ${r.url.replace(BASE, "")}`);
      console.log("");
    }

    // ── Frame rate ──
    const runs = [
      { label: "desktop, auto tier", tier: "auto", mobile: false, cpuRate: 1 },
      { label: "desktop, full tier", tier: "full", mobile: false, cpuRate: 1 },
      { label: "desktop, low tier", tier: "low", mobile: false, cpuRate: 1 },
      { label: "proxy: phone viewport, CPU ÷6, low tier", tier: "low", mobile: true, cpuRate: 6 },
    ];
    for (const run of runs) {
      const c = await connect(chrome.wsUrl);
      await c.send("Runtime.enable");
      const r = await measureFps(c, `/dev/race-replay?${RACE}&tier=${run.tier}&fps=1`, run);
      c.close();
      console.log(
        `${run.label.padEnd(42)} ${r.fps.toFixed(1)} fps avg, ${r.low1.toFixed(1)} 1% low over ${r.seconds.toFixed(1)} s ` +
          `(tier ${r.tier}/${r.reason}${r.degraded ? ", degraded" : ""}, ${r.calls} draw calls, ${(r.triangles / 1000).toFixed(1)}k tris)`,
      );
      if (run === runs[0]) console.log(`  GPU: ${r.gpu}`);
    }
    cdp.close();
  } finally {
    chrome.proc.kill();
    await sleep(300);
    await rm(chrome.profile, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
