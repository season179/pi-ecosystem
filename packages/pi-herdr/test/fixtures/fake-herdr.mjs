#!/usr/bin/env node

import { appendFileSync } from "node:fs";

const behavior = process.env.FAKE_HERDR_BEHAVIOR ?? "ok";
const delayMs = Number(process.env.FAKE_HERDR_DELAY_MS ?? "0");
const args = process.argv.slice(2);

if (args[0] === "notification") {
	const logPath = process.env.FAKE_HERDR_NOTIFICATION_LOG;
	if (logPath) appendFileSync(logPath, `${JSON.stringify(args)}\n`);
	const notificationDelayMs = Number(
		process.env.FAKE_HERDR_NOTIFICATION_DELAY_MS ?? "0",
	);
	if (notificationDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, notificationDelayMs));
	}
	if (process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE) {
		process.exitCode = Number(process.env.FAKE_HERDR_NOTIFICATION_EXIT_CODE);
	}
	process.exit();
}

if (delayMs > 0) {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

switch (behavior) {
	case "ok":
		console.log(
			JSON.stringify({
				id: "x",
				result: { type: "agent_info", echo: args },
			}),
		);
		break;
	case "timeout-error":
		console.error(JSON.stringify({ error: { code: "wait_timeout" } }));
		process.exitCode = 1;
		break;
	case "stall":
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 60_000);
		break;
	case "bad-exit":
		console.error("not-json garbage from fake herdr");
		process.exitCode = 3;
		break;
	default:
		console.error(`unknown fake herdr behavior: ${behavior}`);
		process.exitCode = 2;
}
