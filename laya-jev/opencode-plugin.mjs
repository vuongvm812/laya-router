import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { recordOpenCodeUsage } from './usage.mjs';

const TIERS = ['fast', 'balanced', 'strong'];
const GUIDANCE = ['haiku', 'sonnet', 'opus']; // Jev's task-complexity rubric, not provider identities.
const HEADROOM = 8192;
const DOWNGRADE_LIMIT = 20_000;
const NAMED_OPENAI_TIERS = {
  'gpt-5.6-luna': 'fast', 'gpt-5.6-terra': 'balanced', 'gpt-5.6-sol': 'strong', 'gpt-6-astra': 'strong',
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isFinite(value) && value > 0;

// Deliberately narrow defaults. Unknown models/providers require LAYA_ROUTER_MODELS.
// GPT-5/5.1 (including codex) are balanced; reviewed full 5.2–5.5 and 5.1-codex-max
// are strong. GPT-5*.mini/nano and codex-mini are fast. Jev's four named fallback
// IDs are explicit exceptions; arbitrary GPT-6/pro/spark models are not inferred.
function defaultTier(providerID, id) {
  if (providerID === 'anthropic') {
    const family = /^claude-(?:(?:3|3-5|3-7)-)?(haiku|sonnet|opus)(?:-|$)/.exec(id)?.[1];
    return { haiku: 'fast', sonnet: 'balanced', opus: 'strong' }[family];
  }
  if (providerID !== 'openai') return;
  if (Object.hasOwn(NAMED_OPENAI_TIERS, id)) return NAMED_OPENAI_TIERS[id];
  const name = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (/^gpt-5(?:\.\d+)?-(?:mini|nano|codex-mini)$/.test(name)) return 'fast';
  if (/^gpt-5(?:\.1)?(?:-codex)?$/.test(name)) return 'balanced';
  if (/^gpt-5\.[2-5](?:-codex)?$/.test(name) || name === 'gpt-5.1-codex-max') return 'strong';
}

function tierMapping(raw, providerID, models) {
  if (!raw) return;
  const parsed = JSON.parse(raw);
  if (!isObject(parsed)) throw new Error('invalid mapping');
  for (const value of Object.values(parsed)) {
    if (!isObject(value) || !Object.keys(value).length ||
        Object.entries(value).some(([tier, id]) => !TIERS.includes(tier) || typeof id !== 'string' || !id || id.length > 160) ||
        new Set(Object.values(value)).size !== Object.keys(value).length) throw new Error('invalid mapping');
  }
  const selected = Object.hasOwn(parsed, providerID) ? parsed[providerID] : undefined;
  if (selected && Object.values(selected).some((id) => !Object.hasOwn(models, id))) throw new Error('unloaded mapping');
  return selected;
}

function catalog(provider, currentID, rawMapping) {
  const models = provider.models;
  const mapping = tierMapping(rawMapping, provider.id, models);
  const tierOf = (id) => Object.entries(mapping ?? {}).find(([, value]) => value === id)?.[0] ?? defaultTier(provider.id, id);
  if (!Object.hasOwn(models, currentID) || !tierOf(currentID)) return;
  // Do not spread/serialize providers or model options. They may contain credentials.
  const snapshot = (id) => {
    const model = models[id];
    return {
      id, tier: tierOf(id), name: String(model.name ?? id).slice(0, 120),
      date: typeof model.release_date === 'string' ? model.release_date : '',
      capabilities: model.capabilities ?? {}, limit: model.limit ?? {},
      inputCost: model.cost?.input, outputCost: model.cost?.output,
      status: model.status,
    };
  };
  const all = (mapping ? Object.values(mapping) : Object.keys(models))
    // Jev's long-work tier is an opt-in, not an automatic upgrade into Astra.
    .filter((id) => id !== 'gpt-6-astra' || id === currentID || mapping)
    .filter((id) => id.length <= 160 && tierOf(id)).map(snapshot)
    .filter((model) => model.status !== 'deprecated' && model.status !== 'alpha');
  const current = snapshot(currentID);
  return { current, all };
}

function contextFor(history, parts, messageID) {
  const previous = history.filter((message) => message.info?.id !== messageID);
  // This hook has no reliable media-token budget. Conservatively retain the exact
  // model for any file-bearing history, rather than advertising false compatibility.
  const hasFile = (part) => part.type === 'file' || (part.type === 'tool' && part.state?.attachments?.length > 0);
  if (parts.some(hasFile) || previous.some((message) => message.parts?.some(hasFile))) {
    return { hasFiles: true, tokens: Infinity, known: false };
  }
  // Serialized UTF-8 bytes are a conservative text-token upper estimate. Never put
  // this history in the classifier request. Count tool results and reasoning too.
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const pastBytes = bytes(previous.map((message) => message.parts));
  const newBytes = bytes(parts);
  const assistant = previous.findLast((message) => message.info?.role === 'assistant');
  const usage = assistant?.info.tokens;
  const total = usage && Math.max(
    positive(usage.total) ? usage.total : 0,
    [usage.input, usage.output, usage.reasoning, usage.cache?.read, usage.cache?.write]
      .reduce((sum, value) => sum + (positive(value) ? value : 0), 0),
  );
  return {
    tokens: Math.max(pastBytes + newBytes, Math.ceil((total ?? 0) * 1.25) + newBytes) + HEADROOM,
    known: previous.length === 0 || positive(total) || pastBytes < HEADROOM,
    hasFiles: false,
  };
}

function eligible(model, current, context) {
  if (model.id === current.id) return true; // Always retain the exact fallback.
  const cap = model.capabilities;
  if (cap.toolcall !== true || cap.output?.text !== true || cap.input?.text !== true || context.hasFiles) return false;
  const limit = model.limit;
  if (!positive(limit.context) || !positive(limit.output)) return false;
  const usable = Math.min(limit.context - Math.min(limit.output, HEADROOM), limit.input ?? Infinity);
  if (usable < context.tokens * 1.2) return false;
  const downgrade = TIERS.indexOf(model.tier) < TIERS.indexOf(current.tier);
  if (downgrade && (!context.known || context.tokens >= DOWNGRADE_LIMIT)) return false;
  if (!context.known && (limit.context < current.limit.context ||
      (limit.input ?? limit.context) < (current.limit.input ?? current.limit.context))) return false;
  return true;
}

function candidatesFor(catalog, context) {
  const available = catalog.all.filter((model) => eligible(model, catalog.current, context));
  // Newest eligible model in each tier, with stable natural-ID tie breaking.
  available.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id, 'en', { numeric: true }));
  const result = TIERS.flatMap((tier) => available.find((model) => model.tier === tier) ?? []);
  if (!result.some((model) => model.id === catalog.current.id)) result.push(catalog.current);
  return result;
}

