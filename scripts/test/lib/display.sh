# Sourced by linux-e2e.sh and linux-visual.sh. Two halves:
#   vnc_docker_args          (host side)  adds the localhost-only port mappings and env when REFYNTRA_VNC=1 or --vnc
#   display_start / xrun     (container)  without VNC: xvfb-run -a per command (default, unchanged);
#                                         with VNC: one fixed Xvfb :99 + x11vnc (view-only) + noVNC for the whole run.
# x11vnc, novnc and websockify live in the test image only (never in the VSIX).

VNC_DISPLAY=:99

# Host side: echo the extra `docker run` arguments. Ports are bound to 127.0.0.1 only.
vnc_docker_args() {
  if [ "${REFYNTRA_VNC:-0}" = 1 ]; then
    printf '%s\n' -p 127.0.0.1:5900:5900 -p 127.0.0.1:6080:6080 -e REFYNTRA_VNC=1 -e "REFYNTRA_VNC_PAUSE_MS=${REFYNTRA_VNC_PAUSE_MS:-0}"
  fi
}

vnc_note() {
  [ "${REFYNTRA_VNC:-0}" = 1 ] || return 0
  cat <<NOTE

==== VNC watch mode ====
Browser: http://localhost:6080/vnc.html?autoconnect=1&view_only=1
VNC:     localhost:5900 (any VNC viewer)
View-only, no password: the ports listen on 127.0.0.1 only. The display appears once the container has built (minutes).
REFYNTRA_VNC_PAUSE_MS=${REFYNTRA_VNC_PAUSE_MS:-0} pauses after each test case.
NOTE
}

# Container side. $1 = Xvfb screen spec (default 1600x1000x24).
display_start() {
  [ "${REFYNTRA_VNC:-0}" = 1 ] || return 0
  local screen="${1:-1600x1000x24}"
  Xvfb "$VNC_DISPLAY" -screen 0 "$screen" -dpi 96 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 50); do xdpyinfo -display "$VNC_DISPLAY" >/dev/null 2>&1 && break; sleep 0.2; done
  export DISPLAY="$VNC_DISPLAY"
  x11vnc -display "$VNC_DISPLAY" -viewonly -forever -shared -nopw -rfbport 5900 -quiet -bg -o /tmp/x11vnc.log >/dev/null 2>&1
  websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
  echo "VNC: display $VNC_DISPLAY is served on port 5900 and http://localhost:6080/vnc.html (view-only)"
}

# xrun [xvfb-run server args] -- command...: runs the command on a display.
xrun() {
  local sargs=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do sargs+=("$1"); shift; done
  shift
  if [ "${REFYNTRA_VNC:-0}" = 1 ]; then "$@"; else xvfb-run -a ${sargs[@]+"${sargs[@]}"} "$@"; fi
}
