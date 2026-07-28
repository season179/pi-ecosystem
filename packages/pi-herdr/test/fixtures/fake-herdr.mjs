#!/usr/bin/env node

const behavior = process.env.FAKE_HERDR_BEHAVIOR ?? "ok";
const delayMs = Number(process.env.FAKE_HERDR_DELAY_MS ?? "0");

if (delayMs > 0) {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

switch (behavior) {
	case "ok":
		console.log(
			JSON.stringify({
				id: "x",
				result: { type: "agent_info", echo: process.argv.slice(2) },
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
