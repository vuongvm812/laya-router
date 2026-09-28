import { closeSync, fchmodSync, openSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER = 1024 * 1024;
const COUNTS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function valid(record) {
  return object(record) && ['client', 'sessionID', 'responseID'].every((key) => identifier(record[key]))
    && (record.model === null || identifier(record.model)) && integer(record.at)
    && COUNTS.every((key) => integer(record[key]));
}

/**
 * Append one confirmed usage snapshot. Input is uncached; output INCLUDES reasoning.
 * Returns true on append, false for unknown/invalid usage, missing configuration or IO failure.
 * Only the allowlisted metadata and counters are persisted; errors never log payloads or paths.
 * The runtime owns the existing parent directory and supplies an absolute LAYA_USAGE_FILE.
 */
export function recordUsage(input = {}) {
  let fd;
  try {
    const file = process.env.LAYA_USAGE_FILE;
    if (!file || !isAbsolute(file) || !object(input)) return false;
    const {
      client, sessionID, responseID, model = null, inputTokens, outputTokens,
      cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0, at = Date.now(),
    } = input;
    const record = { client, sessionID, responseID, model, inputTokens, outputTokens,
      cacheReadTokens, cacheWriteTokens, reasoningTokens, at };
    if (!valid(record)) return false;
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    fd = openSync(file, 'a', 0o600);
    fchmodSync(fd, 0o600);
    // One O_APPEND write per event, also suitable for separate CLI processes and Bun.
    return writeSync(fd, line) === line.length;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* A collector must never break generation. */ }
    }
  }
}

function anthropicUsage(usage) {
  if (!object(usage)) return null;
  const counts = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens === undefined ? 0 : usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens === undefined ? 0 : usage.cache_creation_input_tokens,
    reasoningTokens: 0, // Anthropic does not report a separate reasoning-token count.
  };
  return COUNTS.every((key) => integer(counts[key])) ? counts : null;
}

function openAIUsage(usage, chat = false) {
  if (!object(usage)) return null;
  const input = chat ? usage.prompt_tokens : usage.input_tokens;
  const output = chat ? usage.completion_tokens : usage.output_tokens;
  const inputDetails = chat ? usage.prompt_tokens_details : usage.input_tokens_details;
  const outputDetails = chat ? usage.completion_tokens_details : usage.output_tokens_details;
  const cached = inputDetails?.cached_tokens === undefined ? 0 : inputDetails.cached_tokens;
  const reasoning = outputDetails?.reasoning_tokens === undefined ? 0 : outputDetails.reasoning_tokens;
  if (![input, output, cached, reasoning].every(integer)) return null;
  return { inputTokens: Math.max(0, input - cached), outputTokens: output,
    cacheReadTokens: cached, cacheWriteTokens: 0, reasoningTokens: reasoning };
}

/**
 * Observe an IncomingMessage immediately before the caller pipes it (in the same turn).
 * This passive data listener never reads, pauses, resumes, unpipes, or rewrites the stream.
 * Parsing is bounded to 1 MiB per SSE frame / JSON body; append runs in a microtask,
 * outside the data callback, so pipe's writes/backpressure run first. The returned promise
 * resolves to whether a record was appended; callers need not await it before piping.
 * Only final usage is counted: interrupted streams and oversized/encoded bodies are skipped.
 * response.incomplete is a provider-reported final snapshot, unlike a transport abort.
 */
