// Offline end-to-end check of the built bundle against a real Pi SDK, with a synthetic model.
// Default: the workspace devDependency (node_modules/@earendil-works/pi-coding-agent).
// PI_SDK_ROOT=/absolute/path/to/node_modules selects another install, such as a managed Pi:
//   PI_SDK_ROOT=~/.pi/agent/install/releases/<version>/node_modules node scripts/check-shell-sdk.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const resolve = (name, file = 'index.js') =>
  process.env.PI_SDK_ROOT
    ? pathToFileURL(join(process.env.PI_SDK_ROOT, name, 'dist', file)).href
    : import.meta.resolve(file === 'compat.js' ? `${name}/compat` : name);
const {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION,
} = await import(resolve('@earendil-works/pi-coding-agent'));
const { InMemoryCredentialStore } = await import(resolve('@earendil-works/pi-ai'));
const { createAssistantMessageEventStream } = await import(
  resolve('@earendil-works/pi-ai', 'compat.js')
);
const root = await mkdtemp(join(tmpdir(), 'pi-shell-sdk-'));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.HERDR_ENV;
delete process.env.HERDR_PANE_ID;
let session;
const deadline = setTimeout(() => {
  console.error('Shell SDK check timed out');
  process.exit(1);
}, 15000);
try {
  execFileSync('mkfifo', [join(root, 'gate')]);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = new ModelRegistry(modelRuntime).getAll().find((m) => m.provider === 'openai');
  assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'offline-test-not-a-real-key');
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    resourceLoader,
  }));
  const errors = [];
  await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
  assert.ok(session.getActiveToolNames().includes('shell_watch'));
  assert.ok(!session.getActiveToolNames().includes('herdr_watch'));
  let requests = 0;
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const callTool = ++requests === 1;
    const message = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: callTool
        ? [
            {
              type: 'toolCall',
              id: 'watch-1',
              name: 'shell_watch',
              arguments: {
                command: "read value < gate; printf 'shell-sdk-complete\\n'; exit 7",
                timeoutMs: 10000,
              },
            },
          ]
        : [{ type: 'text', text: requests === 2 ? 'Job started.' : 'Completion received.' }],
      stopReason: callTool ? 'toolUse' : 'stop',
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    queueMicrotask(() => {
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end();
    });
    return stream;
  };
  await session.prompt('Launch the local test command.');
  assert.equal(requests, 2, 'command must return control before completing');
  const settled = new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'agent_settled' && requests >= 3) {
        unsubscribe();
        resolve();
      }
    });
  });
  // Release the command only after the initial model turn has ended. No sleep/poll.
  await writeFile(join(root, 'gate'), 'go\n');
  await settled;
  const cards = session.messages.filter(
    (m) => m.role === 'custom' && m.customType === 'pi-shell-watch',
  );
  assert.equal(cards.length, 1);
  assert.match(cards[0].content, /exit 7/u);
  assert.match(cards[0].content, /shell-sdk-complete/u);
  assert.equal(session.getLastAssistantText(), 'Completion received.');
  assert.deepEqual(errors, []);
  const sdkRoot = process.env.PI_SDK_ROOT ?? 'workspace node_modules';
  console.log(
    `PASS (Pi SDK ${VERSION} from ${sdkRoot}): bundle loads without Herdr; shell returns immediately; exit 7/output arrive once and wake an idle Pi session. No model/network calls.`,
  );
} finally {
  await session?.reload(); // Actual shutdown hook runs before rebuilding the extension runtime.
  session?.dispose();
  clearTimeout(deadline);
  await rm(root, { recursive: true, force: true });
}
