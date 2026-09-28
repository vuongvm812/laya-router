import assert from 'node:assert/strict';
import http from 'node:http';
import { test, before, after } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile, copyFile, realpath } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOpenCodeConfig, openCodeArgs } from './opencode.mjs';
import layaRouterPlugin from './opencode-plugin.mjs';
import { stats } from './usage.mjs';

const jevRoot = process.env.JEV_ROOT;
let scratch;
before(async () => { scratch = await mkdtemp(join(tmpdir(), 'laya-router-opencode-')); });
after(async () => { await rm(scratch, { recursive: true, force: true }); });

const fast = 'gpt-5.4-mini';
const balanced = 'gpt-5.1';
const strong = 'gpt-5.5';
const haiku = 'claude-haiku-4-5-20251001';
const opus = 'claude-opus-4-6';
const model = (id, overrides = {}) => ({
  id, name: id, release_date: '2026-01-01', status: 'active',
  capabilities: { toolcall: true, reasoning: true, input: { text: true }, output: { text: true } },
  limit: { context: 200_000, output: 8192 }, cost: { input: 0, output: 0 }, ...overrides,
});

function setEnv(t, values) {
  const previous = { ...process.env };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
}

async function fakeClassifier() {
  const root = await mkdtemp(join(scratch, 'fake-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/config.mjs'), 'export const THRESHOLDS = { jevTimeoutMs: 1, jevDeadlineMs: 1, jevMaxRetries: 9 };');
  await writeFile(join(root, 'src/router-local.mjs'), `
    import { THRESHOLDS } from './config.mjs';
    export const calls = [];
    export const control = { choice: ${JSON.stringify(fast)}, confidence: 0.99, delay: 0, fail: false };
    export async function askJev(input) {
      calls.push({ ...structuredClone(input), thresholds: { ...THRESHOLDS } });
      if (control.delay) await new Promise(resolve => setTimeout(resolve, control.delay));
      if (control.fail) throw new Error('DO_NOT_LOG_SECRET');
      return { choice: control.choice, confidence: control.confidence };
    }
  `);
  return { root, ...await import(pathToFileURL(join(root, 'src/router-local.mjs')).href) };
}

async function fixture(t, options = {}) {
  const classifier = await fakeClassifier();
  setEnv(t, {
    JEV_ROOT: classifier.root, TYPESAFE_BASE_URL: 'http://127.0.0.1:1', TYPESAFE_DEFAULT_MODEL: 'multilingual', JEV_API_KEY: 'local-only',
    LAYA_ROUTER_TIMEOUT_MS: '2000', LAYA_ROUTER_DEADLINE_MS: '2500', LAYA_ROUTER_ENABLED: undefined, LAYA_ROUTER_MODELS: undefined,
    LAYA_USAGE_FILE: undefined,
    ...options.env,
  });
  const providerID = options.providerID ?? 'openai';
  const state = {
    providers: [{ id: providerID, models: Object.fromEntries((options.models ?? [model(fast), model(balanced), model(strong)]).map((item) => [item.id, item])) }],
    session: {}, history: [], agents: [{ name: 'build', mode: 'primary' }],
    ...options.state,
  };
  const logs = [];
  const reads = [];
  const get = (name, value) => { reads.push(name); return { data: value }; };
  const ctx = { client: {
    config: { providers: async () => get('providers', { providers: state.providers }) },
    session: {
      get: async () => get('session', state.session),
      messages: async () => get('history', state.history),
    },
    app: {
      agents: async () => get('agents', state.agents),
      log: async (entry) => { logs.push(entry.body); },
    },
  } };
  const hooks = await layaRouterPlugin(ctx);
  const turn = (overrides = {}) => {
    const output = {
      message: { id: 'msg-a', sessionID: 'session-a', role: 'user', agent: 'build', model: { providerID, modelID: options.current ?? strong, variant: 'high' } },
      parts: [{ type: 'text', text: '変数の名前を変更してください。' }],
      ...overrides,
    };
    return { output, run: () => hooks['chat.message']?.({ sessionID: output.message.sessionID, model: { ...output.message.model } }, output) };
  };
  return { ...classifier, hooks, logs, reads, state, ctx, turn };
}

test('launcher adds only the plugin; native models, credentials config, filters, agents and args survive', () => {
  const existing = {
    model: `openai/${strong}`, small_model: `openai/${fast}`, permission: { bash: 'ask' },
    plugin: ['existing-plugin'], agent: { reviewer: { model: `openai/${strong}` } },
    enabled_providers: ['openai'], disabled_providers: ['anthropic'],
    provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}', baseURL: 'http://local', headers: { custom: 'kept' } }, whitelist: [fast, strong] } },
  };
  const snapshot = structuredClone(existing);
  const result = buildOpenCodeConfig({ existing });
  const plugin = new URL('./opencode-plugin.mjs', import.meta.url).href;
  assert.deepEqual(existing, snapshot);
  assert.deepEqual(result, { ...existing, plugin: ['existing-plugin', plugin] });
  assert.deepEqual(buildOpenCodeConfig({ existing: result }), result);
  assert.deepEqual(buildOpenCodeConfig({ existing: { plugin: [[plugin, { retained: true }]] } }).plugin, [[plugin, { retained: true }]]);
  for (const args of [['run', 'こんにちは'], ['run', '--model', `openai/${strong}`, 'hello'], ['-mother/model'], ['run', '--', '--model=prompt']]) {
    assert.deepEqual(openCodeArgs(args), args);
  }
  assert.equal(buildOpenCodeConfig({ existing: '{"username":"me"}' }).username, 'me');
  assert.throws(() => buildOpenCodeConfig({ existing: '{' }), /valid JSON/);
  assert.throws(() => buildOpenCodeConfig({ existing: '[]' }), /JSON object/);
  assert.throws(() => buildOpenCodeConfig({ existing: { plugin: {} } }), /array/);
});