function localSettings(env) {
  const url = new URL(env.TYPESAFE_BASE_URL);
  const timeout = Number(env.LAYA_ROUTER_TIMEOUT_MS ?? '10000');
  const deadline = Number(env.LAYA_ROUTER_DEADLINE_MS ?? '12000');
  if (!env.JEV_ROOT || !isAbsolute(env.JEV_ROOT) || !env.JEV_API_KEY?.trim() || !env.TYPESAFE_DEFAULT_MODEL?.trim() ||
      url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) ||
      !Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(deadline) || deadline < timeout || deadline > 120_000) {
    throw new Error('local classifier unconfigured');
  }
  return { timeout, deadline };
}

function description(model) {
  const price = (value) => Number.isFinite(value) && value >= 0 ? value : 'unknown';
  return `${model.name}; ${model.tier}; context=${model.limit.context ?? 'unknown'}; output=${model.limit.output ?? 'unknown'}; ` +
    `tools=${model.capabilities.toolcall === true}; reasoning=${model.capabilities.reasoning === true}; ` +
    `catalog input/output cost=${price(model.inputCost)}/${price(model.outputCost)} (zero may mean subscription, not relative capability)`;
}

// Bound each await, not the whole hook: a late SDK resolution must never resume
// routing and mutate a turn after fallback. All routing work shares this budget.
function routingDeadline() {
  const configured = Number(process.env.LAYA_ROUTER_DEADLINE_MS ?? '12000');
  const ms = Number.isSafeInteger(configured) && configured > 0 && configured <= 120_000 ? configured : 12000;
  const controller = new AbortController();
  const end = performance.now() + ms;
  const expired = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('routing deadline exceeded')), { once: true });
  });
  void expired.catch(() => {}); // close() also aborts when an early check/return skipped wait().
  const timer = setTimeout(() => controller.abort(), ms);
  const check = () => {
    if (controller.signal.aborted || performance.now() >= end) throw new Error('routing deadline exceeded');
  };
  return {
    signal: controller.signal,
    check,
    async wait(operation) {
      check();
      const result = await Promise.race([Promise.resolve().then(operation), expired]);
      check();
      return result;
    },
    close() { clearTimeout(timer); controller.abort(); },
  };
}

