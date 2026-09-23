import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterAll } from "vitest";

// Any code path that defaults to the agent directory must land in a throwaway directory, never ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "pi-accounts-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
if (getAgentDir() !== agentDir || agentDir === join(homedir(), ".pi", "agent")) {
  throw new Error(`Tests would use the live agent directory: ${getAgentDir()}`);
}
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
