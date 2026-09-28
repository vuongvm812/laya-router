import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function loadConfig(root) {
  const config = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8'));
  if (!['native', 'docker'].includes(config.backend) ||
      !['english', 'multilingual'].includes(config.checkpoint) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      typeof config.key !== 'string' || !/^[a-f0-9]{64}$/.test(config.key) ||
      !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 ||
      !Number.isSafeInteger(config.deadlineMs) || config.deadlineMs < config.timeoutMs) {
    throw new Error('Invalid install.json settings');
  }
  return config;
}

export function configure(root, config) {
  // Explicit process values win over Jev's .env loaders, including existing cloud keys.
  Object.assign(process.env, {
    JEV_ROOT: join(root, 'jev-router'),
    JEV_API_KEY: config.key,
    TYPESAFE_API_KEY: config.key,
    TYPESAFE_BASE_URL: `http://127.0.0.1:${config.port}`,
    TYPESAFE_DEFAULT_MODEL: config.checkpoint,
    LAYA_ROUTER_TIMEOUT_MS: String(config.timeoutMs),
    LAYA_ROUTER_DEADLINE_MS: String(config.deadlineMs),
    LAYA_HOST: config.backend === 'native' ? '127.0.0.1' : '0.0.0.0',
    LAYA_PORT: String(config.port),
    LAYA_DEVICE: config.backend === 'native' ? 'mps' : 'cpu',
    LAYA_PRELOAD: '1',
    LAYA_MODELS: config.checkpoint,
    LAYA_REVISION: 'reviewed',
    LAYA_MAX_LOADED: '1',
    LAYA_AUTO_TASK: '0',
    LAYA_THREADS: '4',
    OMP_NUM_THREADS: '4',
    LAYA_API_KEY: config.key,
    HF_HOME: join(root, 'model-cache'),
  });
}

export async function configureJev(root, config) {
  const module = await import(pathToFileURL(join(root, 'jev-router/src/config.mjs')).href);
  // In-memory overrides only; the pinned upstream files remain pristine.
  Object.assign(module.THRESHOLDS, {
    jevTimeoutMs: config.timeoutMs, jevDeadlineMs: config.deadlineMs, jevMaxRetries: 0,
  });
  return module;
}

