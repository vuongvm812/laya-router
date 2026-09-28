import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, configure, check } from './runtime.mjs';
import { prepare } from './prepare.mjs';
import { stats } from './usage.mjs';

const jevRoot = process.env.JEV_ROOT;
test('real SDK local endpoint, four answers, runtime budgets, and shipped CLI launchers', {
  skip: !jevRoot && 'Set JEV_ROOT to the pinned checkout with npm ci completed', timeout: 30000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'laya-jev-runtime-'));
  const originalEnv = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(scratch, { recursive: true, force: true });
  });
  const home = join(scratch, 'home');
  await mkdir(home);
  await mkdir(join(scratch, 'tools'));
  await mkdir(join(scratch, 'bin'));
  const fixtureRoot = join(scratch, 'jev-router');
  await mkdir(fixtureRoot);
  await cp(join(jevRoot, 'src'), join(fixtureRoot, 'src'), { recursive: true, filter: (file) => !file.endsWith('-local.mjs') });
  await copyFile(join(jevRoot, 'package.json'), join(fixtureRoot, 'package.json'));
  await symlink(join(jevRoot, 'node_modules'), join(fixtureRoot, 'node_modules'));
  prepare(fixtureRoot);
  await copyFile(new URL('./runtime.mjs', import.meta.url), join(scratch, 'tools/runtime.mjs'));
  await copyFile(new URL('./usage.mjs', import.meta.url), join(scratch, 'tools/usage.mjs'));
  process.env.TMPDIR = scratch;
  process.env.HOME = home;
  let mode = 'valid';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ status: 'ok', loaded: ['english'], checkpoint_devices: { english: 'mps' }, cpu_fallbacks: { english: { count: 0 } } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, headers: req.headers, body });
    if (mode === 'error') { res.writeHead(503); res.end('{}'); return; }
    const ids = Object.keys(body.questions.model.criteria);
    const answers = {
      model: { type: 'choice', choice: ids[0], confidence: 0.9, probabilities: Object.fromEntries(ids.map((id, index) => [id, index === 0 ? 1 : 0])) },
    };
    for (const id of ['task_complexity', 'reasoning_required', 'tool_complexity']) {
      answers[id] = { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: { 1: 1 } };
    }
    if (mode === 'malformed') delete answers.tool_complexity;
    res.end(JSON.stringify({ model: 'english', answers, usage: { input_tokens: 100, output_tokens: 4 } }));
  });
  await new Promise((yes) => server.listen(0, '127.0.0.1', yes));
  t.after(() => new Promise((yes) => { server.close(yes); server.closeAllConnections(); }));
  const config = { backend: 'native', checkpoint: 'english', port: server.address().port, key: 'a'.repeat(64), timeoutMs: 1000, deadlineMs: 1500 };
  await writeFile(join(scratch, 'install.json'), JSON.stringify(config));

  await t.test('reject invalid persisted settings and override ambient cloud classifier settings', async () => {
    assert.deepEqual(loadConfig(scratch), config);
    await writeFile(join(scratch, 'install.json'), JSON.stringify({ ...config, port: 0 }));
    assert.throws(() => loadConfig(scratch), /Invalid install/);
    await writeFile(join(scratch, 'install.json'), JSON.stringify(config));
    process.env.TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
    process.env.TYPESAFE_DEFAULT_MODEL = 'jev-latest';
    process.env.JEV_API_KEY = 'cloud-key';
    configure(scratch, config);
    assert.equal(process.env.TYPESAFE_BASE_URL, `http://127.0.0.1:${config.port}`);
    assert.equal(process.env.JEV_API_KEY, config.key);
    assert.equal(process.env.TYPESAFE_DEFAULT_MODEL, 'english');
  });
  await t.test('actual SDK and askJev send authenticated four-question requests to Laya', async () => {
    const result = await check(scratch, config, { verbose: false });
    assert.equal(result.choice, 'claude-haiku-4-5-20251001');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, '/v1/systemone');
      assert.equal(request.headers.authorization, `Bearer ${config.key}`);
      assert.equal(request.body.model, 'english');
      assert.deepEqual(Object.keys(request.body.questions).sort(), ['model', 'reasoning_required', 'task_complexity', 'tool_complexity']);
      assert.deepEqual(Object.keys(request.body.questions.model.criteria), request.body.state.environment.available_models);
    }
  });
  await t.test('incomplete classifier responses and HTTP failure fail startup', async () => {
    mode = 'malformed';
    await assert.rejects(check(scratch, config, { verbose: false }), /tool_complexity/);
    mode = 'error';
    await assert.rejects(check(scratch, config, { verbose: false }));
    mode = 'valid';
  });

  async function launch(client) {
    // Only probe the loopback proxy; never send requests to a generation provider.
    await writeFile(join(scratch, 'bin', client), `#!${process.execPath}\n` + `
const args = process.argv.slice(2);
if (process.env.LAYA_TEST_SAVE_MODEL) {
 const fs = require('node:fs');
 const file = process.env.CLAUDE_CONFIG_DIR + '/settings.json';
 const settings = JSON.parse(fs.readFileSync(file,'utf8'));
 settings.model = process.env.LAYA_TEST_SAVE_MODEL;
 fs.writeFileSync(file,JSON.stringify(settings));
}
const url = process.env.ANTHROPIC_BASE_URL || args.find(a => a.startsWith('model_providers.jev.base_url='))?.split('=')[1].replaceAll('"','');
fetch(url, {method:'HEAD'}).then(r => {
 console.log(JSON.stringify({args, proxy: url, model: process.env.ANTHROPIC_MODEL, classifier: process.env.TYPESAFE_BASE_URL, status: r.status}));
}).catch(e => { console.error(e); process.exitCode=1; });
`, { mode: 0o700 });
    const output = await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(scratch, 'tools/runtime.mjs'), client, '--help'], {
        env: { ...process.env, HOME: home, PATH: `${join(scratch, 'bin')}:${process.env.PATH}`, JEV_NO_STATUSLINE: '1', ANTHROPIC_MODEL: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      child.once('error', no);
      child.once('exit', (code) => code === 0 ? yes(stdout) : no(new Error(`launcher exited ${code}: ${stderr}`)));
    });
    return JSON.parse(output.trim());
  }
  await t.test('Claude launcher starts a separate generation proxy and preserves the local classifier', async () => {
    const result = await launch('claude');
    assert.equal(result.status, 200);
    assert.equal(result.model, 'laya-router');
    assert.equal(result.classifier, process.env.TYPESAFE_BASE_URL);
    assert.notEqual(result.proxy, result.classifier);
    assert.ok(result.args.includes('--help'));
  });
  await t.test('Claude picker restores prior models, clears stale sentinels, and preserves concrete choices', async () => {
    const configDir = join(home, 'claude-settings');
    await mkdir(configDir);
    const settingsFile = join(configDir, 'settings.json');
    process.env.CLAUDE_CONFIG_DIR = configDir;
    for (const [before, selected, expected] of [
      ['claude-sonnet-4-6', 'laya-router', 'claude-sonnet-4-6'],
      ['laya-router', 'laya-router', undefined],
      ['jev-router', 'laya-router', undefined],
      ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-6'],
    ]) {
      await writeFile(settingsFile, JSON.stringify({ model: before, unrelated: 'preserve' }));
      process.env.LAYA_TEST_SAVE_MODEL = selected;
      await launch('claude');
      const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      assert.equal(settings.model, expected);
      assert.equal(settings.unrelated, 'preserve');
    }
    delete process.env.LAYA_TEST_SAVE_MODEL;
  });
  await t.test('Codex launcher supplies Responses provider settings and the router sentinel', async () => {
    const result = await launch('codex');
    assert.equal(result.status, 200);
    assert.equal(result.classifier, process.env.TYPESAFE_BASE_URL);
    assert.notEqual(result.proxy, result.classifier);
    assert.ok(result.args.includes('laya-router'));
    assert.ok(result.args.includes('model_providers.jev.wire_api="responses"'));
  });

  await t.test('laya-router sentinel routes real proxy requests and records final Claude/Codex usage', async (t) => {
    process.env.LAYA_USAGE_FILE = join(scratch, 'usage.jsonl');
    const received = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push({ path: req.url, body, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (body.interrupt) {
        res.write('event: partial\ndata: {}\n\n');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      if (req.url === '/v1/messages') {
        const message = { id: 'msg_usage_claude', type: 'message', role: 'assistant', model: body.model,
          usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } };
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n`);
        res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        const response = { id: 'resp_usage_codex', object: 'response', status: 'completed', model: body.model,
          usage: { input_tokens: 200, output_tokens: 40, input_tokens_details: { cached_tokens: 70 }, output_tokens_details: { reasoning_tokens: 10 } } };
        res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
      }
    });
    await new Promise((yes) => upstream.listen(0, '127.0.0.1', yes));
    t.after(() => new Promise((yes) => { upstream.close(yes); upstream.closeAllConnections(); }));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const load = (name) => import(pathToFileURL(join(fixtureRoot, `src/${name}-local.mjs`)).href);
    const { startProxy } = await load('proxy');
    const { startCodexProxy } = await load('codex-proxy');
    let claudeRoutes = 0, codexRoutes = 0;
    const claude = await startProxy({ upstreamURL: base, route: async () => {
      claudeRoutes++;
      return { choice: 'claude-haiku-4-5-20251001', confidence: 0.99, ms: 1 };
    } });
    const codex = await startCodexProxy({ apiBaseURL: base, chatgptBaseURL: base, route: async () => {
      codexRoutes++;
      return { choice: 'gpt-5.6-luna', confidence: 0.99, ms: 1 };
    } });
    t.after(() => { for (const proxy of [claude, codex]) proxy.close().closeAllConnections(); });
    const post = async (port, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      return response.text();
    };
    await post(claude.port, '/v1/messages', { model: 'laya-router', stream: true, max_tokens: 100,
      metadata: { user_id: JSON.stringify({ session_id: 'claude-session' }) },
      tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'Rename one variable.' }] });
    await post(codex.port, '/responses', { model: 'laya-router', stream: true, prompt_cache_key: 'codex-session',
      input: [{ type: 'additional_tools', tools: [] }, { role: 'user', content: 'Rename one variable.' }] });
    assert.equal(claudeRoutes, 1);
    assert.equal(codexRoutes, 1);
    assert.equal(received[0].body.model, 'claude-haiku-4-5-20251001');
    assert.equal(received[1].body.model, 'gpt-5.6-luna');
    assert.ok(received.every((request) => request.headers['accept-encoding'] === undefined));
    const report = stats();
    assert.equal(report.last5h.requests, 2);
    assert.equal(report.last5h.inputTokens, 230);
    assert.equal(report.last5h.cacheReadTokens, 120);
    assert.equal(report.last5h.cacheWriteTokens, 10);
    assert.equal(report.last5h.outputTokens, 60);
    assert.equal(report.last5h.reasoningTokens, 10);
    assert.equal(report.last5h.totalTokens, 420);
    assert.equal(report.latestSession.client, 'codex');
    assert.equal(report.latestSession.sessionID, 'codex-session');
    assert.equal(report.latestSession.totalTokens, 240);
    for (const [port, path, body] of [
      [claude.port, '/v1/messages', { model: 'claude-haiku-4-5-20251001', messages: [], interrupt: true }],
      [codex.port, '/responses', { model: 'gpt-5.6-luna', input: [], interrupt: true }],
    ]) {
      const started = Date.now();
      await assert.rejects(post(port, path, body));
      assert.ok(Date.now() - started < 2000, 'upstream disconnect must close the client promptly');
    }
    assert.equal(stats().last5h.requests, 2, 'interrupted responses must not fabricate final usage');
  });
});
