#!/usr/bin/env bash
# Vendors onnxruntime-web (MIT) into app/lib for the CW decoder worker. No npm needed.
# Usage: scripts/fetch_ort.sh [version]   (default: the version pinned below)
set -euo pipefail
VERSION="${1:-1.30.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/app/lib"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sSL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${VERSION}.tgz" -o "$TMP/ort.tgz"
tar xzf "$TMP/ort.tgz" -C "$TMP"
mkdir -p "$DEST"
cp "$TMP/package/dist/ort.wasm.min.js" "$TMP/package/dist/ort-wasm-simd-threaded.mjs" \
   "$TMP/package/dist/ort-wasm-simd-threaded.wasm" "$DEST/"
cp "$TMP/package/LICENSE"* "$DEST/LICENSE.onnxruntime-web" 2>/dev/null || cp "$TMP/package/README.md" "$DEST/README.onnxruntime-web.md"
echo "$VERSION" > "$DEST/ORT_VERSION"
ls -la "$DEST"
