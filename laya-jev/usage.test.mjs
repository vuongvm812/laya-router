import assert from 'node:assert/strict';
import http from 'node:http';
import { test, beforeEach, afterEach } from 'node:test';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main, observeUsage, recordOpenCodeUsage, recordUsage, stats } from './usage.mjs';

const hour = 60 * 60 * 1000;
const now = 2_000_000_000_000;
const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  reasoningTokens: 0, totalTokens: 0, requests: 0 };
const base = { client: 'claude', sessionID: 'session-a', responseID: 'response-a', model: 'model-a',
  inputTokens: 11, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 19, reasoningTokens: 5, at: now };
const metadata = { client: 'codex', sessionID: 'session-http', model: 'fallback' };
const usage = { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 60 },
  output_tokens_details: { reasoning_tokens: 12 } };
const responseBody = (overrides = {}) => ({ object: 'response', id: 'resp-1', model: 'gpt-test',
  status: 'completed', usage, ...overrides });
const sse = (body, event, newline = '\n') => `${event ? `event: ${event}${newline}` : ''}data: ${JSON.stringify(body)}${newline}${newline}`;
const finalFrame = (overrides = {}) => sse({ type: 'response.completed', response: responseBody(overrides) });

let cleanups;
beforeEach(() => {
  cleanups = [];
  const previous = process.env.LAYA_USAGE_FILE;
  const root = mkdtempSync(join(tmpdir(), 'laya-usage-'));
  process.env.LAYA_USAGE_FILE = join(root, 'usage.jsonl');
  cleanups.push(() => {
    if (previous === undefined) delete process.env.LAYA_USAGE_FILE;
    else process.env.LAYA_USAGE_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

function captureConsole(method, output) {
  const original = console[method];
  console[method] = (...args) => output.push(args.join(' '));
  cleanups.push(() => { console[method] = original; });
}

function records() {
  return readFileSync(process.env.LAYA_USAGE_FILE, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function observe(chunks, { statusCode = 200, headers = {}, meta = metadata } = {}) {
  const source = new PassThrough();
  Object.assign(source, { statusCode, headers });
  const observed = observeUsage(source, meta);
  const received = [];
  const destination = new Writable({ write(chunk, encoding, callback) { received.push(Buffer.from(chunk)); callback(); } });
  const finished = once(destination, 'finish');
  source.pipe(destination);
  for (const chunk of chunks) {
    source.write(chunk);
    await tick();
  }
  source.end();
  await finished;
  const written = await observed;
  assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return written;
}

test('append allowlists metadata, uses mode 0600, and computes inclusive output without reasoning twice', () => {
  const file = process.env.LAYA_USAGE_FILE;
  writeFileSync(file, '', { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal(recordUsage({ ...base, prompt: 'PROMPT_SECRET', apiKey: 'KEY_SECRET', headers: { authorization: 'AUTH_SECRET' } }), true);
  const prefix = readFileSync(file, 'utf8');
  assert.equal(recordUsage({ ...base, responseID: 'response-b', inputTokens: 0, outputTokens: 0 }), true);
  assert.equal(readFileSync(file, 'utf8').startsWith(prefix), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(records()[0], base);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /SECRET|prompt|apiKey|authorization/);
  assert.deepEqual(stats({ now }).last5h, { inputTokens: 11, outputTokens: 13, cacheReadTokens: 34,
    cacheWriteTokens: 38, reasoningTokens: 10, totalTokens: 96, requests: 2 });
});

test('unknown usage, missing identity and invalid counters are rejected; explicit zero is valid', () => {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'at']) {
    for (const invalid of [-1, 0.5, NaN, Infinity, '4', null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(recordUsage({ ...base, [field]: invalid }), false, `${field}: ${invalid}`);
    }
  }
  for (const field of ['client', 'sessionID', 'responseID']) {
    for (const invalid of ['', ' ', undefined, null, 5]) assert.equal(recordUsage({ ...base, [field]: invalid }), false);
  }
  assert.equal(recordUsage({ ...base, inputTokens: undefined }), false);
  assert.equal(recordUsage({ ...base, outputTokens: undefined }), false);
  assert.equal(recordUsage(null), false);
  assert.equal(stats({ now }).latestSession, null);
  assert.equal(recordUsage({ client: 'claude', sessionID: 'zero', responseID: 'zero', inputTokens: 0, outputTokens: 0, at: now }), true);
  assert.deepEqual(stats({ now }).last5h, { ...empty, requests: 1 });
});

test('separate CLI processes append intact JSONL records to the shared ledger', async () => {
  const moduleURL = new URL('./usage.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, writer) => promisify(execFile)(process.execPath, [
    '--input-type=module', '-e', `
      import { recordUsage } from ${JSON.stringify(moduleURL)};
      for (let index = 0; index < 40; index++) {
        if (!recordUsage({ client: 'codex', sessionID: 'writer-${writer}', responseID: String(index),
          inputTokens: 1, outputTokens: 2 })) process.exit(1);
      }
    `,
  ], { env: { ...process.env } })));
  assert.equal(records().length, 160);
  assert.equal(stats().last5h.requests, 160);
  assert.equal(stats().last5h.totalTokens, 480);
});

test('missing configuration, relative path, IO errors and missing files are quiet and nonfatal', () => {
  const messages = [];
  captureConsole('warn', messages);
  captureConsole('error', messages);
  const file = process.env.LAYA_USAGE_FILE;
  for (const path of [undefined, 'relative.jsonl', join(file, 'missing', 'SECRET_KEY.jsonl')]) {
    if (path === undefined) delete process.env.LAYA_USAGE_FILE;
    else process.env.LAYA_USAGE_FILE = path;
    assert.equal(recordUsage(base), false);
    assert.deepEqual(stats({ now }), { latestSession: null, last5h: empty, last7d: empty });
  }
  assert.deepEqual(messages, []);
});

test('non-OpenCode snapshots retain client/session/response identity and last valid append wins', () => {
  recordUsage({ ...base, outputTokens: 1 });
  recordUsage({ ...base, outputTokens: 2, at: now - 1 }); // Last line wins even with an earlier timestamp.
  recordUsage({ ...base, client: 'codex' });
  recordUsage({ ...base, sessionID: 'session-b' });
  const file = process.env.LAYA_USAGE_FILE;
  appendFileSync(file, `not-json\nnull\n${JSON.stringify({ ...base, outputTokens: -1 })}\n`);
  appendFileSync(file, '{"client":"claude","sessionID":');
  const result = stats({ now });
  assert.equal(result.last5h.requests, 3);
  assert.equal(result.last5h.outputTokens, 28);
  assert.equal(result.latestSession.sessionID, 'session-b');
  assert.equal(result.latestSession.requests, 1);
});

test('OpenCode session attribution corrections replace the same response while distinct IDs remain separate', () => {
  const original = { ...base, client: 'opencode', sessionID: 'own-session', responseID: 'msg-child' };
  assert.equal(recordUsage(original), true);
  assert.equal(stats({ now }).latestSession.sessionID, 'own-session');
  assert.equal(recordUsage({ ...original, sessionID: 'root-parent' }), true);
  // An invalid later correction must not replace the valid root attribution.
  appendFileSync(process.env.LAYA_USAGE_FILE, `${JSON.stringify({ ...original, outputTokens: -1 })}\n`);
  const expected = { inputTokens: 11, outputTokens: 13, cacheReadTokens: 17, cacheWriteTokens: 19,
    reasoningTokens: 5, totalTokens: 60, requests: 1 };
  assert.deepEqual(stats({ now }), {
    latestSession: { client: 'opencode', sessionID: 'root-parent', lastActivity: now, ...expected },
    last5h: expected,
    last7d: expected,
  });
  assert.equal(recordUsage({ ...original, responseID: 'msg-other', sessionID: 'root-parent' }), true);
  const doubled = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, value * 2]));
  assert.deepEqual(stats({ now }), {
    latestSession: { client: 'opencode', sessionID: 'root-parent', lastActivity: now, ...doubled },
    last5h: doubled,
    last7d: doubled,
  });
});

test('5h and 7d bounds are inclusive, future usage excluded, latest session totals span all history', () => {
  const add = (responseID, at, overrides = {}) => recordUsage({ ...base, responseID, at,
    inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1, ...overrides });
  add('old', now - 8 * 24 * hour);
  add('before-7d', now - 7 * 24 * hour - 1, { sessionID: 'other' });
  add('at-7d', now - 7 * 24 * hour, { sessionID: 'other' });
  add('before-5h', now - 5 * hour - 1, { client: 'codex' });
  add('at-5h', now - 5 * hour, { client: 'opencode' });
  add('current', now);
  add('future', now + 1, { sessionID: 'future' });
  const result = stats({ now });
  assert.deepEqual(result.last5h, { inputTokens: 2, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 8,
    reasoningTokens: 2, totalTokens: 20, requests: 2 });
  assert.equal(result.last7d.requests, 4);
  assert.equal(result.last7d.totalTokens, 40);
  assert.deepEqual(result.latestSession, { client: 'claude', sessionID: 'session-a', lastActivity: now, ...result.last5h });
  const later = stats({ now: now + 20 * 24 * hour });
  assert.equal(later.latestSession.sessionID, 'future');
  assert.deepEqual(later.last7d, empty);
});

test('Anthropic SSE split UTF-8 / CRLF, combined frames and cumulative field reconciliation', async () => {
  const start = sse({ type: 'message_start', message: { id: 'msg-1', model: 'claude-🦊', role: 'assistant',
    content: [{ text: 'PROMPT_SECRET日本語' }], usage: { input_tokens: 10, output_tokens: 0,
      cache_read_input_tokens: 20, cache_creation_input_tokens: 30 } } }, 'message_start', '\r\n');
  const bytes = Buffer.from(start);
  const fox = bytes.indexOf(Buffer.from('🦊'));
  const combined = sse({ type: 'message_delta', usage: { input_tokens: 11, output_tokens: 4 } })
    + sse({ type: 'message_delta', usage: { output_tokens: 9, cache_read_input_tokens: 21 } })
    + sse({ type: 'message_stop' }, 'message_stop', '\r\n');
  assert.equal(await observe([bytes.subarray(0, fox + 1), bytes.subarray(fox + 1, fox + 3),
    bytes.subarray(fox + 3, bytes.length - 3), bytes.subarray(bytes.length - 3), combined], {
    headers: { 'content-type': 'text/event-stream' }, meta: { client: 'claude', sessionID: 'anthropic' },
  }), true);
  const [record] = records();
  assert.equal(record.model, 'claude-🦊');
  assert.deepEqual(stats().last5h, { inputTokens: 11, outputTokens: 9, cacheReadTokens: 21, cacheWriteTokens: 30,
    reasoningTokens: 0, totalTokens: 71, requests: 1 });
  assert.doesNotMatch(readFileSync(process.env.LAYA_USAGE_FILE, 'utf8'), /PROMPT_SECRET|日本語|content/);
});

test('Responses final SSE ignores earlier snapshots, supports event-name inference and multiline data', async () => {
  const initial = sse({ type: 'response.created', response: responseBody({ usage: { input_tokens: 1, output_tokens: 0 } }) });
  const final = 'event: response.completed\r\ndata: {"response":\r\ndata: '
    + JSON.stringify(responseBody({ instructions: 'SECRET_SYSTEM', output: [{ text: 'SECRET_OUTPUT' }] })) + '}\r\n\r\n';
  assert.equal(await observe([initial.slice(0, 3), initial.slice(3) + final]), true);
  assert.deepEqual(stats().last5h, { inputTokens: 40, outputTokens: 30, cacheReadTokens: 60,
    cacheWriteTokens: 0, reasoningTokens: 12, totalTokens: 130, requests: 1 });
  assert.doesNotMatch(readFileSync(process.env.LAYA_USAGE_FILE, 'utf8'), /SECRET|instructions|text/);
});

test('final response.incomplete snapshots count, failed and aborted/intermediate streams do not', async () => {
  assert.equal(await observe([sse({ type: 'response.incomplete', response: responseBody({ status: 'incomplete' }) })]), true);
  assert.equal(await observe([sse({ type: 'response.created', response: responseBody() })]), false);
  assert.equal(await observe([sse({ type: 'response.failed', response: responseBody({ id: 'failed', status: 'failed' }) })]), false);
  assert.equal(await observe([finalFrame({ status: 'in_progress' })]), false);
  assert.equal(await observe([finalFrame().trimEnd()]), false);
  const start = sse({ type: 'message_start', message: { id: 'partial', usage: { input_tokens: 3, output_tokens: 0 } } });
  assert.equal(await observe([start]), false);
  assert.equal(await observe([start + sse({ type: 'message_stop' })]), false);
  const source = new PassThrough();
  Object.assign(source, { statusCode: 200, headers: {} });
  const done = observeUsage(source, metadata);
  source.write(start + sse({ type: 'message_delta', usage: { output_tokens: 2 } }));
  source.emit('aborted');
  source.destroy();
  assert.equal(await done, false);
  assert.equal(stats().last5h.requests, 1);
});

test('JSON provider shapes, split Unicode, optional details and cache underflow normalization', async () => {
  const raw = Buffer.from(JSON.stringify(responseBody({ model: 'gpt-🦊', usage: { ...usage, input_tokens: 50 } })));
  const index = raw.indexOf(Buffer.from('🦊'));
  assert.equal(await observe([raw.subarray(0, index + 2), raw.subarray(index + 2)], { headers: { 'content-type': 'application/json' } }), true);
  assert.equal(records()[0].model, 'gpt-🦊');
  assert.equal(records()[0].inputTokens, 0);
  assert.equal(await observe([JSON.stringify({ type: 'message', role: 'assistant', id: 'anthropic-json', model: 'claude',
    stop_reason: 'end_turn', content: [{ text: 'PRIVATE' }], usage: { input_tokens: 7, output_tokens: 8,
      cache_read_input_tokens: 9, cache_creation_input_tokens: 10 } })]), true);
  assert.equal(await observe([JSON.stringify(responseBody({ id: 'minimal', usage: { input_tokens: 0, output_tokens: 4 } }))]), true);
  assert.equal(records()[2].cacheReadTokens, 0);
  assert.equal(stats().last5h.requests, 3);
});

test('non-2xx, compressed, malformed, unknown shape and invalid/unknown usage never fabricate records', async () => {
  assert.equal(await observe([finalFrame()], { statusCode: 429 }), false);
  assert.equal(await observe([finalFrame()], { headers: { 'content-encoding': 'gzip' } }), false);
  assert.equal(await observe([finalFrame()], { meta: { client: 'codex' } }), false);
  for (const body of [
    { id: 'arbitrary', usage }, responseBody({ status: 'in_progress' }), responseBody({ usage: null }),
    responseBody({ usage: { input_tokens: 10 } }), responseBody({ usage: { output_tokens: 10 } }),
    responseBody({ usage: { ...usage, output_tokens: -1 } }),
    responseBody({ usage: { ...usage, input_tokens_details: { cached_tokens: '10' } } }),
    responseBody({ usage: { ...usage, output_tokens_details: { reasoning_tokens: null } } }),
    responseBody({ id: '' }),
  ]) assert.equal(await observe([JSON.stringify(body)]), false, JSON.stringify(body));
  assert.equal(await observe(['{"object":"response"']), false);
  assert.equal(await observe(['data: invalid\n\n']), false);
  assert.equal(await observe([sse({ type: 'error', error: { message: 'SECRET' } }) + finalFrame()]), false);
  assert.deepEqual(stats(), { latestSession: null, last5h: empty, last7d: empty });
});

test('buffer cap skips oversized JSON and SSE without changing bytes; long streams of small frames work', async () => {
  const huge = 'x'.repeat(1024 * 1024);
  assert.equal(await observe([JSON.stringify(responseBody({ output: huge }))]), false);
  assert.equal(await observe([sse({ type: 'response.output_text.delta', delta: huge }) + finalFrame()]), false);
  const smallFrames = sse({ type: 'response.output_text.delta', delta: 'x'.repeat(1024) }).repeat(1100);
  assert.equal(await observe([smallFrames + finalFrame()]), true);
  assert.equal(stats().last5h.requests, 1);
});

test('ChatCompletion JSON and optional streaming usage chunk count only final usage', async () => {
  const chatUsage = { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 60 },
    completion_tokens_details: { reasoning_tokens: 12 } };
  const body = { object: 'chat.completion', id: 'chat-json', model: 'gpt-chat', choices: [{ finish_reason: 'stop' }], usage: chatUsage };
  assert.equal(await observe([JSON.stringify(body)]), true);
  const stream = sse({ ...body, id: 'chat-stream', object: 'chat.completion.chunk', choices: [], usage: chatUsage });
  assert.equal(await observe([stream]), false);
  assert.equal(await observe([stream + 'data: [DONE]\n\n']), true);
  assert.equal(stats().last5h.totalTokens, 260);
  assert.equal(stats().last5h.outputTokens, 60);
});

