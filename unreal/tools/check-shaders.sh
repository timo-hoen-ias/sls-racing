#!/usr/bin/env bash
# Compiles the Unreal surface shaders (unreal/SlsRacing/Shaders) with Microsoft's DXC to DXIL and SPIR-V (Vulkan,
# what Unreal uses on Linux) through unreal/tools/shader-check.hlsl, so HLSL errors show up without an engine.
#   DXC=/path/to/dxc unreal/tools/check-shaders.sh
# DXC: https://github.com/microsoft/DirectXShaderCompiler/releases (Linux tarball: bin/dxc, lib/ on LD_LIBRARY_PATH).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DXC="${DXC:-dxc}"
command -v "$DXC" >/dev/null || { echo "dxc nicht gefunden (DXC=<Pfad> setzen)"; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Unreal's virtual path /SlsRacing/… becomes a relative include here.
for f in "$REPO"/unreal/SlsRacing/Shaders/*.ush "$REPO/unreal/tools/shader-check.hlsl"; do
  sed 's|#include "/SlsRacing/|#include "|' "$f" > "$WORK/$(basename "$f")"
done
"$DXC" -T ps_6_0 -E main -WX -Wno-conversion "$WORK/shader-check.hlsl" -Fo "$WORK/out.dxil"
"$DXC" -T ps_6_0 -E main -spirv -WX -Wno-conversion "$WORK/shader-check.hlsl" -Fo "$WORK/out.spv"
echo "Shader ok (DXIL + SPIR-V)"
