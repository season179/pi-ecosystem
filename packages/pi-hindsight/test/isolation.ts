import { vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Credential-free test process; no inherited provider/Hindsight settings or live HTTP.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|^HINDSIGHT_|^AWS_|^AZURE_|^GOOGLE_|^OPENAI_|^ANTHROPIC_|^PI_.*(?:AUTH|PROVIDER)/i.test(key)) delete process.env[key];
}
// Never resolve the real Pi agent dir (typesafe.json/key) from tests.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'pi-hindsight-agent-'));
const denied = () => { throw new Error('TEST SAFETY: live network forbidden'); };
vi.stubGlobal('fetch', denied);
vi.spyOn(http, 'request').mockImplementation(denied);
vi.spyOn(https, 'request').mockImplementation(denied);
vi.spyOn(http, 'get').mockImplementation(denied);
vi.spyOn(https, 'get').mockImplementation(denied);