// Only this export: OpenCode's legacy plugin loader invokes every exported function.
export default async function layaRouterPlugin(ctx) {
  let classifier;
  // No backfill: accept completion only after observing an unfinished update in
  // this plugin instance. Fork/import emits completed clones without that phase.
  const lifecycles = new Map();
  let evictedThrough = -1;
  const observeStart = (message) => {
    if (lifecycles.has(message.id)) return;
    const created = message.time?.created;
    if (!Number.isSafeInteger(created) || created < 0 || created <= evictedThrough) return;
    if (lifecycles.size >= 1024) {
      const oldest = lifecycles.keys().next().value;
      evictedThrough = Math.max(evictedThrough, lifecycles.get(oldest).created);
      lifecycles.delete(oldest);
    }
    // A timestamp watermark conservatively prevents evicted starts being rearmed
    // by later updates, without an unbounded tombstone set of every old message ID.
    if (created > evictedThrough) lifecycles.set(message.id, { sessionID: message.sessionID, created, failed: false });
  };
  // Cache the first attribution (including fallback) to keep repeated snapshots on
  // the same ledger key. Promises coalesce concurrent updates; no messages are cached.
  const roots = new Map();
  const identifier = (id) => typeof id === 'string' && id.length > 0 && id.length <= 4096;
  const cacheRoot = (id, root) => {
    if (!roots.has(id) && roots.size >= 512) roots.delete(roots.keys().next().value);
    roots.set(id, root);
  };
  const rootFor = (sessionID) => {
    if (roots.has(sessionID)) return roots.get(sessionID);
    const controller = new AbortController();
    const lookup = async () => {
      const seen = new Set();
      let id = sessionID;
      while (seen.size < 32 && !seen.has(id) && !controller.signal.aborted) {
        seen.add(id);
        const cached = roots.get(id);
        if (typeof cached === 'string') return cached;
        // Do not await another pending ancestry lookup: cycles could deadlock.
        const { data } = await ctx.client.session.get({ path: { id }, signal: controller.signal, throwOnError: true });
        if (!data) return sessionID;
        if (!data.parentID) return id;
        if (!identifier(data.parentID)) return sessionID;
        id = data.parentID;
      }
      return sessionID;
    };
    let timer;
    const pending = Promise.race([
      lookup(),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(sessionID); }, 1000); }),
    ]).catch(() => sessionID).then((root) => {
      if (roots.get(sessionID) === pending) cacheRoot(sessionID, root);
      return root;
    }).finally(() => clearTimeout(timer));
    cacheRoot(sessionID, pending);
    return pending;
  };
  const log = (message, extra = {}) => {
    try {
      void Promise.resolve(ctx.client.app.log({
        body: { service: 'laya-router', level: 'info', message, extra }, signal: AbortSignal.timeout(100),
      })).catch(() => {});
    } catch { /* Logging must not break generation or write to the TUI's stdout. */ }
  };
  const loadClassifier = async () => {
    const settings = localSettings(process.env);
    classifier ??= (async () => {
      const config = await import(pathToFileURL(join(process.env.JEV_ROOT, 'src/config.mjs')).href);
      // OpenCode is a separate process from the launcher's warm-up. Set budgets
      // before importing/calling the lazily initialized TypeSafe SDK client here.
      Object.assign(config.THRESHOLDS, {
        jevTimeoutMs: settings.timeout, jevDeadlineMs: settings.deadline, jevMaxRetries: 0,
      });
      const { askJev } = await import(pathToFileURL(join(process.env.JEV_ROOT, 'src/router-local.mjs')).href);
      return { askJev };
    })();
    try { return await classifier; } catch (error) { classifier = undefined; throw error; }
  };

  return {
    async event({ event }) {
      if (!process.env.LAYA_USAGE_FILE || !isAbsolute(process.env.LAYA_USAGE_FILE)) return;
      const message = event?.properties?.info;
      if (event?.type === 'session.created' || event?.type === 'session.updated') {
        if (!identifier(message?.id) || roots.has(message.id)) return;
        // Prewarm ancestry so final message updates usually append synchronously;
        // OpenCode does not await plugin event promises during shutdown.
        if (!message.parentID) cacheRoot(message.id, message.id);
        else await rootFor(message.id);
        return;
      }
      if (event?.type !== 'message.updated' || message?.role !== 'assistant' ||
          !identifier(message.id) || !identifier(message.sessionID)) return;
      const lifecycle = lifecycles.get(message.id);
      if (message.error) {
        if (lifecycle) lifecycle.failed = true;
        return;
      }
      if (message.time?.completed === undefined && !message.finish) {
        observeStart(message);
        return;
      }
      if (!lifecycle || lifecycle.failed || lifecycle.sessionID !== message.sessionID || lifecycle.created !== message.time?.created ||
          !Number.isSafeInteger(message.time?.completed) || message.time.completed < 0 ||
          !['stop', 'length', 'tool-calls'].includes(message.finish) || !message.tokens || !identifier(message.sessionID)) return;
      // Capture only accounting fields before the async lookup, without mutating
      // the bus event or retaining prompt/summary/tool content. The helper validates
      // known counters; stats deduplicates OpenCode snapshots by globally unique
      // message ID, even if ancestry attribution changes after cache eviction.
      const snapshot = {
        role: message.role, id: message.id, sessionID: message.sessionID,
        providerID: message.providerID, modelID: message.modelID,
        time: { completed: message.time.completed },
        tokens: { input: message.tokens.input, output: message.tokens.output, reasoning: message.tokens.reasoning,
          total: message.tokens.total, cache: { read: message.tokens.cache?.read, write: message.tokens.cache?.write } },
      };
      const root = rootFor(message.sessionID);
      snapshot.sessionID = typeof root === 'string' ? root : await root;
      if (lifecycles.get(message.id) !== lifecycle || lifecycle.failed) return;
      recordOpenCodeUsage(snapshot);
    },
    async 'chat.message'(input, output) {
      if (process.env.LAYA_ROUTER_ENABLED === '0') return;
      const current = output.message.model;
      const details = { sessionID: input.sessionID, messageID: output.message.id };
      const keep = (reason) => log(`Keeping current model: ${reason}`, details);
      const text = output.parts.filter((part) => part.type === 'text' && !part.synthetic && !part.ignored)
        .map((part) => part.text).join('\n').trim();
      if (!text || output.parts.some((part) => ['tool', 'subtask', 'compaction'].includes(part.type))) return;
      const deadline = routingDeadline();
      const options = { signal: deadline.signal, throwOnError: true };
      try {
        const session = await deadline.wait(() => ctx.client.session.get({ path: { id: input.sessionID }, ...options }));
        if (!session.data) return await keep('session unavailable');
        if (!session.data.parentID && !roots.has(input.sessionID)) cacheRoot(input.sessionID, input.sessionID);
        if (session.data.parentID) return await keep('subagent session');
        const agents = await deadline.wait(() => ctx.client.app.agents(options));
        const agent = agents.data?.find((item) => item.name === output.message.agent);
        if (!agent || agent.hidden || !['primary', 'all'].includes(agent.mode)) return await keep('non-primary agent');
        // app.agents includes effective inline and Markdown agent model pins.
        if (agent.model) return await keep('agent has a pinned model');
        const loaded = await deadline.wait(() => ctx.client.config.providers(options));
        const provider = loaded.data?.providers?.find((item) => item.id === current.providerID);
        if (!provider?.models) return await keep('selected provider is not loaded');
        let catalogModels;
        try { catalogModels = catalog(provider, current.modelID, process.env.LAYA_ROUTER_MODELS); }
        catch { return await keep('invalid LAYA_ROUTER_MODELS mapping or mapped model not loaded'); }
        if (!catalogModels) return await keep('unrecognized current model; set LAYA_ROUTER_MODELS');
        const history = await deadline.wait(() => ctx.client.session.messages({ path: { id: input.sessionID }, ...options }));
        if (!Array.isArray(history.data)) return await keep('history unavailable');
        const context = contextFor(history.data, output.parts, output.message.id);
        const candidates = candidatesFor(catalogModels, context);
        if (candidates.length < 2) return await keep('no eligible alternative model');
        let route;
        try { route = await deadline.wait(loadClassifier); }
        catch { return await keep('local classifier unconfigured or unavailable'); }
        const answer = await deadline.wait(() => route.askJev({
          // Bound classifier state independently of the full-history context guard.
          prompt: text.slice(0, 4096).replace(/[\uD800-\uDBFF]$/, ''),
          current: current.modelID, contextTokens: context.tokens,
          models: candidates.map((model) => ({ id: model.id, tier: GUIDANCE[TIERS.indexOf(model.tier)], description: description(model) })),
        }));
        const selected = candidates.find((model) => model.id === answer?.choice);
        if (!selected || !Number.isFinite(answer.confidence) || answer.confidence < 0.3 || answer.confidence > 1) {
          return await keep('classifier failed, returned an invalid choice, or confidence was below 0.3');
        }
        deadline.check();
        if (selected.id !== current.modelID) {
          // Mutate the existing message; replacing output.message is ignored by
          // OpenCode. Never change provider, and never carry a variant across models.
          output.message.model = { providerID: current.providerID, modelID: selected.id };
        }
        await log('Routing decision', { ...details, providerID: current.providerID, from: current.modelID, to: selected.id, confidence: answer.confidence });
      } catch {
        // Never log an SDK error object: it can contain request data or credentials.
        await keep('routing unavailable');
      } finally {
        deadline.close();
      }
    },
  };
}
