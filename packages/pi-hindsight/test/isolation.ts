import { vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
// Credential-free test process; no inherited provider/Hindsight settings or live HTTP.
for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|^HINDSIGHT_|^AWS_|^AZURE_|^GOOGLE_|^OPENAI_|^ANTHROPIC_|^PI_.*(?:AUTH|PROVIDER)/i.test(key)) delete process.env[key];
}
const denied = () => { throw new Error('TEST SAFETY: live network forbidden'); };
vi.stubGlobal('fetch', denied);
vi.spyOn(http, 'request').mockImplementation(denied);
vi.spyOn(https, 'request').mockImplementation(denied);
vi.spyOn(http, 'get').mockImplementation(denied);
vi.spyOn(https, 'get').mockImplementation(denied);
