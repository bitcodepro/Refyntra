#!/usr/bin/env bash
# Linux smoke: build and test Refyntra on Linux in a container, without VS Code.
#   bash scripts/test/linux.sh            # on a machine with Docker; mounts the repo read-only
# Inside the container (mode --inside) the repo is copied without node_modules/bin/obj/dist, so the checkout is untouched.
# Image: .NET SDK 10 with Node 22 copied from the node:22 image; pnpm comes from corepack (version from package.json).
set -uo pipefail

if [ "${1:-}" != "--inside" ]; then
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  # Git Bash on Windows would rewrite /src and /work; keep the container paths as they are.
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  docker build -q -t refyntra-linux-smoke - <<'DOCKERFILE'
FROM node:22-bookworm AS node
FROM mcr.microsoft.com/dotnet/sdk:10.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends rsync >/dev/null && rm -rf /var/lib/apt/lists/*
DOCKERFILE
  [ "${1:-}" = "--build-image-only" ] && exit 0 # used by linux-e2e.sh, which builds on this image
  # --init: a real init reaps orphans; without it a killed grandchild stays a zombie and kill(pid,0) still succeeds.
  exec docker run --rm --init -v "$repo:/src:ro" -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
    refyntra-linux-smoke bash /src/scripts/test/linux.sh --inside
fi

step() { printf '\n==== %s ====\n' "$*"; }
step "environment"
uname -a; node --version; dotnet --version
mkdir -p /work
rsync -a --exclude node_modules --exclude bin --exclude obj --exclude dist --exclude out --exclude '*.tsbuildinfo' --exclude .git --exclude .vscode-test \
  --exclude /packages/extension/servers/ --exclude /packages/extension/host/ /src/ /work/
# The staging folders of a local package:vsix (servers/, host/) are left out: the container builds its own, and the
# '--exclude dist' above would leave a partial copy (servers/pyright without its dist/ folder).
cd /work
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
pnpm --version

declare -A RESULT
run() { # run <label> <command...>: record the outcome, keep going so one failure does not hide the others
  local label="$1"; shift
  step "$label"
  if "$@"; then RESULT[$label]=PASS; else RESULT[$label]="FAIL ($?)"; fi
}
run "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
run "pnpm -r run build"              pnpm -r run build
run "pnpm test:unit"                 pnpm test:unit
run "pnpm test:architecture"         pnpm test:architecture
# Build first, then test with --no-build: a combined "dotnet test" of the cold tree stalled in this container (the host tests
# then start their own restores/MSBuild from inside the test run); the split form is stable. The hang timeout turns a stuck run into a failure.
run "dotnet build (Release)"         dotnet build src/dotnet/Refyntra.sln -c Release
run "dotnet test (Release)"          dotnet test src/dotnet/Refyntra.sln -c Release --no-build --blame-hang-timeout 600s --blame-hang-dump-type none
bench() {
  cp -r tests/fixtures/Shop /tmp/Shop
  node scripts/test/benchmark.mjs --out /tmp/perf --date linux Shop=/tmp/Shop/Shop.sln && cat /tmp/perf/baseline-linux.md
}
run "benchmark on a Shop copy (headless)" bench
step "orphan processes after the benchmark"
pgrep -fa 'Refyntra.Host|BuildHost' || echo "none"

step "summary"
rc=0
for k in "${!RESULT[@]}"; do printf '%-45s %s\n' "$k" "${RESULT[$k]}"; [ "${RESULT[$k]}" = PASS ] || rc=1; done
exit $rc