export function observeUsage(response, { client, sessionID, model } = {}) {
  if (!response || response.statusCode < 200 || response.statusCode >= 300
    || !Number.isInteger(response.statusCode) || !identifier(client) || !identifier(sessionID)
    || (response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    let mode = /text\/event-stream/i.test(response.headers?.['content-type'] ?? '') ? 'sse' : null;
    let buffer = '';
    let stopped = false;
    let message;
    let finalAnthropicOutput = false;
    let chatSnapshot;

    const cleanup = () => {
      response.removeListener('data', onData);
      response.removeListener('end', onEnd);
      response.removeListener('aborted', onAbort);
      response.removeListener('error', onAbort);
      response.removeListener('close', onAbort);
      buffer = '';
      message = undefined;
      chatSnapshot = undefined;
    };
    const finish = (snapshot) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      // Capture wallclock at observation, not at a later append, and never queue raw bodies.
      const event = snapshot && { client, sessionID, ...snapshot, at: Date.now() };
      queueMicrotask(() => resolve(event ? recordUsage(event) : false));
    };
    const commit = (body, counts) => {
      if (!identifier(body?.id) || !counts) return;
      finish({ responseID: body.id, model: identifier(body.model) ? body.model : model, ...counts });
    };
    const finalResponse = (body, type) => {
      if (!object(body)) return;
      if (type === 'response.completed' || type === 'response.incomplete') {
        const expected = type.slice('response.'.length);
        if (body.status !== undefined && body.status !== expected) return;
        commit(body, openAIUsage(body.usage));
      }
    };
    const jsonBody = (body) => {
      if (!object(body)) return;
      if (body.type === 'response.completed' || body.type === 'response.incomplete') {
        finalResponse(body.response, body.type);
      } else if (body.object === 'response' && ['completed', 'incomplete'].includes(body.status)) {
        finalResponse(body, `response.${body.status}`);
      } else if (body.type === 'message' && body.role === 'assistant' && identifier(body.stop_reason)) {
        commit(body, anthropicUsage(body.usage));
      } else if (body.object === 'chat.completion' && Array.isArray(body.choices) && body.choices.length
        && body.choices.every((choice) => identifier(choice.finish_reason))) {
        commit(body, openAIUsage(body.usage, true));
      }
    };
    const frame = (text) => {
      let type;
      const data = [];
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      const payload = data.join('\n');
      if (payload.trim() === '[DONE]') {
        if (chatSnapshot) finish(chatSnapshot);
        return;
      }
      let body;
      try { body = JSON.parse(payload); } catch { return; }
      if (!object(body)) return;
      type = body.type ?? type;
      if (type === 'error' || type === 'response.failed') return finish();
      if (type === 'message_start' && object(body.message)) {
        // Retain only fields needed for accounting, never message content.
        message = { id: body.message.id, model: body.message.model, usage: {} };
        finalAnthropicOutput = false;
        mergeAnthropic(body.message.usage);
      } else if (type === 'message_delta' && message) {
        mergeAnthropic(body.usage);
        if (body.usage?.output_tokens !== undefined) finalAnthropicOutput = true;
      } else if (type === 'message_stop' && message && finalAnthropicOutput) {
        commit(message, anthropicUsage(message.usage));
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        finalResponse(body.response, type);
      } else if (body.object === 'chat.completion.chunk') {
        const counts = openAIUsage(body.usage, true);
        if (identifier(body.id) && counts) {
          chatSnapshot = { responseID: body.id, model: identifier(body.model) ? body.model : model, ...counts };
        }
      }
    };
    const mergeAnthropic = (usage) => {
      if (!object(usage)) return;
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        // Deltas contain cumulative snapshots, not increments. Missing fields preserve start usage.
        if (usage[key] !== undefined) message.usage[key] = usage[key];
      }
    };
    const accept = (text) => {
      // Slice unusually large chunks so many small combined frames can exceed 1 MiB overall.
      for (let offset = 0; offset < text.length && !stopped; offset += 16384) {
        buffer += text.slice(offset, offset + 16384);
        if (!mode && buffer.trimStart()) mode = /^[\[{]/.test(buffer.trimStart()) ? 'json' : 'sse';
        if (mode === 'sse') {
          let boundary;
          while (!stopped && (boundary = /\r?\n\r?\n/.exec(buffer))) {
            const text = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary[0].length);
            if (Buffer.byteLength(text) > MAX_BUFFER) return finish();
            frame(text);
          }
        }
        if (Buffer.byteLength(buffer) > MAX_BUFFER) return finish();
      }
    };
    function onData(chunk) {
      try { accept(typeof chunk === 'string' ? chunk : decoder.write(chunk)); } catch { finish(); }
    }
    function onEnd() {
      try {
        accept(decoder.end());
        if (!stopped && mode === 'json') jsonBody(JSON.parse(buffer));
        // Unterminated SSE frames are deliberately not treated as completed events.
      } catch { /* Malformed or truncated response: no fabricated usage. */ }
      finish();
    }
    function onAbort() { finish(); }
    response.on('data', onData);
    response.once('end', onEnd);
    response.once('aborted', onAbort);
    response.once('error', onAbort);
    response.once('close', onAbort);
  });
}

