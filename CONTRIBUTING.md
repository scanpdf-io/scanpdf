# Contributing to ScanPDF

Thanks for your interest in contributing! ScanPDF is intentionally small and
dependency-light, and contributions should keep it that way.

## Development setup

There is no build step — the app is plain HTML, CSS, and vanilla ES modules.

```sh
# Option 1: no Docker (downloads the two vendor libraries once)
make serve
# open http://localhost:8080

# Option 2: full container, same as production
make run
```

Run the smoke tests before opening a pull request:

```sh
make test
```

## Project conventions

- Vanilla JavaScript ES modules only — no frameworks, no bundler, no npm.
- All processing must stay client-side. Never add code that sends user
  images or data anywhere.
- Changes must work under the strict Content-Security-Policy served by the
  container (see `nginx.conf`): no inline styles, no inline scripts, no
  external origins.
- Match the existing code style and comment density.

## Updating vendor libraries

OpenCV.js and pdf-lib are pinned by URL and SHA-256. To bump a version:

1. Update the URL in both `Dockerfile` and `tools/vendor.sh`.
2. Update the corresponding hash in `vendor-checksums.txt`
   (`sha256sum <file>` on the freshly downloaded file).
3. Run `make test` and verify detection and export still work in the browser.

## Pull requests

- Keep PRs focused — one change per PR.
- Describe what changed and why, and note how you tested it.
- For behavior changes, include before/after details (or screenshots).
