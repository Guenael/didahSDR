#!/usr/bin/env bash
# Vendors onnxruntime-web (MIT) into app/lib for the CW decoder worker. No npm needed.
# Usage: scripts/fetch_ort.sh [version]   (default: the version pinned below)
# The tarball is checked against a pinned sha512 (default version) or the registry's published
# integrity (any other version). Needs bash, curl, tar and python3.
set -euo pipefail
PINNED_VERSION="1.30.0"
PINNED_INTEGRITY="sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ=="

VERSION="${1:-$PINNED_VERSION}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/app/lib"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$VERSION" = "$PINNED_VERSION" ]; then
    WANT="$PINNED_INTEGRITY"
else
    WANT="$(curl -fsSL "https://registry.npmjs.org/onnxruntime-web/${VERSION}" \
        | python3 -c 'import json, sys; print(json.load(sys.stdin)["dist"]["integrity"])')"
fi

curl -fsSL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${VERSION}.tgz" -o "$TMP/ort.tgz"
GOT="sha512-$(python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())' "$TMP/ort.tgz")"
if [ "$GOT" != "$WANT" ]; then
    echo "onnxruntime-web ${VERSION}: integrity mismatch" >&2
    echo "  want $WANT" >&2
    echo "  got  $GOT" >&2
    exit 1
fi

tar xzf "$TMP/ort.tgz" -C "$TMP"
mkdir -p "$DEST"
cp "$TMP/package/dist/ort.wasm.min.js" "$TMP/package/dist/ort-wasm-simd-threaded.mjs" \
   "$TMP/package/dist/ort-wasm-simd-threaded.wasm" "$DEST/"
cp "$TMP/package/LICENSE"* "$DEST/LICENSE.onnxruntime-web" 2>/dev/null || cp "$TMP/package/README.md" "$DEST/README.onnxruntime-web.md"
echo "$VERSION" > "$DEST/ORT_VERSION"
ls -la "$DEST"
