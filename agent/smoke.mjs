#!/usr/bin/env node
/**
 * Smoke test for the agent wiring. Drives the MCP server over stdio exactly as an LLM agent
 * would — reads state, quotes a bet, and checks that the mandate actually refuses what it is
 * supposed to refuse.
 *
 * It is read-only by default. Pass --bet to place one real (small) bet.
 *
 *   RPC_URL=... CHAIN_ID=... AGENT_PRIVATE_KEY=... COLORCOLOR_ADDRESS=... \
 *   AGENT_MANDATE_ADDRESS=... MANDATE_ID=0 node smoke.mjs [--bet]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PLACE_BET = process.argv.includes("--bet");

for (const required of ["RPC_URL", "AGENT_PRIVATE_KEY", "COLORCOLOR_ADDRESS", "AGENT_MANDATE_ADDRESS", "MANDATE_ID"]) {
  if (!process.env[required]) {
    console.error(`Missing required env var ${required}`);
    process.exit(1);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env },
  stderr: "pipe",
});

const client = new Client({ name: "colorcolor-smoke", version: "1.0.0" });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  console.log(`\n--- ${name} ---\n${body}`);
  return { body, isError: res.isError === true };
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

await call("get_game_state");
const mandate = JSON.parse((await call("get_mandate")).body);
await call("quote_bet", { bet_type: "COLOR", selection: ["Blue"], stake: 1 });

// The mandate must refuse a stake above its own per-bet cap. If this is ever allowed, the
// delegation is not actually bounded and nothing else here matters.
const cap = Number(String(mandate.maxStakePerBet).replace(/[$,]/g, ""));
const refusal = JSON.parse((await call("check_can_bet", { bet_type: "COLOR", stake: cap + 1 })).body);
const refused = refusal.allowed === false;
console.log(
  `\n[${refused ? "PASS" : "FAIL"}] mandate refused an over-cap stake — reason: "${refusal.reason}"`,
);
if (refused && refusal.reason !== "stake above per-bet cap") {
  console.log(
    `  note: refused for a different reason than the cap, so the cap itself was not exercised.`,
  );
}

if (PLACE_BET) {
  await call("place_bet", { bet_type: "HILO", selection: ["Lo"], stake: 0.5 });
  await call("list_my_bets", { limit: 5 });
}

await client.close();
process.exit(refused ? 0 : 1);
