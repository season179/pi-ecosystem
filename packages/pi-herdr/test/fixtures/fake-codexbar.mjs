#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_CODEXBAR_LOG) appendFileSync(process.env.FAKE_CODEXBAR_LOG, JSON.stringify(args) + "\n");
const mode = process.env.FAKE_CODEXBAR_MODE;
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "oversized") process.stdout.write("x".repeat(600_000));
else if (mode === "invalid") process.stdout.write("raw secret diagnostic");
else if (mode === "error") { process.stderr.write("secret-token"); process.exitCode = 1; }
else {
  const now = Date.now();
  const usedPercent = Number(process.env.FAKE_CODEXBAR_USED ?? 95);
  process.stdout.write(JSON.stringify([{ provider: args[args.indexOf("--provider") + 1], usage: {
    updatedAt: new Date(now).toISOString(),
    identity: { accountEmail: "fixture-private@example.com" },
    secondary: { usedPercent, windowMinutes: 10080, resetsAt: new Date(now + 6 * 86400000).toISOString() },
  } }]));
}