test('OpenCode v1.18.30 getUsage-normalized message restores reasoning once and keeps uncached input', () => {
  // getUsage(input=100, cache.read=40, cache.write=10, output=30, reasoning=12)
  // produces input=50, output=18, reasoning=12; total is optional and must not be trusted.
  const message = { role: 'assistant', id: 'msg-oc', sessionID: 'ses-oc', providerID: 'openai', modelID: 'gpt-test',
    time: { created: now - 100, completed: now },
    tokens: { total: 9999, input: 50, output: 18, reasoning: 12, cache: { read: 40, write: 10 } },
    content: 'SECRET', path: { cwd: '/PRIVATE', root: '/PRIVATE' } };
  assert.equal(recordOpenCodeUsage({ ...message, role: 'user' }), false);
  assert.equal(recordOpenCodeUsage({ ...message, time: { created: now } }), false);
  assert.equal(recordOpenCodeUsage({ ...message, error: { name: 'MessageAbortedError' } }), false);
  assert.equal(recordOpenCodeUsage({ ...message, tokens: { ...message.tokens, reasoning: undefined } }), false);
  assert.equal(recordOpenCodeUsage({ ...message, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), false);
  assert.equal(recordOpenCodeUsage(message), true);
  assert.equal(recordOpenCodeUsage({ ...message, tokens: { ...message.tokens, output: 20 } }), true);
  assert.deepEqual(records()[0], { client: 'opencode', sessionID: 'ses-oc', responseID: 'msg-oc', model: 'openai/gpt-test',
    inputTokens: 50, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 12, at: now });
  assert.equal(stats({ now }).last5h.requests, 1);
  assert.equal(stats({ now }).last5h.totalTokens, 132);
  assert.doesNotMatch(readFileSync(process.env.LAYA_USAGE_FILE, 'utf8'), /SECRET|PRIVATE|content|path/);
});

test('main prints stable JSON or readable three-window breakdown, including no-data note', () => {
  const output = [];
  captureConsole('log', output);
  main(['--json']);
  assert.deepEqual(JSON.parse(output.pop()), { latestSession: null, last5h: empty, last7d: empty });
  main([]);
  assert.match(output.join('\n'), /Latest session.*\nLast 5 hours.*\nLast 7 days/);
  assert.match(output.join('\n'), /No observed usage yet/);
  assert.match(output.join('\n'), /Input \(uncached\).*Cache read.*Cache write.*Output.*Reasoning/);
  assert.match(output.join('\n'), /Observed local generation usage only; not account quotas/);
  assert.equal(recordUsage({ ...base, at: Date.now() }), true);
  const cli = execFileSync(process.execPath, [fileURLToPath(new URL('./usage.mjs', import.meta.url)), '--json'], {
    encoding: 'utf8', env: { ...process.env },
  });
  assert.equal(JSON.parse(cli).last5h.totalTokens, 60);
});

test('real HTTP provider → observing proxy → slow client preserves bytes and pipe backpressure', { timeout: 15000 }, async () => {
  const noise = sse({ type: 'response.output_text.delta', delta: 'SECRET_OUTPUT日本語🦊'.repeat(300) });
  const wire = Buffer.from(noise.repeat(200) + finalFrame());
  const provider = http.createServer(async (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let index = 0; index < wire.length; index += 8191) {
      if (!response.write(wire.subarray(index, index + 8191))) await once(response, 'drain');
    }
    response.end();
  });
  let observed;
  let pauses = 0;
  let finishedReading = false;
  const proxy = http.createServer((request, outgoing) => {
    http.get(`http://127.0.0.1:${provider.address().port}`, (incoming) => {
      incoming.on('pause', () => pauses++);
      observed = observeUsage(incoming, metadata);
      observed.then(() => { finishedReading = true; });
      outgoing.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(outgoing);
    }).on('error', (error) => outgoing.destroy(error));
  });
  cleanups.push(async () => {
    for (const server of [proxy, provider]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const client = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxy.address().port}`, resolve).on('error', reject);
  });
  const received = [];
  const destination = new Writable({ highWaterMark: 1024, write(chunk, encoding, callback) {
    received.push(Buffer.from(chunk));
    delay(1).then(() => callback());
  } });
  const finished = once(destination, 'finish');
  client.pipe(destination);
  await finished;
  assert.equal(await observed, true);
  assert.equal(finishedReading, true);
  assert.ok(pauses > 0, 'the existing pipe still pauses the provider response under backpressure');
  assert.deepEqual(Buffer.concat(received), wire);
  assert.equal(stats().last5h.requests, 1);
  assert.doesNotMatch(readFileSync(process.env.LAYA_USAGE_FILE, 'utf8'), /SECRET_OUTPUT|日本語/);
});
