#!/bin/bash
set -euo pipefail
umask 077

# Usage: bash setup-laya-jev.sh [native|docker]
# Optional: INSTALL_DIR, LAYA_PORT, LAYA_CHECKPOINT=multilingual|english (default: multilingual)
BACKEND=${1:-native}
ROOT=${INSTALL_DIR:-"$HOME/.local/share/laya-jev"}
BUNDLE="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/laya-jev"
LAYA_SHA=9d955671415fc19f069b9cc998928075c1f255ec
JEV_SHA=38da6b84ea01241bfc41fbddc0928d0f40a703f0
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null || die "Missing $1; see README.md prerequisites."; }

case "$BACKEND" in native | docker) ;; *) die 'Usage: bash setup-laya-jev.sh [native|docker]' ;; esac
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || die 'Run from a native Apple Silicon macOS terminal (not Rosetta).'
[[ "$ROOT" == /* ]] || die 'INSTALL_DIR must be an absolute path.'
for command in git node npm; do need "$command"; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<20 || (a===20 && b<12)) process.exit(1)' || die 'Node >=20.12 required (Node 22+ recommended).'
if [[ "$BACKEND" == native ]]; then
  need uv
else
  need docker
  docker info >/dev/null
  docker compose version >/dev/null
fi

mkdir -p "$ROOT"
ROOT=$(CDPATH='' cd -- "$ROOT" && pwd)
export ROOT BACKEND LAYA_SHA JEV_SHA
# Preserve saved settings unless a checkpoint override is explicit; refuse backend/revision drift.
node --input-type=module <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const e = process.env;
const file = `${e.ROOT}/install.json`;
const requestedCheckpoint = e.LAYA_CHECKPOINT;
if (requestedCheckpoint !== undefined && !['english', 'multilingual'].includes(requestedCheckpoint))
  throw new Error('LAYA_CHECKPOINT must be english or multilingual');
if (existsSync(file)) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (c.backend !== e.BACKEND || c.layaSHA !== e.LAYA_SHA || c.jevSHA !== e.JEV_SHA)
    throw new Error('Existing installation differs. Choose a new INSTALL_DIR.');
  if (requestedCheckpoint !== undefined && requestedCheckpoint !== c.checkpoint) {
    c.checkpoint = requestedCheckpoint;
    writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
    console.log(`Updated checkpoint to ${c.checkpoint}; restart Laya and the client launchers.`);
  } else {
    console.log(`Reusing install.json (checkpoint: ${c.checkpoint}).`);
  }
} else {
  const port = Number(e.LAYA_PORT || 8000);
  const checkpoint = requestedCheckpoint ?? 'multilingual';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LAYA_PORT must be 1024–65535');
  writeFileSync(file, JSON.stringify({
    backend: e.BACKEND, port, checkpoint, key: randomBytes(32).toString('hex'),
    layaSHA: e.LAYA_SHA, jevSHA: e.JEV_SHA,
    timeoutMs: 10000, deadlineMs: 12000,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
JS

checkout() {
  local name=$1 url=$2 sha=$3 dir="$ROOT/$1"
  if [[ ! -e "$dir" ]]; then
    git clone --no-checkout "$url" "$dir"
    git -C "$dir" checkout --detach "$sha"
  fi
  # remote get-url expands url.*.insteadOf (for example HTTPS -> SSH).
  # Validate the URL stored by clone, before the user's transport rewrite.
  [[ $(git -C "$dir" config --local --get remote.origin.url) == "$url" ]] || die "Unexpected origin: $dir"
  [[ $(git -C "$dir" rev-parse HEAD) == "$sha" ]] || die "Unexpected revision: $dir"
  [[ -z $(git -C "$dir" status --porcelain --untracked-files=no) ]] || die "Modified checkout: $dir"
  printf 'Using %s at %s\n' "$name" "$sha"
}
checkout laya https://github.com/NandhaKishorM/laya.git "$LAYA_SHA"
checkout jev-router https://github.com/gargpratyush/jev-router.git "$JEV_SHA"
npm --prefix "$ROOT/jev-router" ci --ignore-scripts --no-audit --no-fund

mkdir -p "$ROOT/tools" "$ROOT/bin"
BACKUP_DIR="$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_existing() {
  local target=$1 relative=$2
  if [[ -e "$target" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname -- "$relative")"
    cp -p "$target" "$BACKUP_DIR/$relative"
    printf 'Saved previous file: %s\n' "$BACKUP_DIR/$relative"
  fi
}
for file in runtime.mjs opencode.mjs opencode-plugin.mjs prepare.mjs usage.mjs compose.yaml; do
  if [[ -e "$ROOT/tools/$file" ]] && ! cmp -s "$BUNDLE/$file" "$ROOT/tools/$file"; then
    backup_existing "$ROOT/tools/$file" "tools/$file"
  fi
  cp "$BUNDLE/$file" "$ROOT/tools/$file"
done
node "$ROOT/tools/prepare.mjs" "$ROOT/jev-router"
if [[ "$BACKEND" == native ]]; then
  [[ -x "$ROOT/venv/bin/python" ]] || uv venv --python 3.12 "$ROOT/venv"
  uv pip install --python "$ROOT/venv/bin/python" "$ROOT/laya[serve]" 'torch==2.14.0'
  "$ROOT/venv/bin/python" -c 'import platform, torch; assert platform.machine() == "arm64", "Use native ARM64 Python"; assert torch.backends.mps.is_available(), "MPS unavailable; use the Docker CPU backend"; print("PyTorch", torch.__version__, "MPS available")'
else
  node "$ROOT/tools/runtime.mjs" build
fi

make_launcher() {
  local name=$1 action=$2
  local staged
  staged=$(mktemp "$ROOT/bin/.launcher.XXXXXX")
  {
    printf '#!/bin/bash\nset -euo pipefail\n'
    printf 'exec %q %q %q "$@"\n' "$(command -v node)" "$ROOT/tools/runtime.mjs" "$action"
  } >"$staged"
  if [[ -e "$ROOT/bin/$name" ]] && ! cmp -s "$staged" "$ROOT/bin/$name"; then
    backup_existing "$ROOT/bin/$name" "bin/$name"
  fi
  chmod 700 "$staged"
  mv "$staged" "$ROOT/bin/$name"
}
make_launcher laya-serve-local serve
make_launcher laya-check check
make_launcher laya-stats stats
make_launcher laya-claude claude
make_launcher laya-codex codex
make_launcher laya-opencode opencode
# shellcheck disable=SC2016 # Print a command for the user's shell, not our PATH.
printf '\nInstalled. Add to this shell:\n  export PATH=%q:"$PATH"\n' "$ROOT/bin"
printf '\nTerminal 1: laya-serve-local\nTerminal 2: laya-check\nThen: laya-claude | laya-codex | laya-opencode\nUsage: laya-stats\n'
