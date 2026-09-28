# Local Laya + Jev on Apple Silicon

This bundle installs **Laya as the local routing classifier** and **Jev Router as the coding-client proxy**. The coding models still run at Anthropic/OpenAI and require your normal access.

```text
Claude Code / Codex / OpenCode
        │
        ▼
   Laya router* ── classification ──► local Laya /v1/systemone
        │
        └── generation ──► Anthropic / OpenAI
```

*Claude Code and Codex use local Jev-based proxies; OpenCode uses a native routing plugin and its existing provider/authentication pipeline.*

## 1. Prerequisites

- Apple Silicon macOS terminal running natively, not under Rosetta.
- Git and Node.js >=20.12 (Node 22+ recommended).
- Default **native** backend: `uv`; Python 3.12 is installed by uv if needed. Native PyTorch uses **MPS / Apple GPU**.
- Optional **docker** backend: running Docker Desktop with Compose v2. This uses **ARM64 CPU**, not the Apple GPU. Allocate at least 8 GB of Docker RAM and 10 GB of free disk, per Laya's quickstart.
- Install and authenticate whichever clients you use: `claude`, `codex`, `opencode`.

If you use Homebrew, install the native prerequisites yourself:

```bash
brew install node uv
```

## 2. Install

The entry script is `setup-laya-jev.sh` at the repository root; its supporting files are in `laya-jev/`. From the repository root:

```bash
bash setup-laya-jev.sh native
export PATH="$HOME/.local/share/laya-jev/bin:$PATH"
```

Or choose Docker CPU instead:

```bash
bash setup-laya-jev.sh docker
export PATH="$HOME/.local/share/laya-jev/bin:$PATH"
```

Use one backend per installation. Optional settings for a separate English-only installation:

```bash
LAYA_PORT=8001 LAYA_CHECKPOINT=english \
  INSTALL_DIR="$HOME/.local/share/laya-jev-english" bash setup-laya-jev.sh native
```

Defaults are port `8000` and the **`multilingual` checkpoint for English and Japanese prompts**. The server preloads only the selected checkpoint, and the SDK explicitly requests that same checkpoint. A nonempty local bearer key is generated and stored in `install.json` with mode `0600`.

Rerunning the same version/backend reuses settings unless you explicitly set `LAYA_CHECKPOINT`. To switch an existing English installation to multilingual:

```bash
LAYA_CHECKPOINT=multilingual bash setup-laya-jev.sh native
```

Use `docker` instead of `native` if that is your existing backend. The switch preserves your bearer key, port, and timeout settings. Stop and restart `laya-serve-local`, run `laya-check`, and restart the client launchers. First use downloads the multilingual checkpoint.

`LAYA_PORT` applies only on first install; edit `<install-dir>/install.json` to change the saved port or timeouts. Use a different install directory to change backend or pinned revisions. When an upgrade replaces a differing installed tool or launcher, its previous contents are saved under `<install-dir>/backups/`. The scripts generate local launchers; they do not edit your shell startup files or register background jobs.

## 3. Start and check Laya

Terminal 1:

```bash
export PATH="$HOME/.local/share/laya-jev/bin:$PATH"
laya-serve-local
```

First startup downloads the public Hugging Face model. Wait for the server to finish loading and start listening.

Terminal 2:

```bash
export PATH="$HOME/.local/share/laya-jev/bin:$PATH"
laya-check
```

The check sends Jev's **actual four-question request through the real TypeSafe SDK**, then tests Jev's `askJev()` under its runtime timeout. Output includes the local URL, checkpoint, classification time, chosen model label, actual device, and CPU-fallback counters. It makes no generation request and consumes no Anthropic/OpenAI credits.

Native output should report `checkpoint_devices.multilingual: "mps"`. Docker should report `cpu`. Inspect fallback counters as well: Laya can temporarily fall back to CPU even when its reported resident device is MPS.

Keep Terminal 1 running while using clients. **Ctrl-C stops the foreground service.** The Docker container/model volume are retained; there is no auto-start policy. Native weights are under `<install-dir>/model-cache`; Docker uses a named volume.

## 4. Launch clients

### Claude Code

```bash
laya-claude
# or a noninteractive check using your normal Claude credentials:
laya-claude -p 'Reply with OK'
```

