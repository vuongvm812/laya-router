import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, stat, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const exec = promisify(execFile);
const bundle = dirname(fileURLToPath(import.meta.url));
// Supply an already installed pinned checkout; this suite never downloads dependencies.
const jevSource = process.env.JEV_ROOT;
const revisions = {
  laya: '9d955671415fc19f069b9cc998928075c1f255ec',
  'jev-router': '38da6b84ea01241bfc41fbddc0928d0f40a703f0',
};
const origins = {
  laya: 'https://github.com/NandhaKishorM/laya.git',
  'jev-router': 'https://github.com/gargpratyush/jev-router.git',
};

// Strict command doubles: unexpected invocations fail rather than reaching real tools.
const stub = `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const env = process.env;
const root = env.INSTALL_DIR;
const revisions = ${JSON.stringify(revisions)};
const origins = ${JSON.stringify(origins)};
appendFileSync(env.STUB_LOG, JSON.stringify({ name, args, env: Object.fromEntries(
  ['HOME', 'LAYA_HOST', 'LAYA_PORT', 'LAYA_DEVICE', 'LAYA_MODELS', 'LAYA_API_KEY', 'HF_HOME']
    .map(key => [key, env[key]])) }) + '\\n');
switch (name) {
  case 'uname':
    assert.ok(args.length === 1 && ['-s', '-m'].includes(args[0]));
    console.log(args[0] === '-s' ? 'Darwin' : 'arm64');
    break;
  case 'git': {
    if (args[0] === 'clone') {
      const target = args[3];
      const repo = basename(target);
      assert.ok(repo in revisions);
      assert.deepEqual(args, ['clone', '--no-checkout', origins[repo], join(root, repo)]);
      mkdirSync(target);
      if (repo === 'jev-router') {
        // Copy mutable source, never symlink it: prepare writes sibling -local files.
        cpSync(join(env.STUB_JEV_SOURCE, 'src'), join(target, 'src'), {
          recursive: true, filter: file => !file.endsWith('-local.mjs'),
        });
        cpSync(join(env.STUB_JEV_SOURCE, 'package.json'), join(target, 'package.json'));
        cpSync(join(env.STUB_JEV_SOURCE, 'node_modules'), join(target, 'node_modules'), { recursive: true });
      }
      break;
    }
    assert.equal(args[0], '-C');
    const repo = basename(args[1]);
    assert.ok(repo in revisions);
    assert.equal(resolve(args[1]), join(root, repo));
    const action = args.slice(2);
    if (action[0] === 'checkout') assert.deepEqual(action, ['checkout', '--detach', revisions[repo]]);
    else if (action[0] === 'remote') {
      assert.deepEqual(action, ['remote', 'get-url', 'origin']);
      const origin = env.STUB_ORIGIN_OVERRIDE || origins[repo];
      console.log(env.STUB_REWRITE_GITHUB === '1' ? origin.replace('https://github.com/', 'git@github.com:') : origin);
    } else if (action[0] === 'config') {
      assert.deepEqual(action, ['config', '--local', '--get', 'remote.origin.url']);
      console.log(env.STUB_ORIGIN_OVERRIDE || origins[repo]);
    } else if (action[0] === 'rev-parse') {
      assert.deepEqual(action, ['rev-parse', 'HEAD']);
      console.log(revisions[repo]);
    } else assert.deepEqual(action, ['status', '--porcelain', '--untracked-files=no']);
    break;
  }
  case 'npm':
    assert.deepEqual(args, ['--prefix', join(root, 'jev-router'), 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    break;
  case 'uv':
    if (args[0] === 'venv') {
      assert.deepEqual(args, ['venv', '--python', '3.12', join(root, 'venv')]);
      mkdirSync(join(root, 'venv/bin'), { recursive: true });
      for (const executable of ['python', 'laya-serve']) symlinkSync(env.STUB_SCRIPT, join(root, 'venv/bin', executable));
    } else assert.deepEqual(args, ['pip', 'install', '--python', join(root, 'venv/bin/python'), root + '/laya[serve]', 'torch==2.14.0']);
    break;
  case 'python':
    assert.equal(args[0], '-c');
    assert.equal(args.length, 2);
    assert.match(args[1], /torch.backends.mps.is_available/);
    break;
  case 'laya-serve':
    assert.deepEqual(args, []);
    break;
  case 'docker':
    assert.ok(args[0] === 'info' || args[0] === 'compose');
    break;
  default: throw new Error('Unexpected stub: ' + name);
}
`;

