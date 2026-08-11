#!/bin/sh
# Downloads the pinned third-party libraries into site/vendor/ for local
# development without Docker. Verifies sha256 against vendor-checksums.txt.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/site/vendor"
mkdir -p "$DEST"

curl -fsSL -o "$DEST/opencv.js" https://docs.opencv.org/4.9.0/opencv.js
curl -fsSL -o "$DEST/pdf-lib.min.js" https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js

cd "$DEST"
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$ROOT/vendor-checksums.txt"
else
    shasum -a 256 -c "$ROOT/vendor-checksums.txt"
fi
echo "Vendored libraries are ready in site/vendor/"