Choose **`laya-router`** in Claude's model picker for automatic routing. A concrete `--model`, `/model` choice, or preexisting `ANTHROPIC_MODEL` bypasses automatic selection. If needed, start with `ANTHROPIC_MODEL=laya-router laya-claude`.

The launcher adds the `laya-router` model-picker entry and saves/restores Claude's model setting on exit. Log messages use `[laya-router]`. For detailed proxy routing logs, export `JEV_DEBUG=1` before launching; interactive proxy logs go to `~/.laya-router.log`.

### Codex

```bash
laya-codex
# or:
laya-codex exec 'Reply with OK'
```

This uses Jev's Responses API proxy and your normal Codex authentication. An explicit `--model` selects that concrete model instead. The bundled launcher does not install Jev's optional global explanation skill.

### OpenCode — use your existing provider and login

```bash
laya-opencode
# Or choose a model available through your connected OpenAI provider:
laya-opencode --model openai/gpt-5.5
# Noninteractive:
laya-opencode run 'Reply with OK'
```

There is **no Anthropic key requirement in this launcher**. Connect your desired provider using OpenCode's normal authentication flow. OpenAI API-key and OpenAI OAuth authentication stay under OpenCode's control; Anthropic uses your normal OpenCode Anthropic configuration.

The launcher adds a process-local plugin without replacing providers, model selections, agent settings, or auxiliary models. On each ordinary primary-agent user turn, it asks local Laya to choose an eligible model **within the selected provider**, then lets OpenCode handle generation. Tool continuations reuse that turn's model. No custom `laya-jev` provider or Anthropic proxy is created.

Default mappings cover Claude Haiku/Sonnet/Opus and reviewed GPT-5 model families, including `gpt-5.6-luna`/`terra`/`sol`. `gpt-6-astra` is considered only when already selected or explicitly mapped. Candidates must exist in OpenCode's loaded model registry; the router does not infer account entitlements from a hard-coded list.

For other models/providers, supply exact loaded model IDs explicitly:

```bash
export LAYA_ROUTER_MODELS='{"openai":{"fast":"gpt-5-mini","balanced":"gpt-5","strong":"gpt-5.5"}}'
laya-opencode
```

`--model` chooses the starting model and provider; Laya can still route within that provider. To keep exact selections:

```bash
LAYA_ROUTER_ENABLED=0 laya-opencode
```

Pinned agents, subagents, synthetic-only messages, unrecognized models, and turns with insufficient context/capability information keep their existing model. File-bearing prompts/history also keep their exact model because media-token requirements cannot be measured reliably in this hook. Classifier failure or confidence below `0.3` retains the current model. Routing decisions appear in OpenCode's application logs under service `laya-router`.

Start a **new OpenCode process through this launcher** to load the updated plugin. A selected OpenAI model continues to use OpenAI; routing never switches a conversation to Anthropic automatically.

## 5. Token usage

```bash
laya-stats
# Machine-readable output:
laya-stats --json
```

Shows generation-token usage for:

- **Latest chat session:** all recorded responses in the most recently active observed session.
- **Last 5 hours:** a rolling window across all three clients.
- **Last 7 days:** a rolling window across all three clients.

The table separates uncached input, cache reads, cache writes, output, and reasoning. Total tokens include cached input and output; reasoning is already included in output and is not counted twice. Provider-reported final usage is recorded, including tool continuations. OpenCode subagent usage is grouped under its parent chat when the ancestry is available.

Usage is stored in `<install-dir>/usage.jsonl` with owner-only permissions. Records contain session/response IDs, model names, timestamps, and token counts—not prompts or provider credentials. Repeated usage updates for the same response are deduplicated when calculating totals.

These are **locally observed generation tokens**, not account-wide quota counters. Collection begins after installing this version and starting clients through these launchers; older chats and other client processes are not imported. OpenCode requires an observed unfinished-to-completed generation lifecycle, so copied/forked history and completions first seen after attaching mid-generation are not counted. Streams interrupted before final usage arrives are not counted. Local Laya classification tokens are excluded. `laya-stats` works while the Laya server is stopped and shows zero totals when no usage has been observed.

## How the replacement works

