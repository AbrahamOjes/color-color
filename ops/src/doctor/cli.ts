import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { loadEnv } from "../runtime/config.js";
import { viemChainReader } from "./chain.js";
import { formatFindings, hasBlocking, runDoctor } from "./doctor.js";

/// `npm run doctor` (from ops/) or `npm run doctor` at the repo root. Exit 1 on a blocking
/// finding so a service wrapper can refuse to start on the same signal.

const exec = promisify(execFile);

async function abiCopiesMatch(): Promise<{ ok: boolean; detail: string }> {
  const script = resolve(process.cwd(), "..", "scripts", "check-abi-copies.sh");
  if (!existsSync(script)) return { ok: true, detail: "not in the repo; ABI check skipped" };
  try {
    await exec(script, [], { cwd: resolve(process.cwd(), "..") });
    return { ok: true, detail: "ABI copies match the build" };
  } catch (e: any) {
    const text = String(e.stdout ?? "") + String(e.stderr ?? "");
    if (text.includes("missing build artifact")) return { ok: true, detail: "no forge build present; ABI check skipped" };
    return { ok: false, detail: text.trim().split("\n")[0] ?? "ABI copies drift" };
  }
}

async function main() {
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    console.error("BLOCKING config: " + (e as Error).message);
    console.error("         fix: set RPC_URL, CHAIN_ID and GAMES (see ops/README.md).");
    process.exit(1);
  }
  const findings = await runDoctor({ env, chain: viemChainReader(env.RPC_URL), abiCopiesMatch });
  console.log(formatFindings(findings));
  const blocking = hasBlocking(findings);
  console.log(blocking ? "\nDOCTOR: BLOCKING findings; do not start services." : "\nDOCTOR: OK");
  process.exit(blocking ? 1 : 0);
}

main().catch((e) => {
  console.error("doctor crashed: " + (e as Error).message);
  process.exit(1);
});
