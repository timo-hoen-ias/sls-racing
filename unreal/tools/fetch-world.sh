#!/usr/bin/env bash
# Downloads the newest complete Unreal export (ue-tiles-<ukey>-<part>.tar from the world-tiles release, built
# by the World build action in parts) into unreal/SlsRacing/WorldData. Needs the GitHub CLI (gh auth login).
# The Landkreis is ~4 GB unpacked: SLS_WORLD_DIR=/var/tmp/sls-ue puts the data there and WorldData becomes a link
# to it; an existing WorldData link is kept and its target refilled. The same export is not downloaded twice.
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
LINK=unreal/SlsRacing/WorldData
if [ -n "${SLS_WORLD_DIR:-}" ]; then DEST="$SLS_WORLD_DIR/WorldData"
elif [ -L "$LINK" ]; then DEST="$(readlink -f "$LINK")"
else DEST="$LINK"; fi
if [ -f "$DEST/.ukey" ] && [ "$(cat "$DEST/.ukey")" = "$ukey" ]; then
  echo "Export $ukey ist schon da: $DEST"
else
  # parts unpack next to the target (tar entries start with WorldData/), so no extra copy on a full /home
  STAGE="$(dirname "$DEST")/.sls-ue-stage"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  for ((i = 0; i < PARTS; i++)); do
    echo "Lade ue-tiles-$ukey-$i.tar …"
    gh release download world-tiles -R "$REPO" -p "ue-tiles-$ukey-$i.tar" -O "$STAGE/part.tar" --clobber
    tar -xf "$STAGE/part.tar" -C "$STAGE"
    rm "$STAGE/part.tar"
  done
  echo "$ukey" > "$STAGE/WorldData/.ukey"
  rm -rf "$DEST"
  mv "$STAGE/WorldData" "$DEST"
  rm -rf "$STAGE"
fi
if [ "$(readlink -f "$DEST")" != "$(readlink -f "$LINK" 2>/dev/null || true)" ]; then rm -rf "$LINK"; ln -s "$(readlink -f "$DEST")" "$LINK"; fi
echo "Fertig: $LINK → $(readlink -f "$LINK") ($(ls "$LINK/t" | wc -l) Kacheln, Export $ukey)"
