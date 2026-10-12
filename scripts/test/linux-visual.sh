#!/usr/bin/env bash
# Visual (screenshot) tests of the Refyntra UI in the real VS Code, ONLY headless in Docker (Xvfb), never on the desktop.
#   pnpm test:visual              # = bash scripts/test/linux-visual.sh; compares with tests/visual/baselines
#   pnpm test:visual --update     # regenerates the baselines from this run
# Image: refyntra-linux-e2e (linux-e2e.sh; with imagemagick, xdotool, fonts-dejavu-core). The repo is mounted read-only
# and copied to /work; only test-results/visual (and tests/visual/baselines with --update) are mounted writable.
# Fixed: Xvfb 1600x1000x24, VS Code REFYNTRA_TEST_VSCODE_VERSION (default 1.90.2, the version the other tests pin),
# Default Dark Modern + Default Light Modern, DejaVu fonts, zoom 0, no animations/cursor blink/tips/telemetry/welcome.
# Output: test-results/visual/{actual,diff}/<theme>/<scenario>.png and test-results/visual/report.html.
#   REFYNTRA_VNC=1 pnpm test:visual   # or --vnc: watch live at http://localhost:6080/vnc.html (view-only, localhost only);
#                                       REFYNTRA_VNC_PAUSE_MS=<ms> pauses after each case so a person can follow
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/display.sh"

if [ "${1:-}" != "--inside" ]; then
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  update=0
  for a in "$@"; do
    [ "$a" = "--update" ] && update=1
    [ "$a" = "--vnc" ] && export REFYNTRA_VNC=1
  done
  mapfile -t vnc_args < <(vnc_docker_args)
  vnc_note
  bash "$(dirname "${BASH_SOURCE[0]}")/linux-e2e.sh" --build-image-only || exit 1
  mkdir -p "$repo/test-results/visual" "$repo/tests/visual/baselines"
  baselines_mode=ro
  [ $update = 1 ] && baselines_mode=rw
  name="refyntra-visual-$$"
  # The container is removed on any exit of this script (also Ctrl+C or a timeout): nothing is left running.
  trap 'docker rm -f "$name" >/dev/null 2>&1' EXIT INT TERM
  timeout "${REFYNTRA_VISUAL_TIMEOUT:-3600}" docker run --rm --init --name "$name" ${vnc_args[@]+"${vnc_args[@]}"} \
    -v "$repo:/src:ro" -v "$repo/test-results/visual:/out" -v "$repo/tests/visual/baselines:/baselines:$baselines_mode" \
    -v refyntra-vscode-test:/cache/vscode-test -v refyntra-nuget:/root/.nuget/packages \
    -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 -e REFYNTRA_TEST_VSCODE_VERSION="${REFYNTRA_TEST_VSCODE_VERSION:-1.90.2}" \
    -e REFYNTRA_VISUAL_UPDATE=$update -e TZ=UTC -e LANG=C.UTF-8 \
    refyntra-linux-e2e bash /src/scripts/test/linux-visual.sh --inside
  exit $?
fi

step() { printf '\n==== %s ====\n' "$*"; }
mkdir -p /work
rsync -a --exclude node_modules --exclude bin --exclude obj --exclude dist --exclude out --exclude '*.tsbuildinfo' --exclude .git --exclude .vscode-test \
  --exclude /test-results/ --exclude /packages/extension/servers/ --exclude /packages/extension/host/ /src/ /work/
ln -sfn /cache/vscode-test /work/.vscode-test
cd /work
corepack enable
corepack prepare "$(node -p "require('./package.json').packageManager")" --activate
export REFYNTRA_HOST_PATH=/work/src/dotnet/Refyntra.Host/bin/Release/net10.0/Refyntra.Host.dll

step "build"
pnpm install --frozen-lockfile || exit 1
pnpm -r run build || exit 1
dotnet build src/dotnet/Refyntra.Host/Refyntra.Host.csproj -c Release || exit 1

step "screenshots (VS Code $REFYNTRA_TEST_VSCODE_VERSION, Xvfb 1600x1000x24)"
rm -rf /out/actual /out/diff /out/report.html
export REFYNTRA_VISUAL_OUT=/out/actual
display_start 1600x1000x24
xrun -s "-screen 0 1600x1000x24 -dpi 96 -nolisten tcp" -- timeout 2400 pnpm --filter refyntra run test:visual
shots=$?
pkill -f 'Refyntra\.Host|Workspaces\.MSBuild\.BuildHost' 2>/dev/null

step "compare"
if [ "$REFYNTRA_VISUAL_UPDATE" = 1 ]; then
  node scripts/test/visual-compare.mjs --actual /out/actual --baselines /baselines --out /out --masks /work/tests/visual/masks.json --update
else
  node scripts/test/visual-compare.mjs --actual /out/actual --baselines /baselines --out /out --masks /work/tests/visual/masks.json
fi
cmp=$?
[ $shots = 0 ] || echo "The screenshot run failed ($shots)"
[ $shots = 0 ] && [ $cmp = 0 ]