test('symlink launcher starts without JEV_ROOT or provider keys, preserves args/exit code, and does not load .env', async () => {
  const home = await mkdtemp(join(scratch, 'launcher-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(home, '.env'), 'ANTHROPIC_API_KEY=must-not-load\nOPENAI_API_KEY=must-not-load\n');
  await writeFile(join(bin, 'opencode'), `#!${process.execPath}\nconsole.log(JSON.stringify({args:process.argv.slice(2),config:JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),anthropic:process.env.ANTHROPIC_API_KEY,openai:process.env.OPENAI_API_KEY}));process.exitCode=7;`, { mode: 0o700 });
  const alias = join(home, 'launcher.mjs');
  await symlink(new URL('./opencode.mjs', import.meta.url), alias);
  const args = ['run', '--model', `openai/${strong}`, 'こんにちは'];
  await assert.rejects(promisify(execFile)(process.execPath, [alias, ...args], {
    cwd: home, env: { PATH: bin, HOME: home, NODE_OPTIONS: '', OPENCODE_CONFIG_CONTENT: '{"small_model":"openai/gpt-5.4-mini"}' }, timeout: 5000,
  }), (error) => {
    assert.equal(error.code, 7);
    const output = JSON.parse(error.stdout);
    assert.deepEqual(output.args, args);
    assert.equal(output.config.small_model, `openai/${fast}`);
    assert.equal(output.anthropic, undefined);
    assert.equal(output.openai, undefined);
    assert.equal(output.config.model, undefined);
    assert.equal(output.config.provider, undefined);
    return true;
  });
});

test('launcher forwards termination to the native child and exits cleanly with its signal status', { timeout: 5000 }, async (t) => {
  const home = await mkdtemp(join(scratch, 'signals-'));
  await writeFile(join(home, 'opencode'), `#!${process.execPath}\nsetInterval(() => {}, 1000);console.log('ready');`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./opencode.mjs', import.meta.url))], {
    cwd: home, env: { PATH: home, HOME: home, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  child.stdout.once('data', () => child.kill('SIGTERM'));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 143, signal: null });
});

test('discovery is lazy, never touches keys/options, and a native --model still routes within its provider', async (t) => {
  const f = await fixture(t);
  const forbidden = { get() { throw new Error('credential access'); } };
  for (const provider of f.state.providers) {
    Object.defineProperty(provider, 'key', forbidden);
    Object.defineProperty(provider, 'options', forbidden);
    for (const item of Object.values(provider.models)) Object.defineProperty(item, 'options', forbidden);
  }
  f.state.providers.push({ id: 'anthropic', models: { [haiku]: model(haiku) } });
  assert.deepEqual(f.reads, []);
  const turn = f.turn();
  const originalMessage = turn.output.message;
  await turn.run();
  assert.equal(turn.output.message, originalMessage);
  assert.deepEqual(turn.output.message.model, { providerID: 'openai', modelID: fast });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].prompt, '変数の名前を変更してください。');
  assert.deepEqual(f.calls[0].models.map((item) => item.id), [fast, balanced, strong]);
  assert.deepEqual(f.calls[0].thresholds, { jevTimeoutMs: 2000, jevDeadlineMs: 2500, jevMaxRetries: 0 });
  assert.ok(f.logs.every((entry) => entry.service === 'laya-router'));
  assert.doesNotMatch(JSON.stringify(f.logs), /local-only|credential access|変数/);
});

test('same-model decisions preserve variant; failure, low confidence and invented/cross-provider choices retain the exact original', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { choice: strong }, { choice: fast, confidence: 0.29 }, { choice: fast, confidence: NaN },
    { choice: fast, confidence: 1.1 }, { choice: haiku, confidence: 1 }, { fail: true },
  ]) {
    Object.assign(f.control, { choice: fast, confidence: 0.99, fail: false }, change);
    const turn = f.turn();
    const original = turn.output.message.model;
    await turn.run();
    assert.equal(turn.output.message.model, original);
    assert.equal(original.variant, 'high');
  }
  assert.doesNotMatch(JSON.stringify(f.logs), /DO_NOT_LOG_SECRET/);
});