export async function health(config) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  } catch {
    throw new Error('Local Laya is not ready. Run laya-serve-local in another terminal and wait for startup to finish.');
  }
  if (!response.ok) throw new Error(`Laya health returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.status !== 'ok' || !result.loaded?.includes(config.checkpoint)) throw new Error('Expected Laya checkpoint is not loaded');
  return result;
}

export async function check(root, config, { verbose = true } = {}) {
  await health(config);
  const { TIERS, QUESTIONS, questionForModels } = await configureJev(root, config);
  const { TypeSafeClient } = createRequire(join(root, 'jev-router/package.json'))('@typesafe-ai/sdk');
  const models = TIERS.filter((tier) => tier.name !== 'fable').map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
  // These IDs are classifier labels for the smoke test, not generation requests.
  const input = { prompt: 'Rename the local variable count to itemCount in one function.', current: models[2].id, contextTokens: 100, models };
  const client = new TypeSafeClient({ apiKey: config.key, timeout: 120000, retry: { maxRetries: 0 }, logLevel: 'warn',
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) });
  const started = Date.now();
  const warm = await client.systemOne({
    state: { request: input.prompt, session: { current_model: input.current, context_tokens: 100 }, environment: { available_models: models.map((m) => m.id) } },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  }).catch(() => { throw new Error('Laya warm-up failed. Inspect the local server logs.'); });
  if (!models.some((m) => m.id === warm.answers?.model?.choice) || !Number.isFinite(warm.answers.model.confidence)) throw new Error('Laya returned an invalid model choice');
  for (const name of Object.keys(QUESTIONS)) {
    if (!Number.isFinite(warm.answers?.[name]?.score)) throw new Error(`Laya did not return score ${name}`);
  }
  const warmMs = Date.now() - started;
  const { askJev } = await import(pathToFileURL(join(root, 'jev-router/src/router-local.mjs')).href);
  const result = await askJev(input);
  if (!result || !models.some((m) => m.id === result.choice)) throw new Error('Warm-up succeeded, but Jev classification failed within its runtime budget. Inspect Laya logs or increase timeoutMs/deadlineMs in install.json.');
  const status = await health(config);
  if (verbose) console.log(JSON.stringify({ classifier: process.env.TYPESAFE_BASE_URL, checkpoint: config.checkpoint, warmMs, jevMs: result.ms, choice: result.choice, confidence: result.confidence, health: status }, null, 2));
  const expectedDevice = config.backend === 'native' ? 'mps' : 'cpu';
  if (!status.checkpoint_devices?.[config.checkpoint]?.startsWith(expectedDevice) || status.cpu_fallbacks?.[config.checkpoint]?.count > 0) {
    console.error('Laya reports a device mismatch or CPU fallback. Inspect laya-check health output and server logs.');
  }
  return result;
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', env: process.env });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const outcome = await new Promise((yes, no) => {
      child.once('error', no);
      child.once('exit', (code, signal) => yes({ code, signal }));
    });
    process.exitCode = outcome.code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[outcome.signal] ?? 1);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

async function launchClient(root, action, args) {
  const load = (file) => import(pathToFileURL(join(root, 'jev-router/src', file)).href);
  let proxy;
  let cleanup = () => {};
  if (action === 'claude') {
    const { startProxy } = await load('proxy-local.mjs');
    const { readSavedModel, restoreSavedModel } = await load('settings-local.mjs');
    const previous = readSavedModel();
    cleanup = () => restoreSavedModel(previous);
    proxy = await startProxy();
    Object.assign(process.env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_MODEL: !process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL === 'jev-router' ? 'laya-router' : process.env.ANTHROPIC_MODEL,
      ANTHROPIC_CUSTOM_MODEL_OPTION: 'laya-router',
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: 'laya-router',
      ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: 'Route turns using local Laya',
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: 'thinking,adaptive_thinking,interleaved_thinking,effort,max_effort',
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: '1',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    });
  } else {
    const { startCodexProxy } = await load('codex-proxy-local.mjs');
    const { codexArgs } = await load('codex-cli.mjs');
    process.env.JEV_CODEX_STATUS_ID = `codex-${process.pid}`;
    proxy = await startCodexProxy({ statusId: process.env.JEV_CODEX_STATUS_ID });
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args).map((arg) =>
      arg === 'jev-router' ? 'laya-router' : arg.replace('name="Jev Router"', 'name="laya-router"'));
  }
  try {
    await run(action, args);
  } finally {
    const server = proxy.close();
    server.closeAllConnections();
    cleanup();
  }
}

export async function main(args = process.argv.slice(2), root = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const [action, ...clientArgs] = args;
  if (!['serve', 'build', 'check', 'claude', 'codex', 'opencode', 'stats'].includes(action)) throw new Error('Expected serve, build, check, claude, codex, opencode, or stats');
  process.env.LAYA_USAGE_FILE = join(root, 'usage.jsonl');
  if (action === 'stats') {
    const { main: usageStats } = await import('./usage.mjs');
    return usageStats(clientArgs);
  }
  const config = loadConfig(root);
  configure(root, config);
  if (action === 'serve' || action === 'build') {
    if (config.backend === 'docker') {
      const project = `laya-jev-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
      return run('docker', ['compose', '--project-name', project, '-f', join(root, 'tools/compose.yaml'), ...(action === 'build' ? ['build', 'laya'] : ['up', '--no-build', '--abort-on-container-exit', 'laya'])]);
    }
    if (action === 'build') throw new Error('build is only for the Docker backend');
    return run(join(root, 'venv/bin/laya-serve'), []);
  }
  if (action === 'check') return check(root, config);
  // Warm inference and exercise the actual SDK before allowing a client to start.
  await check(root, config, { verbose: false });
  process.env.LAYA_USAGE_SESSION_ID = `${action}-${randomUUID()}`;
  console.error(`[laya-router] ${config.checkpoint} classifier: ${process.env.TYPESAFE_BASE_URL}; generation uses the client provider.`);
  if (action === 'opencode') {
    const { main: openCode } = await import('./opencode.mjs');
    return openCode(clientArgs);
  }
  return launchClient(root, action, clientArgs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => { console.error(`[laya-router] ${err.message}`); process.exitCode = 1; });
}