The generated launchers force these values; they use exported environment variables rather than automatically loading project `.env` files:

```bash
TYPESAFE_BASE_URL=http://127.0.0.1:8000  # API root, NOT /v1
TYPESAFE_DEFAULT_MODEL=multilingual    # Laya checkpoint, not a coding model
JEV_API_KEY=<generated-local-key>      # matches LAYA_API_KEY on the local server
```

The SDK appends `/v1/systemone`. Laya already implements that wire protocol, so no classifier-protocol adapter is needed. `ANTHROPIC_BASE_URL` / Codex provider URLs point to Jev's separate generation proxy, **not Laya**.

`prepare.mjs` creates named `*-local.mjs` integration copies beside the pinned upstream sources. They add `laya-router` naming, safe model-setting restoration, token-usage observation, metadata-only status records, request-size bounds, cancellation propagation, and a local HEAD probe. Original tracked upstream source is preserved. Generated copies have content digests so rerunning setup can upgrade intact copies while refusing to overwrite edited ones. Classifier requests reject HTTP redirects, and default error logs omit response bodies. `JEV_DUMP`, if explicitly enabled, still writes full request diagnostics and should be treated separately from the metadata-only usage ledger.

The bundle adjusts Jev's in-memory classifier timing to **10 seconds per request, 12 seconds total, no retry** to allow for local CPU/MPS inference. Set `timeoutMs` and `deadlineMs` in `install.json` to tune this after measuring. Every client launch warms and verifies the classifier. A later classification failure keeps the current coding model (initially the strong tier in the Claude/Codex proxies, or the selected native model in OpenCode).

Laya is API-compatible, but its confidence calibration and decisions are not identical to TypeSafe Jev. Upstream Jev's confidence threshold is retained. Its model-choice rubric can be truncated by Laya's checkpoint token budget, especially with large catalogs or long prompts. Evaluate routing on your own tasks before assuming equal quality or savings. Changing `LAYA_MAX_TOKEN_BUDGET` alone does not increase per-request context length.

## Verification and versions

- Laya source: `9d955671415fc19f069b9cc998928075c1f255ec` (`0.3.21`).
- Jev Router source: `38da6b84ea01241bfc41fbddc0928d0f40a703f0` (`0.3.0`), installed using its lockfile (`@typesafe-ai/sdk@0.6.0`).
- PyTorch: `2.14.0`, matching the pinned upstream Docker default; other Python transitive dependencies are resolved at installation.
- Model weights: Laya's `LAYA_REVISION=reviewed` revision policy.

The bundle is validated with shell checks, installer acceptance tests using stub dependencies, and loopback integration tests using the real pinned Jev proxy/SDK and simulated classifier/provider responses. The installed OpenCode CLI was exercised against native Anthropic Messages and OpenAI Responses mocks, including real file-read tool execution, routing, streamed responses, and usage totals. **Full model downloads, MPS inference, and live authenticated generation/OAuth were not run during preparation.** `laya-check` validates the real local model after you install it.

To rerun the included tests after installing:

```bash
NODE_OPTIONS= JEV_ROOT="$HOME/.local/share/laya-jev/jev-router" \
  node --test laya-jev/*.test.mjs
```

Add `OPENCODE_LIVE_TEST=1` to include the real OpenCode CLI with local mock generation; it requires `opencode` on PATH and may download its SDK/plugin dependencies.

## Sources

- [Laya Docker / HTTP serving](https://nandhakishorm.github.io/laya/docker/)
- [Laya Apple Silicon / Docker platform notes](https://nandhakishorm.github.io/laya/docker-platforms/)
- [Pinned Laya HTTP server](https://github.com/NandhaKishorM/laya/blob/9d955671415fc19f069b9cc998928075c1f255ec/laya/serve.py)
- [Pinned Jev classifier client](https://github.com/gargpratyush/jev-router/blob/38da6b84ea01241bfc41fbddc0928d0f40a703f0/src/router.mjs)
- [TypeSafe SDK environment configuration](https://github.com/typesafe-ai/typesafe-sdk-js/blob/66880ccded6cb642dc1809620c2b108c33730214/src/env.ts)
- [OpenCode configuration schema](https://opencode.ai/config.json)