test('opt-out, synthetic/tool/subtask turns, pinned agents and child sessions never classify', async (t) => {
  const f = await fixture(t);
  for (const parts of [
    [{ type: 'text', text: 'Continue', synthetic: true }],
    [{ type: 'text', text: 'Ignore', ignored: true }],
    [{ type: 'tool', state: { output: 'result' } }],
    [{ type: 'text', text: 'Injected' }, { type: 'subtask', prompt: 'subtask' }],
  ]) await f.turn({ parts }).run();
  f.state.session.parentID = 'parent';
  await f.turn().run();
  delete f.state.session.parentID;
  for (const agent of [
    { name: 'build', mode: 'primary', model: { providerID: 'openai', modelID: strong } },
    { name: 'build', mode: 'primary', model: `openai/${strong}` },
    { name: 'build', mode: 'subagent' }, { name: 'build', mode: 'primary', hidden: true },
  ]) { f.state.agents = [agent]; await f.turn().run(); }
  process.env.LAYA_ROUTER_ENABLED = '0';
  const disabled = await layaRouterPlugin(f.ctx);
  assert.equal(typeof disabled.event, 'function', 'usage remains enabled when routing is disabled');
  await disabled['chat.message']({}, {});
  await f.turn().run();
  assert.equal(f.calls.length, 0);
});

test('unknown selected models remain exact; explicit same-provider tier mapping enables future and custom models', async (t) => {
  const f = await fixture(t, { providerID: 'custom', current: 'future-strong', models: [model('future-fast'), model('future-strong')] });
  await f.turn().run();
  assert.equal(f.calls.length, 0);
  process.env.LAYA_ROUTER_MODELS = JSON.stringify({ custom: { fast: 'future-fast', strong: 'future-strong' } });
  f.control.choice = 'future-fast';
  const turn = f.turn();
  await turn.run();
  assert.deepEqual(turn.output.message.model, { providerID: 'custom', modelID: 'future-fast' });
  for (const mapping of ['[]', '{', '{"custom":{"fast":"not-loaded"}}', '{"custom":{"wrong":"future-fast"}}', '{"custom":{"fast":"future-fast","strong":"future-fast"}}']) {
    process.env.LAYA_ROUTER_MODELS = mapping;
    const next = f.turn();
    await next.run();
    assert.equal(next.output.message.model.modelID, 'future-strong');
  }
  assert.equal(f.calls.length, 1);
});

test('compact newest eligible Claude tiers include the current exact fallback and honor registry filtering', async (t) => {
  const old = 'claude-opus-4-20250514';
  const sonnet = 'claude-sonnet-4-6';
  const f = await fixture(t, { providerID: 'anthropic', current: old, models: [
    model(haiku), model('claude-haiku-3-old', { release_date: '2024-01-01' }), model(sonnet),
    model(opus), model(old, { release_date: '2025-01-01' }), model('claude-fable-5-1'),
    model('claude-opus-9', { release_date: '2030-01-01', limit: { context: 4000, output: 2000 } }),
  ] });
  f.control.choice = haiku;
  const turn = f.turn();
  await turn.run();
  assert.deepEqual(f.calls[0].models.map((item) => item.id), [haiku, sonnet, opus, old]);
  assert.equal(turn.output.message.model.modelID, haiku);
  delete f.state.providers[0].models[haiku];
  await f.turn().run();
  assert.ok(!f.calls[1].models.some((item) => item.id === haiku), 'each turn uses the current loaded registry');
});

test('reviewed GPT-5 families work with zero OAuth prices; unfamiliar GPT-6/pro IDs are not invented tiers', async (t) => {
  const ids = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.1-codex-mini', 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.2-codex', 'gpt-5.4', 'gpt-5.5-pro', 'gpt-6-sol'];
  const f = await fixture(t, { current: 'gpt-5.2-codex', models: ids.map((id) => model(id)) });
  await f.turn().run();
  const choices = f.calls[0].models;
  assert.equal(choices[0].tier, 'haiku');
  assert.equal(choices[1].tier, 'sonnet');
  assert.equal(choices[2].tier, 'opus');
  assert.ok(!choices.some((item) => /gpt-6|pro/.test(item.id)));
  for (const id of ['gpt-6-sol', 'gpt-5.5-pro']) {
    const turn = f.turn();
    turn.output.message.model.modelID = id;
    await turn.run();
    assert.equal(turn.output.message.model.modelID, id);
  }
  assert.equal(f.calls.length, 1);
});

test('Jev named GPT models route within OpenAI; Astra is a retained strong model, never an implicit upgrade', async (t) => {
  const luna = 'gpt-5.6-luna', terra = 'gpt-5.6-terra', sol = 'gpt-5.6-sol', astra = 'gpt-6-astra';
  const f = await fixture(t, { current: astra, models: [luna, terra, sol, astra, 'gpt-6-unknown'].map((id) => model(id)) });
  f.control.choice = luna;
  const a = f.turn();
  await a.run();
  assert.deepEqual(a.output.message.model, { providerID: 'openai', modelID: luna });
  assert.deepEqual(f.calls[0].models.map(({ id, tier }) => [id, tier]), [[luna, 'haiku'], [terra, 'sonnet'], [astra, 'opus']]);
  assert.equal(f.calls[0].current, astra);
  for (const current of [luna, terra, sol]) {
    const turn = f.turn();
    turn.output.message.model.modelID = current;
    f.control.choice = astra; // A classifier cannot escalate into the opt-in tier.
    await turn.run();
    assert.equal(turn.output.message.model.modelID, current);
    assert.deepEqual(f.calls.at(-1).models.map((item) => item.id), [luna, terra, sol]);
  }
  process.env.LAYA_ROUTER_MODELS = JSON.stringify({ openai: { fast: luna, balanced: terra, strong: astra } });
  const explicit = f.turn();
  explicit.output.message.model.modelID = luna;
  await explicit.run();
  assert.equal(explicit.output.message.model.modelID, astra, 'explicit mapping opts into Astra');
});