async function sandbox(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'laya setup test ')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'install with spaces');
  const home = join(scratch, 'home with spaces');
  const bin = join(scratch, 'stub commands');
  await mkdir(home);
  await mkdir(bin);
  const script = join(scratch, 'stub.mjs');
  const log = join(scratch, 'commands.jsonl');
  await writeFile(script, stub, { mode: 0o700 });
  await writeFile(log, '');
  await symlink(process.execPath, join(bin, 'node'));
  for (const command of ['git', 'npm', 'uv', 'docker', 'uname']) await symlink(script, join(bin, command));
  // Deliberately omit the caller's credentials, settings and package-manager PATH.
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: scratch,
    INSTALL_DIR: root, STUB_LOG: log, STUB_SCRIPT: script, STUB_JEV_SOURCE: jevSource,
  };
  async function run(command, args, overrides = {}) {
    try {
      return { code: 0, ...await exec(command, args, { env: { ...env, ...overrides }, cwd: home, timeout: 20000 }) };
    } catch (error) {
      if (typeof error.code !== 'number' || error.killed) throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }
  return {
    root, home,
    setup: (args = [], overrides = {}) => run('/bin/bash', [join(bundle, '../setup-laya-jev.sh'), ...args], overrides),
    launch: (name, args = []) => run(join(root, 'bin', name), args),
    config: async () => JSON.parse(await readFile(join(root, 'install.json'), 'utf8')),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  };
}

function succeeded(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
}

async function classifier(t, checkpoint, backend) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', loaded: [checkpoint], checkpoint_devices: { [checkpoint]: backend === 'native' ? 'mps' : 'cpu' } }));
        return;
      }
      assert.equal(req.url, '/v1/systemone');
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, checkpoint);
      const ids = Object.keys(body.questions.model.criteria);
      const answers = { model: { type: 'choice', choice: ids[0], confidence: 0.9, probabilities: Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 1 : 0])) } };
      for (const name of ['task_complexity', 'reasoning_required', 'tool_complexity']) {
        answers[name] = { type: 'score', score: 1, confidence: 0.9, legend: {}, probabilities: { 1: 1 } };
      }
      res.end(JSON.stringify({ model: checkpoint, answers, usage: { input_tokens: 100, output_tokens: 4 } }));
    } catch (error) {
      requests.push({ error: error.message });
      res.writeHead(500).end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { port: server.address().port, requests };
}

