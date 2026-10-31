#!/usr/bin/env bash
# Downloads the newest complete Unreal export (ue-tiles-<ukey>-<part>.tar from the world-tiles release, built
# by the World build action in parts) into unreal/SlsRacing/WorldData. Needs the GitHub CLI (gh auth login).
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO=timo-hoen-ias/sls-racing
PARTS=${SHARDS:-3}
names=$(gh api "repos/$REPO/releases/tags/world-tiles" -q '[.assets[] | select(.name | test("^ue-tiles-.*-[0-9]+\\.tar$"))] | sort_by(.created_at) | reverse | .[].name')
ukey=""
for n in $names; do
  k=$(echo "$n" | sed -E 's/^ue-tiles-(.*)-[0-9]+\.tar$/\1/')
  [ "$(echo "$names" | grep -c "^ue-tiles-$k-[0-9]*\.tar$")" -ge "$PARTS" ] && { ukey=$k; break; }
done
[ -n "$ukey" ] || { echo "Noch kein vollständiger Unreal-Export veröffentlicht"; exit 1; }
rm -rf unreal/SlsRacing/WorldData
for ((i = 0; i < PARTS; i++)); do
  echo "Lade ue-tiles-$ukey-$i.tar …"
  gh release download world-tiles -R "$REPO" -p "ue-tiles-$ukey-$i.tar" -O /tmp/sls-ue-part.tar --clobber
  tar -xf /tmp/sls-ue-part.tar -C unreal/SlsRacing
  rm /tmp/sls-ue-part.tar
done
echo "Fertig: unreal/SlsRacing/WorldData ($(ls unreal/SlsRacing/WorldData/t | wc -l) Kacheln, Export $ukey)"