function completedMessage(overrides = {}) {
  return {
    id: 'response-one', role: 'assistant', sessionID: 'root', providerID: 'openai', modelID: strong,
    finish: 'stop', time: { created: Date.now() - 1, completed: Date.now() },
    tokens: { input: 11, output: 8, reasoning: 5, cache: { read: 17, write: 19 } },
    ...overrides,
  };
}

const usageEvent = (info, type = 'message.updated') => ({ event: { type, properties: { info } } });
const observeUnfinished = (hooks, message) => hooks.event(usageEvent({
  ...message, finish: undefined, error: undefined, time: { created: message.time?.created },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}));
const observeCompleted = async (hooks, message) => {
  await observeUnfinished(hooks, message);
  await hooks.event(usageEvent(message));
};
const usageTotals = { inputTokens: 11, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 19,
  reasoningTokens: 5, totalTokens: 60, requests: 1 };

test('completed usage is recorded with routing disabled and no classifier; duplicate snapshots count once', async (t) => {
  const home = await mkdtemp(join(scratch, 'usage-'));
  const file = join(home, 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file, LAYA_ROUTER_ENABLED: '0', JEV_ROOT: undefined } });
  const message = completedMessage({ summary: 'DO_NOT_STORE_CONTENT' });
  const original = structuredClone(message);
  await f.hooks.event(usageEvent({ id: 'root' }, 'session.created'));
  await observeUnfinished(f.hooks, message);
  // Cached roots must append before returning the promise; event dispatch is unawaited.
  const pending = f.hooks.event(usageEvent(message));
  assert.equal(stats({ file }).last5h.requests, 1);
  await pending;
  await f.hooks.event(usageEvent(message));
  assert.deepEqual(message, original);
  assert.deepEqual(stats({ file }).last5h, usageTotals);
  assert.deepEqual(stats({ file }).last7d, usageTotals);
  assert.equal(stats({ file }).latestSession.sessionID, 'root');
  assert.equal(stats({ file }).latestSession.requests, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.reads, [], 'recording needs no provider, classifier or auth discovery');
  assert.doesNotMatch(await readFile(file, 'utf8'), /DO_NOT_STORE_CONTENT/);
});

test('nested subagent usage aggregates into the root; concurrent snapshots share ancestry and preserve original events', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'ancestry-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  const lookups = [];
  f.ctx.client.session.get = async ({ path: { id } }) => {
    lookups.push(id);
    await delay(5);
    return { data: { id, parentID: { child: 'middle', middle: 'root' }[id] } };
  };
  const child = completedMessage({ id: 'child-response', sessionID: 'child', finish: 'tool-calls' });
  const original = structuredClone(child);
  await observeUnfinished(f.hooks, child);
  await Promise.all([f.hooks.event(usageEvent(child)), f.hooks.event(usageEvent(child))]);
  await f.hooks.event(usageEvent(child));
  await observeCompleted(f.hooks, completedMessage());
  assert.deepEqual(child, original);
  assert.deepEqual(lookups, ['child', 'middle', 'root', 'root']);
  const result = stats({ file });
  assert.equal(result.latestSession.sessionID, 'root');
  assert.equal(result.latestSession.requests, 2);
  assert.equal(result.latestSession.totalTokens, 120);
  assert.equal(result.last5h.requests, 2);
});

test('unavailable/cyclic ancestry falls back stably to its own session; the ancestry cache is bounded', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'fallback-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  let reads = 0;
  f.ctx.client.session.get = async () => { reads++; throw new Error('PRIVATE_LOOKUP_ERROR'); };
  const child = completedMessage({ sessionID: 'unavailable' });
  await observeCompleted(f.hooks, child);
  f.ctx.client.session.get = async ({ path: { id } }) => { reads++; return { data: { id, parentID: 'root' } }; };
  await f.hooks.event(usageEvent(child));
  assert.equal(reads, 1, 'later snapshots keep the first attribution even if lookup recovers');
  assert.equal(stats({ file }).latestSession.sessionID, 'unavailable');
  assert.equal(stats({ file }).last5h.requests, 1);
  const cycle = completedMessage({ sessionID: 'cycle', id: 'cycle-response' });
  f.ctx.client.session.get = async ({ path: { id } }) => ({ data: { id, parentID: id } });
  await observeCompleted(f.hooks, cycle);
  assert.equal(stats({ file }).last5h.requests, 2);
  for (let index = 0; index < 520; index++) await f.hooks.event(usageEvent({ id: `cache-${index}` }, 'session.created'));
  reads = 0;
  f.ctx.client.session.get = async () => { reads++; return { data: {} }; };
  await observeCompleted(f.hooks, completedMessage({ sessionID: 'cache-0', id: 'evicted' }));
  assert.equal(reads, 1, 'old cache entries are evicted');
  assert.doesNotMatch(await readFile(file, 'utf8'), /PRIVATE_LOOKUP_ERROR/);
});