for (const backend of ['native', 'docker']) {
  test(`${backend}: real installer, spaced paths, generated launchers and repeat install`, { timeout: 60000 }, async t => {
    const box = await sandbox(t);
    const checkpoint = 'multilingual';
    const fixture = await classifier(t, checkpoint, backend);
    const args = backend === 'native' ? [] : ['docker'];
    succeeded(await box.setup(args, { LAYA_PORT: String(fixture.port) }));
    const config = await box.config();
    assert.deepEqual({ ...config, key: '<generated>' }, {
      backend, port: fixture.port, checkpoint, key: '<generated>',
      layaSHA: revisions.laya, jevSHA: revisions['jev-router'], timeoutMs: 10000, deadlineMs: 12000,
    });
    assert.match(config.key, /^[a-f0-9]{64}$/);
    assert.equal((await stat(join(box.root, 'install.json'))).mode & 0o777, 0o600);
    for (const name of ['laya-serve-local', 'laya-check', 'laya-stats', 'laya-claude', 'laya-codex', 'laya-opencode']) {
      assert.equal((await stat(join(box.root, 'bin', name))).mode & 0o777, 0o700, name);
    }
    for (const name of ['proxy', 'codex-proxy']) {
      const original = await readFile(join(jevSource, 'src', `${name}.mjs`), 'utf8');
      assert.equal(await readFile(join(box.root, 'jev-router/src', `${name}.mjs`), 'utf8'), original);
      assert.match(await readFile(join(box.root, 'jev-router/src', `${name}-local.mjs`), 'utf8'), /^\/\/ Generated by laya-jev prepare.mjs/);
    }

    const checked = await box.launch('laya-check');
    succeeded(checked);
    const report = JSON.parse(checked.stdout);
    assert.equal(report.classifier, `http://127.0.0.1:${fixture.port}`);
    assert.equal(report.checkpoint, checkpoint);
    assert.ok(report.choice);
    assert.deepEqual(fixture.requests.map(r => r.url), ['/health', '/v1/systemone', '/v1/systemone', '/health']);
    for (const request of fixture.requests.filter(r => r.url === '/v1/systemone')) {
      assert.equal(request.method, 'POST');
      assert.equal(request.authorization, `Bearer ${config.key}`);
    }
    const requestCount = fixture.requests.length;
    const usage = await box.launch('laya-stats', ['--json']);
    succeeded(usage);
    assert.equal(JSON.parse(usage.stdout).latestSession, null);
    assert.equal(JSON.parse(usage.stdout).last5h.totalTokens, 0);
    assert.equal(fixture.requests.length, requestCount, 'stats must not query the classifier');
    succeeded(await box.launch('laya-serve-local'));
    const calls = await box.calls();
    assert.equal(calls.filter(c => c.name === 'git' && c.args[0] === 'clone').length, 2);
    assert.equal(calls.filter(c => c.name === 'npm').length, 1);
    const serve = calls.findLast(c => c.name === (backend === 'native' ? 'laya-serve' : 'docker'));
    assert.deepEqual(serve.env, {
      HOME: box.home, LAYA_HOST: backend === 'native' ? '127.0.0.1' : '0.0.0.0',
      LAYA_PORT: String(fixture.port), LAYA_DEVICE: backend === 'native' ? 'mps' : 'cpu',
      LAYA_MODELS: checkpoint, LAYA_API_KEY: config.key, HF_HOME: join(box.root, 'model-cache'),
    });
    if (backend === 'native') {
      assert.equal(calls.filter(c => c.name === 'uv' && c.args[0] === 'venv').length, 1);
      assert.equal(calls.filter(c => c.name === 'uv' && c.args[0] === 'pip').length, 1);
      assert.equal(calls.filter(c => c.name === 'python').length, 1);
      assert.equal(calls.filter(c => c.name === 'docker').length, 0);
    } else {
      const docker = calls.filter(c => c.name === 'docker');
      assert.deepEqual(docker.slice(0, 2).map(c => c.args), [['info'], ['compose', 'version']]);
      assert.equal(docker.length, 4);
      const project = docker[2].args[2];
      assert.match(project, /^laya-jev-[a-f0-9]{10}$/);
      const prefix = ['compose', '--project-name', project, '-f', join(box.root, 'tools/compose.yaml')];
      assert.deepEqual(docker[2].args, [...prefix, 'build', 'laya']);
      assert.deepEqual(docker[3].args, [...prefix, 'up', '--no-build', '--abort-on-container-exit', 'laya']);
      assert.equal(calls.filter(c => c.name === 'uv' || c.name === 'python').length, 0);
    }

    const before = await readFile(join(box.root, 'install.json'), 'utf8');
    const editedTool = (await readFile(join(box.root, 'tools/runtime.mjs'), 'utf8')) + '\n// Local customization\n';
    const editedLauncher = (await readFile(join(box.root, 'bin/laya-check'), 'utf8')) + '\n# Local customization\n';
    await writeFile(join(box.root, 'tools/runtime.mjs'), editedTool);
    await writeFile(join(box.root, 'bin/laya-check'), editedLauncher);
    succeeded(await box.setup(args, { LAYA_PORT: '43210' }));
    assert.equal(await readFile(join(box.root, 'install.json'), 'utf8'), before, 'reruns preserve the key and all saved settings');
    const backupDirectories = await readdir(join(box.root, 'backups'));
    assert.equal(backupDirectories.length, 1);
    const backup = join(box.root, 'backups', backupDirectories[0]);
    assert.equal(await readFile(join(backup, 'tools/runtime.mjs'), 'utf8'), editedTool);
    assert.equal(await readFile(join(backup, 'bin/laya-check'), 'utf8'), editedLauncher);
    const rerun = (await box.calls()).slice(calls.length);
    assert.equal(rerun.filter(c => c.name === 'git' && c.args[0] === 'clone').length, 0);
    assert.equal(rerun.filter(c => c.name === 'uv' && c.args[0] === 'venv').length, 0);
    succeeded(await box.launch('laya-check'));

    const count = (await box.calls()).length;
    const mismatch = await box.setup([backend === 'native' ? 'docker' : 'native']);
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /Existing installation differs/);
    assert.equal(await readFile(join(box.root, 'install.json'), 'utf8'), before);
    assert.equal((await box.calls()).slice(count).filter(c => ['git', 'npm', 'uv'].includes(c.name)).length, 0);
  });
}