/**
 * OpenCode v1.18.30: getUsage subtracts both cache counts from input and reasoning
 * from output. Restore inclusive output exactly once; ignore tokens.total.
 * Sources (version pinned):
 * https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/session.ts (getUsage)
 * https://github.com/anomalyco/opencode/blob/v1.18.30/packages/schema/src/v1/session.ts (Assistant)
 * Completed errored messages are skipped: cleanup also completes aborted placeholders.
 * Upstream normalizes missing provider usage to zeros. An all-zero snapshot without
 * an explicit zero total is ambiguous and skipped rather than fabricating a request.
 */
export function recordOpenCodeUsage(message) {
  if (message?.role !== 'assistant' || !integer(message.time?.completed) || message.error
    || !identifier(message.providerID) || !identifier(message.modelID)) return false;
  const tokens = message.tokens;
  if (!tokens || ![tokens.input, tokens.output, tokens.reasoning, tokens.cache?.read, tokens.cache?.write].every(integer)) {
    return false;
  }
  if (tokens.total !== 0 && [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].every((value) => value === 0)) {
    return false;
  }
  return recordUsage({ client: 'opencode', sessionID: message.sessionID, responseID: message.id,
    model: `${message.providerID}/${message.modelID}`, inputTokens: tokens.input,
    outputTokens: tokens.output + tokens.reasoning, reasoningTokens: tokens.reasoning,
    cacheReadTokens: tokens.cache.read, cacheWriteTokens: tokens.cache.write, at: message.time.completed });
}

function totals() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 0, requests: 0 };
}

function add(target, record) {
  for (const key of COUNTS) target[key] += record[key];
  target.totalTokens += record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens;
  target.requests++;
}

/**
 * Last valid ledger line wins per [client, responseID] for OpenCode's globally unique
 * message IDs, including corrected session attribution. Other clients use
 * [client, sessionID, responseID]. Rolling windows include both boundaries.
 */
export function stats({ file = process.env.LAYA_USAGE_FILE, now = Date.now() } = {}) {
  const result = { latestSession: null, last5h: totals(), last7d: totals() };
  if (!file || !integer(now)) return result;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return result; }
  const records = new Map();
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line);
      if (valid(record)) {
        const key = JSON.stringify(record.client === 'opencode'
          ? [record.client, record.responseID]
          : [record.client, record.sessionID, record.responseID]);
        records.delete(key); // Last appended event also breaks equal-timestamp ties.
        records.set(key, record);
      }
    } catch { /* Ignore malformed lines, including a truncated final append. */ }
  }
  let latest;
  for (const record of records.values()) {
    if (record.at > now) continue;
    if (!latest || record.at >= latest.at) latest = record;
    if (record.at >= now - 5 * 60 * 60 * 1000) add(result.last5h, record);
    if (record.at >= now - 7 * 24 * 60 * 60 * 1000) add(result.last7d, record);
  }
  if (latest) {
    result.latestSession = { client: latest.client, sessionID: latest.sessionID, lastActivity: latest.at, ...totals() };
    for (const record of records.values()) {
      if (record.at <= now && record.client === latest.client && record.sessionID === latest.sessionID) {
        add(result.latestSession, record);
      }
    }
  }
  return result;
}

/** Dependency-free CLI; safe to import and call before any router/configuration checks. */
export function main(args = process.argv.slice(2)) {
  const result = stats();
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const rows = [
    ['Latest session', result.latestSession ?? totals()],
    ['Last 5 hours', result.last5h],
    ['Last 7 days', result.last7d],
  ];
  const columns = ['Window', 'Requests', 'Input (uncached)', 'Cache read', 'Cache write', 'Output', 'Reasoning*', 'Total'];
  const cells = rows.map(([label, row]) => [label, row.requests, row.inputTokens, row.cacheReadTokens,
    row.cacheWriteTokens, row.outputTokens, row.reasoningTokens, row.totalTokens].map(String));
  const widths = columns.map((title, index) => Math.max(title.length, ...cells.map((row) => row[index].length)));
  console.log([columns, ...cells].map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()).join('\n'));
  if (result.latestSession) {
    console.log(`Latest: ${JSON.stringify(result.latestSession.client)} / ${JSON.stringify(result.latestSession.sessionID)}`);
  } else {
    console.log('No observed usage yet.');
  }
  console.log('Observed local generation usage only; not account quotas. *Reasoning is included in output.');
  console.log('Streams without final usage are not counted.');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