test('slow ancestry times out to a stable own-session key and late lookup completion cannot duplicate attribution', { timeout: 5000 }, async (t) => {
  const file = join(await mkdtemp(join(scratch, 'slow-ancestry-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  let release;
  let lookups = 0;
  f.ctx.client.session.get = () => { lookups++; return new Promise((resolve) => { release = resolve; }); };
  const message = completedMessage({ sessionID: 'slow-child' });
  const original = structuredClone(message);
  await observeCompleted(f.hooks, message);
  assert.deepEqual(message, original);
  assert.equal(stats({ file }).latestSession.sessionID, 'slow-child');
  release({ data: { parentID: 'root' } });
  await delay(10);
  await f.hooks.event(usageEvent(message));
  assert.equal(lookups, 1);
  assert.equal(stats({ file }).latestSession.sessionID, 'slow-child');
  assert.deepEqual(stats({ file }).last5h, usageTotals);
});

test('ancestry cache eviction preserves the globally unique response ID when attribution recovers', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'recovered-attribution-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  const message = completedMessage({ sessionID: 'child', id: 'global-response-id' });
  f.ctx.client.session.get = async () => { throw new Error('unavailable'); };
  await observeCompleted(f.hooks, message);
  for (let index = 0; index < 512; index++) await f.hooks.event(usageEvent({ id: `other-${index}` }, 'session.created'));
  f.ctx.client.session.get = async ({ path: { id } }) => ({ data: { id, parentID: id === 'child' ? 'root' : undefined } });
  await f.hooks.event(usageEvent(message));
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.sessionID), ['child', 'root']);
  assert.deepEqual(rows.map((row) => [row.client, row.responseID]), [
    ['opencode', 'global-response-id'], ['opencode', 'global-response-id'],
  ]);
  // Ledger contract: OpenCode deduplicates on [client, responseID], independently
  // of the best-effort session attribution. That policy belongs to usage.mjs.
});

test('unfinished, failed, aborted, unknown and invalid usage updates never enter the ledger', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'invalid-usage-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  let id = 0;
  for (const change of [
    { role: 'user' }, { time: { created: Date.now() } }, { error: { name: 'MessageAbortedError' } },
    { error: { name: 'APIError' } }, { finish: 'unknown' }, { finish: 'error' },
    { tokens: undefined }, { tokens: { input: 5 } },
    { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  ]) await observeCompleted(f.hooks, completedMessage({ id: `invalid-${id++}`, ...change }));
  await f.hooks.event(usageEvent(completedMessage(), 'message.part.updated'));
  assert.equal(stats({ file }).last5h.requests, 0);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('historical fork/import and completed-only attachment never count as generation', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'fork-usage-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file, LAYA_ROUTER_ENABLED: '0' } });
  const original = completedMessage();
  await observeCompleted(f.hooks, original);
  const before = await readFile(file, 'utf8');
  const forked = { ...original, id: 'fork-new-id', sessionID: 'fork-session' };
  await f.hooks.event(usageEvent({ id: 'fork-session' }, 'session.created'));
  await f.hooks.event(usageEvent(forked));
  await f.hooks.event(usageEvent({ ...original, id: 'import-new-id' }));
  const attached = await layaRouterPlugin(f.ctx);
  await attached.event(usageEvent(original));
  assert.equal(await readFile(file, 'utf8'), before, 'completed-only events never append, even with new message IDs');
  assert.deepEqual(stats({ file }).last5h, usageTotals);
  const live = completedMessage({ id: 'observed-after-attachment' });
  await observeCompleted(attached, live);
  assert.equal(stats({ file }).last5h.requests, 2, 'an unfinished update observed after attachment qualifies');
});

test('evicted pending lifecycles cannot be rearmed or counted by late completion', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'evicted-lifecycle-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  const created = Date.now() - 10_000;
  const old = completedMessage({ id: 'old-pending', time: { created, completed: Date.now() } });
  await observeUnfinished(f.hooks, old);
  let newest;
  for (let index = 1; index <= 1024; index++) {
    newest = completedMessage({ id: `pending-${index}`, time: { created: created + index, completed: Date.now() } });
    await observeUnfinished(f.hooks, newest);
  }
  await f.hooks.event(usageEvent(old));
  await observeCompleted(f.hooks, old); // Another old unfinished update must not resurrect the evicted entry.
  assert.equal(stats({ file }).last5h.requests, 0);
  await f.hooks.event(usageEvent(newest));
  await f.hooks.event(usageEvent(newest));
  assert.deepEqual(stats({ file }).last5h, usageTotals);
});

test('a failed lifecycle cannot later be rearmed into a successful accounting snapshot', async (t) => {
  const file = join(await mkdtemp(join(scratch, 'failed-lifecycle-')), 'usage.jsonl');
  const f = await fixture(t, { env: { LAYA_USAGE_FILE: file } });
  const message = completedMessage();
  await observeUnfinished(f.hooks, message);
  await f.hooks.event(usageEvent({ ...message, error: { name: 'MessageAbortedError' } }));
  await observeCompleted(f.hooks, message);
  assert.equal(stats({ file }).last5h.requests, 0);
});