test('explicit checkpoint switches preserve saved settings and reach the server and SDK', { timeout: 30000 }, async t => {
  const box = await sandbox(t);
  const fixture = await classifier(t, 'multilingual', 'native');
  succeeded(await box.setup([], { LAYA_PORT: String(fixture.port), LAYA_CHECKPOINT: 'english' }));
  const english = await box.config();
  assert.equal(english.checkpoint, 'english');

  succeeded(await box.setup());
  assert.deepEqual(await box.config(), english, 'no explicit override preserves existing English installs');

  succeeded(await box.setup([], { LAYA_CHECKPOINT: 'multilingual' }));
  assert.deepEqual(await box.config(), { ...english, checkpoint: 'multilingual' });
  assert.equal((await stat(join(box.root, 'install.json'))).mode & 0o777, 0o600);
  const checked = await box.launch('laya-check');
  succeeded(checked);
  assert.equal(JSON.parse(checked.stdout).checkpoint, 'multilingual');
  succeeded(await box.launch('laya-serve-local'));
  assert.equal((await box.calls()).findLast(c => c.name === 'laya-serve').env.LAYA_MODELS, 'multilingual');

  const before = await readFile(join(box.root, 'install.json'), 'utf8');
  for (const invalid of ['unknown', '']) {
    const result = await box.setup([], { LAYA_CHECKPOINT: invalid });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /LAYA_CHECKPOINT must be/);
    assert.equal(await readFile(join(box.root, 'install.json'), 'utf8'), before);
  }
});

test('Git HTTPS-to-SSH rewrites do not reject the stored origin; different repositories still fail', { timeout: 30000 }, async t => {
  const box = await sandbox(t);
  succeeded(await box.setup([], { STUB_REWRITE_GITHUB: '1' }));
  const before = await readFile(join(box.root, 'install.json'), 'utf8');
  succeeded(await box.setup([], { STUB_REWRITE_GITHUB: '1' }));
  assert.equal(await readFile(join(box.root, 'install.json'), 'utf8'), before);

  const count = (await box.calls()).length;
  const mismatch = await box.setup([], {
    STUB_REWRITE_GITHUB: '1', STUB_ORIGIN_OVERRIDE: 'https://github.com/different/repository.git',
  });
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /Unexpected origin:/);
  assert.equal((await box.calls()).slice(count).filter(c => ['npm', 'uv'].includes(c.name)).length, 0);
});

test('invalid first-install environment fails before checkout or dependency installation', { timeout: 30000 }, async t => {
  for (const [key, value] of [
    ['LAYA_PORT', '1023'], ['LAYA_PORT', '65536'], ['LAYA_PORT', '8000.5'], ['LAYA_PORT', 'not-a-port'],
    ['LAYA_CHECKPOINT', 'unknown'],
  ]) {
    await t.test(`${key}=${value}`, async t => {
      const box = await sandbox(t);
      const result = await box.setup([], { [key]: value });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`${key} must be`));
      await assert.rejects(stat(join(box.root, 'install.json')), { code: 'ENOENT' });
      await assert.rejects(stat(join(box.root, 'bin')), { code: 'ENOENT' });
      assert.equal((await box.calls()).filter(c => ['git', 'npm', 'uv', 'docker'].includes(c.name)).length, 0);
    });
  }
});
