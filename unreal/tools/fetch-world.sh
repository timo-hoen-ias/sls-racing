#!/usr/bin/env bash
# Downloads the newest Unreal export (ue-tiles-*.tar from the world-tiles release, built by the World build
# action) into unreal/SlsRacing/WorldData. Needs the GitHub CLI, logged in (gh auth login).
set -euo pipefail
cd "$(dirname "$0")/../.."
name=$(gh api repos/timo-hoen-ias/sls-racing/releases/tags/world-tiles -q '[.assets[] | select(.name | startswith("ue-tiles-"))] | sort_by(.created_at) | last | .name')
[ -n "$name" ] || { echo "Noch kein Unreal-Export veröffentlicht"; exit 1; }
echo "Lade $name …"
gh release download world-tiles -R timo-hoen-ias/sls-racing -p "$name" -O /tmp/sls-ue-tiles.tar --clobber
rm -rf unreal/SlsRacing/WorldData
tar -xf /tmp/sls-ue-tiles.tar -C unreal/SlsRacing
rm /tmp/sls-ue-tiles.tar
echo "Fertig: unreal/SlsRacing/WorldData ($(ls unreal/SlsRacing/WorldData/t | wc -l) Kacheln)"