test('context, tool capability and file guards forbid unsafe switching including missing long-history usage', async (t) => {
  const f = await fixture(t);
  f.state.providers[0].models[balanced].capabilities.toolcall = false;
  for (const history of [
    [{ info: { role: 'assistant', tokens: { input: 30_000, output: 100, cache: { read: 10_000 } } }, parts: [] }],
    [{ info: { role: 'user' }, parts: [{ type: 'text', text: 'long'.repeat(2500) }] }],
  ]) {
    f.state.history = history;
    const turn = f.turn();
    await turn.run();
    assert.equal(turn.output.message.model.modelID, strong);
  }
  f.state.history = [];
  for (const mime of ['image/png', 'application/pdf', 'text/plain', 'application/octet-stream']) {
    const turn = f.turn({ parts: [{ type: 'text', text: 'Explain this file' }, { type: 'file', mime, url: 'data:mock' }] });
    await turn.run();
    assert.equal(turn.output.message.model.modelID, strong);
  }
  f.state.providers[0].models[fast].limit = { context: 4000, output: 2000 };
  await f.turn().run();
  assert.equal(f.calls.length, 0);
  f.state.history = undefined;
  await f.turn().run();
  assert.equal(f.calls.length, 0);
});

test('unconfigured local classifier and malformed budgets fail open; prompts are bounded and sessions do not share choices', async (t) => {
  const f = await fixture(t);
  delete process.env.JEV_ROOT;
  await f.turn().run();
  assert.match(f.logs.at(-1).message, /local classifier unconfigured/);
  process.env.JEV_ROOT = f.root;
  process.env.LAYA_ROUTER_TIMEOUT_MS = '-1';
  await f.turn().run();
  assert.equal(f.calls.length, 0);
  process.env.LAYA_ROUTER_TIMEOUT_MS = '2000';
  const a = f.turn({ parts: [{ type: 'text', text: '日本語 '.repeat(3000) }] });
  a.output.message.model.modelID = fast; // Large context permits an upgrade, never a downgrade.
  await a.run();
  assert.ok(f.calls[0].prompt.length <= 4096);
  assert.match(f.calls[0].prompt, /^日本語/);
  const b = f.turn();
  b.output.message.sessionID = 'session-b';
  f.control.confidence = 0;
  await b.run();
  assert.equal(b.output.message.model.modelID, strong);
  assert.equal(f.calls[1].current, strong);
});

test('deadline cannot mutate a turn after it has already fallen back', async (t) => {
  const f = await fixture(t, { env: { LAYA_ROUTER_TIMEOUT_MS: '10', LAYA_ROUTER_DEADLINE_MS: '20' } });
  f.control.delay = 60;
  const turn = f.turn();
  await turn.run();
  assert.equal(turn.output.message.model.modelID, strong);
  await delay(80);
  assert.equal(turn.output.message.model.modelID, strong);
});

test('every hung routing lookup is bounded, aborted, and cannot resume routing after fallback', { timeout: 5000 }, async (t) => {
  for (const [group, method, response] of [
    ['session', 'get', { data: {} }],
    ['app', 'agents', { data: [{ name: 'build', mode: 'primary' }] }],
    ['config', 'providers', { data: { providers: [] } }],
    ['session', 'messages', { data: [] }],
  ]) await t.test(`${group}.${method}`, async (t) => {
    const f = await fixture(t, { env: { LAYA_ROUTER_TIMEOUT_MS: '40', LAYA_ROUTER_DEADLINE_MS: '80' } });
    let release, signal;
    f.ctx.client[group][method] = (options) => {
      signal = options.signal;
      return new Promise((resolve) => { release = resolve; });
    };
    const turn = f.turn();
    const original = turn.output.message.model;
    await turn.run();
    assert.equal(turn.output.message.model, original);
    assert.equal(signal.aborted, true, 'top-level SDK abort signal is cancelled');
    assert.equal(f.calls.length, 0);
    const reads = [...f.reads];
    release(response);
    await delay(20);
    assert.equal(turn.output.message.model, original);
    assert.deepEqual(f.reads, reads, 'late resolution must not advance to another lookup');
    assert.equal(f.calls.length, 0);
  });
});

test('routing lookups share one overall deadline instead of receiving a new budget per call', async (t) => {
  const f = await fixture(t, { env: { LAYA_ROUTER_TIMEOUT_MS: '40', LAYA_ROUTER_DEADLINE_MS: '90' } });
  for (const [group, method] of [['session', 'get'], ['app', 'agents'], ['config', 'providers'], ['session', 'messages']]) {
    const original = f.ctx.client[group][method];
    f.ctx.client[group][method] = async (...args) => { await delay(35); return original(...args); };
  }
  const turn = f.turn();
  await turn.run();
  await delay(50);
  assert.equal(turn.output.message.model.modelID, strong);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.reads.includes('history'), 'the overall deadline prevents reaching the fourth lookup');
});

