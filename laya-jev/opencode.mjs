import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Only add the server plugin. Native providers, authentication, agents, model selection,
// and auxiliary models remain OpenCode's responsibility. No .env files are loaded here.
export function buildOpenCodeConfig({ existing = {} } = {}) {
  if (typeof existing === 'string') {
    try { existing = JSON.parse(existing); } catch { throw new Error('OPENCODE_CONFIG_CONTENT must contain valid JSON'); }
  }
  if (!isObject(existing)) throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object');
  const config = structuredClone(existing);
  const plugin = new URL('./opencode-plugin.mjs', import.meta.url).href;
  config.plugin ??= [];
  if (!Array.isArray(config.plugin)) throw new Error('OpenCode plugin configuration must be an array');
  if (!config.plugin.some((entry) => (Array.isArray(entry) ? entry[0] : entry) === plugin)) config.plugin.push(plugin);
  return config;
}

// --model chooses the native provider and initial model, not an automatic-routing
// sentinel. LAYA_ROUTER_ENABLED=0 disables routing and keeps exact model choices.
export function openCodeArgs(args) {
  return [...args];
}

export async function main(args = process.argv.slice(2)) {
  const config = buildOpenCodeConfig({ existing: process.env.OPENCODE_CONFIG_CONTENT || '{}' });
  const child = spawn('opencode', openCodeArgs(args), {
    stdio: 'inherit',
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
  });
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.code ?? ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[result.signal] ?? 1);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => { console.error(`[laya-router] ${err.message}`); process.exitCode = 1; });
}
