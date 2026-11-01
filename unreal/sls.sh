#!/usr/bin/env bash
# SLS Racing UE5 port: one entry point for world data, build, tests and play (like going-vertical's gv.sh).
#   ./unreal/sls.sh world     newest exported world from the World-Build action → unreal/SlsRacing/WorldData (gh auth login)
#   ./unreal/sls.sh setup     textures from the web game + C++ build + content (materials via Content/Python/sls_setup.py)
#   ./unreal/sls.sh build     C++ build (editor target, Development)
#   ./unreal/sls.sh parity    headless drivability check of the whole world (road.parity all max=0), exit code
#   ./unreal/sls.sh check     headless absolute road check (road.check all: holes, bumps, steps, snags, gaps, edges against
#                             the drawn surface, no web reference) → Saved/road-check.json, exit code; extra args go to road.check
#   ./unreal/sls.sh bench     headless car check against the web car (car.bench fun + real), exit code
#   ./unreal/sls.sh play      game window (no cooking needed)
#   ./unreal/sls.sh editor    open the project in the editor
# UE_ROOT points at the engine (default /opt/unreal-engine from the AUR, else /opt/unreal-engine-bin/<newest>, else ~/UnrealEngine).
set -euo pipefail
if [ -n "${UE_ROOT:-}" ]; then UE="$UE_ROOT"
elif [ -x /opt/unreal-engine/Engine/Binaries/Linux/UnrealEditor ]; then UE=/opt/unreal-engine
elif BIN="$(ls -d /opt/unreal-engine-bin/*/Engine/Binaries/Linux/UnrealEditor 2>/dev/null | sort -V | tail -1)" && [ -n "$BIN" ]; then
  UE="${BIN%/Engine/Binaries/Linux/UnrealEditor}"
else UE="$HOME/UnrealEngine"; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJ="$HERE/SlsRacing/SlsRacing.uproject"
EDITOR="$UE/Engine/Binaries/Linux/UnrealEditor"
SAVED="$HERE/SlsRacing/Saved"

need_engine() { [ -x "$EDITOR" ] || { echo "UnrealEditor not found under $UE (set UE_ROOT)"; exit 1; }; }
fetch_world() { (cd "$HERE/.." && ./unreal/tools/fetch-world.sh); }
need_world() { [ -f "$HERE/SlsRacing/WorldData/index.json" ] || fetch_world; }
build() { need_engine; "$UE/Engine/Build/BatchFiles/Linux/Build.sh" SlsRacingEditor Linux Development -Project="$PROJ" -WaitMutex; }
headless() { need_engine; need_world; "$EDITOR" "$PROJ" -game -nullrhi -unattended -nosound -nosplash -log -ExecCmds="$1"; }

setup() {
  (cd "$HERE/.." && node unreal/tools/export-textures.ts && node unreal/tools/export-vegetation.ts)
  build
  # like going-vertical: the editor can hang in its exit after the script; end it a minute after the done marker
  DONE="$SAVED/sls-setup-done"
  mkdir -p "$SAVED"; rm -f "$DONE"
  SLS_QUIT=1 SLS_DONE="$DONE" "$EDITOR" "$PROJ" -ExecutePythonScript="$HERE/SlsRacing/Content/Python/sls_setup.py" -nosplash -unattended -log &
  PID=$!
  WAITED=0
  while kill -0 "$PID" 2>/dev/null; do
    if [ -f "$DONE" ]; then
      WAITED=$((WAITED + 5))
      if [ "$WAITED" -ge 60 ]; then echo "setup fertig, Editor hängt beim Beenden: beende ihn"; kill -9 "$PID" 2>/dev/null || true; fi
    fi
    sleep 5
  done
  wait "$PID" 2>/dev/null || true
  [ -f "$DONE" ] || { echo "setup nicht fertig geworden (kein $DONE), siehe $SAVED/Logs"; exit 1; }
  echo "setup fertig"
}

case "${1:-play}" in
  world) fetch_world ;;
  setup) setup ;;
  build) build ;;
  parity)
    headless "road.parity all max=0 exit"
    echo "Ergebnis: $SAVED/road-parity.json"
    ;;
  check)
    shift
    headless "road.check all exit ${*:-max=0}"
    echo "Ergebnis: $SAVED/road-check.json"
    ;;
  bench)
    rc=0
    headless "car.bench fun exit" || rc=1; cp -f "$SAVED/car-bench.json" "$SAVED/car-bench-fun.json" 2>/dev/null || true
    headless "car.bench real exit" || rc=1; cp -f "$SAVED/car-bench.json" "$SAVED/car-bench-real.json" 2>/dev/null || true
    echo "Ergebnis: $SAVED/car-bench-fun.json, $SAVED/car-bench-real.json"
    exit $rc
    ;;
  play) need_engine; need_world; shift || true; "$EDITOR" "$PROJ" -game -windowed -ResX=1920 -ResY=1080 -log "$@" ;;
  editor) need_engine; "$EDITOR" "$PROJ" ;;
  *) echo "usage: $0 world|setup|build|parity|check|bench|play|editor"; exit 1 ;;
esac