test('a hung or rejecting logger cannot hold successful routing or fallback', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const signals = [];
  f.ctx.client.app.log = ({ signal }) => { signals.push(signal); return new Promise(() => {}); };
  const routed = f.turn();
  await routed.run();
  assert.equal(routed.output.message.model.modelID, fast);
  f.control.confidence = 0;
  const fallback = f.turn();
  await fallback.run();
  assert.equal(fallback.output.message.model.modelID, strong);
  await delay(120);
  assert.ok(signals.length === 2 && signals.every((signal) => signal.aborted));
  f.ctx.client.app.log = async () => { throw new Error('PRIVATE_LOGGER_ERROR'); };
  await f.turn().run();
});

async function listen(t, handler) {
  const server = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function realClassifier(t, { wait = 0 } = {}) {
  const root = await mkdtemp(join(scratch, 'sdk-'));
  await mkdir(join(root, 'src'));
  // Use real pinned askJev + SDK in an isolated copy; never run prepare against the
  // installation or change real config. Only replace its logger with a silent fixture.
  await copyFile(join(jevRoot, 'src/config.mjs'), join(root, 'src/config.mjs'));
  const source = await readFile(join(jevRoot, 'src/router.mjs'), 'utf8');
  await writeFile(join(root, 'src/router-local.mjs'), source.replace('"./log.mjs"', '"./log-local.mjs"'));
  await writeFile(join(root, 'src/log-local.mjs'), 'export const log = () => {};');
  await symlink(join(jevRoot, 'node_modules'), join(root, 'node_modules'));
  const requests = [];
  const baseURL = await listen(t, async (req, res) => {
    const body = await bodyOf(req);
    requests.push({ url: req.url, headers: req.headers, body });
    if (wait) await delay(wait);
    const ids = Object.keys(body.questions.model.criteria);
    const answers = { model: { type: 'choice', choice: ids[0], confidence: 0.99, probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])) } };
    for (const name of ['task_complexity', 'reasoning_required', 'tool_complexity']) {
      answers[name] = { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: { 1: 1 } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'multilingual', answers, usage: { input_tokens: 100, output_tokens: 4 } }));
  });
  return { root, requests, env: {
    JEV_ROOT: root, TYPESAFE_BASE_URL: baseURL, TYPESAFE_DEFAULT_MODEL: 'multilingual', JEV_API_KEY: 'classifier-local-key',
    LAYA_ROUTER_TIMEOUT_MS: '3000', LAYA_ROUTER_DEADLINE_MS: '4000',
  } };
}

test('real SDK uses the local four-question protocol and the plugin process budget before its first call', {
  skip: !jevRoot && 'Set JEV_ROOT to the pinned checkout with installed SDK', timeout: 15_000,
}, async (t) => {
  const f = await fixture(t);
  const classifier = await realClassifier(t, { wait: 1700 }); // Exceeds Jev's upstream 1500ms default.
  Object.assign(process.env, classifier.env);
  const turn = f.turn();
  await turn.run();
  assert.equal(turn.output.message.model.modelID, fast);
  assert.equal(classifier.requests.length, 1, 'no SDK retries');
  const request = classifier.requests[0];
  assert.equal(request.url, '/v1/systemone');
  assert.equal(request.headers.authorization, 'Bearer classifier-local-key');
  assert.equal(request.body.model, 'multilingual');
  assert.deepEqual(Object.keys(request.body.questions).sort(), ['model', 'reasoning_required', 'task_complexity', 'tool_complexity']);
  assert.deepEqual(Object.keys(request.body.questions.model.criteria), [fast, balanced, strong]);
  assert.doesNotMatch(JSON.stringify(request.body), /apiKey|authorization|options|classifier-local-key/);
});

