#!/usr/bin/env bash
# Linux end-to-end: the real VS Code (Linux build, headless under Xvfb) against the Linux-built host, in a container.
#   bash scripts/test/linux-e2e.sh        # on a machine with Docker; mounts the repo read-only
# Runs: pnpm install/build, test:unit, test:architecture, dotnet build + test (incl. the abrupt-kill orphan test),
# test:integration, test:e2e (REFYNTRA_HOST_PATH = the Release host built in the container), package:vsix, test:install.
# The repo is copied to /work inside the container (no node_modules/bin/obj/dist/.vscode-test), so the checkout is untouched.
# Docker volumes keep the downloaded VS Code (refyntra-vscode-test) and the NuGet cache (refyntra-nuget) between runs.
# REFYNTRA_TEST_VSCODE_VERSION (default 1.90.2) is passed through.
# REFYNTRA_VNC=1 (or --vnc): watch the run live, see scripts/test/lib/display.sh and the README.
# REFYNTRA_E2E_IMAGE / REFYNTRA_SMOKE_IMAGE / REFYNTRA_DOCKER_VOLUME_PREFIX: other image tags and cache volumes, so that
# parallel work trees do not rebuild each other's image (defaults refyntra-linux-e2e, refyntra-linux-smoke, refyntra).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/display.sh"

if [ "${1:-}" != "--inside" ]; then
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  # Base image of linux.sh (.NET SDK 10 on Ubuntu 24.04 + Node 22) plus what Electron needs headless. Ubuntu 24.04 names
  # several libraries with a t64 suffix (64-bit time_t transition).
  bash "$(dirname "${BASH_SOURCE[0]}")/linux.sh" --build-image-only || exit 1
  docker build -q -t "${REFYNTRA_E2E_IMAGE:-refyntra-linux-e2e}" --build-arg BASE="${REFYNTRA_SMOKE_IMAGE:-refyntra-linux-smoke}" - <<'DOCKERFILE' || exit 1
ARG BASE=refyntra-linux-smoke
FROM ${BASE}
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      xvfb xauth dbus dbus-x11 procps libglib2.0-bin \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libgtk-3-0t64 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0 \
      libxss1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxshmfence1 libcups2t64 \
      imagemagick xdotool fonts-dejavu-core x11-utils x11vnc novnc websockify >/dev/null \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
  # imagemagick (import -window root), xdotool (keys, window size) and one fixed font family serve linux-visual.sh;
  # x11-utils, x11vnc, novnc and websockify the VNC watch mode (REFYNTRA_VNC=1 or --vnc, scripts/test/lib/display.sh).
  [ "${1:-}" = "--build-image-only" ] && exit 0 # used by linux-visual.sh, which runs on this image
  [ "${1:-}" = "--vnc" ] && export REFYNTRA_VNC=1
  mapfile -t vnc_args < <(vnc_docker_args)
  vnc_note
  # --init: a real init reaps orphans (see linux.sh).
  exec docker run --rm --init ${vnc_args[@]+"${vnc_args[@]}"} -v "$repo:/src:ro" -v "${REFYNTRA_DOCKER_VOLUME_PREFIX:-refyntra}-vscode-test:/cache/vscode-test" -v "${REFYNTRA_DOCKER_VOLUME_PREFIX:-refyntra}-nuget:/root/.nuget/packages" \
    -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 -e REFYNTRA_TEST_VSCODE_VERSION="${REFYNTRA_TEST_VSCODE_VERSION:-1.90.2}" \
    "${REFYNTRA_E2E_IMAGE:-refyntra-linux-e2e}" bash /src/scripts/test/linux-e2e.sh --inside
fi

step() { printf '\n==== %s ====\n' "$*"; }
step "environment"
uname -a; grep PRETTY_NAME /etc/os-release; node --version; dotnet --version; echo "VS Code $REFYNTRA_TEST_VSCODE_VERSION"
mkdir -p /work
rsync -a --exclude node_modules --exclude bin --exclude obj --exclude dist --exclude out --exclude '*.tsbuildinfo' --exclude .git --exclude .vscode-test \
  --exclude /packages/extension/servers/ --exclude /packages/extension/host/ --exclude /packages/extension/debuggers/ /src/ /work/
# The staging folders of a local package:vsix (servers/, host/) are left out: the container builds its own, and the
# '--exclude dist' above would leave a partial copy (servers/pyright without its dist/ folder).
ln -sfn /cache/vscode-test /work/.vscode-test
cd /work
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
export REFYNTRA_HOST_PATH=/work/src/dotnet/Refyntra.Host/bin/Release/net10.0/Refyntra.Host.dll

declare -a ORDER
declare -A RESULT
run() { # run <label> <command...>: record the outcome, keep going
  local label="$1"; shift
  step "$label"
  ORDER+=("$label")
  if "$@"; then RESULT[$label]=PASS; else RESULT[$label]="FAIL ($?)"; fi
}
orphans() { ! pgrep -fa 'Refyntra\.Host|Workspaces\.MSBuild\.BuildHost|refyntra-watchdog|netcoredbg|debugpy|ConsoleApp\.dll|WebApp\.dll' | grep -v pgrep; }
run "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
run "pnpm -r run build"              pnpm -r run build
run "pnpm test:unit"                 pnpm test:unit
run "pnpm test:architecture"         pnpm test:architecture
run "dotnet build (Release)"         dotnet build src/dotnet/Refyntra.sln -c Release
run "dotnet test (Release)"          dotnet test src/dotnet/Refyntra.sln -c Release --no-build --blame-hang-timeout 600s --blame-hang-dump-type none
# The bundled debug adapters for this platform (netcoredbg linux-x64, debugpy): official release URLs, SHA-256 pinned.
run "stage debug adapters"           node scripts/package/servers.mjs --debuggers
display_start
run "xvfb-run pnpm test:integration" xrun -- pnpm test:integration
run "xvfb-run pnpm test:e2e"         xrun -- pnpm test:e2e
run "no host/BuildHost left (e2e)"   orphans
run "pnpm package:vsix"              pnpm package:vsix
run "xvfb-run pnpm test:install"     xrun -- pnpm test:install
run "no host/BuildHost left (end)"   orphans

step "summary"
rc=0
for k in "${ORDER[@]}"; do printf '%-40s %s\n' "$k" "${RESULT[$k]}"; [ "${RESULT[$k]}" = PASS ] || rc=1; done
exit $rc