function anthropicEvents(body, file, tool) {
  const block = tool ? { type: 'tool_use', id: 'call_read', name: 'read', input: {} } : { type: 'text', text: '' };
  return [
    { type: 'message_start', message: { id: `msg_${tool ? 'tool' : 'final'}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 17, cache_creation_input_tokens: 19 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ filePath: file }) } : { type: 'text_delta', text: 'LOCAL_MOCK_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 13 } },
    { type: 'message_stop' },
  ];
}

function openaiEvents(body, file, tool) {
  const response = { id: `resp_${tool ? 'tool' : 'final'}`, object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] };
  const item = tool
    ? { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read', arguments: JSON.stringify({ filePath: file }), status: 'completed' }
    : { type: 'message', id: 'msg_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'LOCAL_MOCK_OK', annotations: [] }] };
  return [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } },
    ...(tool ? [
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
      { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
    ] : [
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'LOCAL_MOCK_OK' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'LOCAL_MOCK_OK' },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    ]),
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 12 } } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

for (const [providerID, enabled] of [['anthropic', true], ['openai', true], ['openai', false]]) {
  test(`installed OpenCode native ${providerID} (routing ${enabled ? 'on' : 'off'}) records exact usage through a tool continuation`, {
    skip: !jevRoot || process.env.OPENCODE_LIVE_TEST !== '1' ? 'Set JEV_ROOT and OPENCODE_LIVE_TEST=1 for isolated real CLI tests' : false,
    timeout: 120_000,
  }, async (t) => {
    const home = await realpath(await mkdtemp(join(scratch, `live-${providerID}-`)));
    const file = join(home, 'note.txt');
    const ledger = join(home, 'usage.jsonl');
    await writeFile(file, 'LOCAL_FILE_CONTENT\n');
    const classifier = await realClassifier(t);
    const requests = [];
    const upstream = await listen(t, async (req, res) => {
      const body = await bodyOf(req);
      requests.push({ path: req.url, body, headers: req.headers });
      const tool = requests.length === 1;
      const events = providerID === 'openai' ? openaiEvents(body, file, tool) : anthropicEvents(body, file, tool);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    const cheap = providerID === 'openai' ? 'gpt-5.6-luna' : haiku;
    const initial = providerID === 'openai' ? 'gpt-6-astra' : opus;
    // Replay actual bus events through another collector to exercise duplicate
    // completed snapshots end-to-end, without generating extra provider requests.
    const replay = join(home, 'replay-events.mjs');
    await writeFile(replay, `import plugin from ${JSON.stringify(new URL('./opencode-plugin.mjs', import.meta.url).href)};
      export default async ctx => {
        const collector = await plugin(ctx);
        return { event: async input => { await collector.event(input); await collector.event(input); } };
      };`);
    const config = {
      autoupdate: false, share: 'disabled', snapshot: false,
      permission: { '*': 'deny', read: 'allow' },
      model: `${providerID}/${initial}`, small_model: `${providerID}/${cheap}`,
      enabled_providers: [providerID],
      plugin: [pathToFileURL(replay).href],
      provider: { [providerID]: {
        npm: `@ai-sdk/${providerID}`, options: { apiKey: 'mock-native-key', baseURL: `${upstream}/v1` },
        whitelist: [cheap, initial],
        models: Object.fromEntries([cheap, initial].map((id) => [id, {
          id, name: id, tool_call: true, modalities: { input: ['text'], output: ['text'] },
          limit: { context: 200_000, output: 8192 },
        }])),
      } },
    };
    // Allowlisted env only: no real auth, global plugins, cloud URLs or key variables.
    const env = {
      PATH: process.env.PATH, HOME: home, TMPDIR: scratch, TERM: 'dumb', NO_COLOR: '1', NODE_OPTIONS: '',
      XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.data'),
      XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ...classifier.env,
      LAYA_USAGE_FILE: ledger, LAYA_ROUTER_ENABLED: enabled ? '1' : '0',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
    };
    const child = spawn(process.execPath, [fileURLToPath(new URL('./opencode.mjs', import.meta.url)),
      'run', '--format', 'json', '--model', `${providerID}/${initial}`, '--title', 'Local routing test', 'Read note.txt and reply LOCAL_MOCK_OK.'],
    { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    t.after(kill);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(kill, 90_000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, `${result.signal}\n${stderr}\n${stdout}`);
    assert.match(stdout, /LOCAL_MOCK_OK/, `${stderr}\n${stdout}`);
    assert.equal(classifier.requests.length, enabled ? 1 : 0, `classification follows routing opt-out\n${stderr}\n${stdout}`);
    assert.equal(requests.length, 2, `expected initial generation and tool continuation\n${stderr}\n${stdout}`);
    assert.ok(requests.every((request) => request.body.model === (enabled ? cheap : initial)));
    assert.ok(JSON.stringify(requests[1].body).includes('LOCAL_FILE_CONTENT'), `read tool must return the fixture file\n${stdout}`);
    if (providerID === 'openai') {
      assert.ok(requests.every((request) => request.path === '/v1/responses'));
      assert.equal(requests[0].headers.authorization, 'Bearer mock-native-key');
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(requests[0].headers['x-api-key'], undefined);
      assert.ok(requests[1].body.input.some((item) => item.type === 'function_call_output'));
    } else {
      assert.ok(requests.every((request) => request.path === '/v1/messages'));
      assert.equal(requests[0].headers['x-api-key'], 'mock-native-key');
    }
    const rows = (await readFile(ledger, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.length >= 6, 'two real completed messages, including replayed duplicate event snapshots');
    assert.equal(new Set(rows.map((row) => row.responseID)).size, 2);
    assert.equal(new Set(rows.map((row) => row.sessionID)).size, 1);
    assert.ok(rows.every((row) => row.client === 'opencode' && row.model === `${providerID}/${enabled ? cheap : initial}`));
    const expected = providerID === 'openai'
      ? { inputTokens: 80, outputTokens: 60, cacheReadTokens: 120, cacheWriteTokens: 0, reasoningTokens: 24, totalTokens: 260, requests: 2 }
      : { inputTokens: 22, outputTokens: 26, cacheReadTokens: 34, cacheWriteTokens: 38, reasoningTokens: 0, totalTokens: 120, requests: 2 };
    const measured = stats({ file: ledger });
    assert.deepEqual(measured.last5h, expected);
    assert.deepEqual(measured.last7d, expected);
    const { client, sessionID, lastActivity, ...latest } = measured.latestSession;
    assert.equal(client, 'opencode');
    assert.equal(sessionID, rows[0].sessionID);
    assert.ok(lastActivity > 0);
    assert.deepEqual(latest, expected);
  });
}
