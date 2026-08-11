# ScanPDF

[![CI & Deploy](https://github.com/scanpdf-io/scanpdf/actions/workflows/ci.yml/badge.svg)](https://github.com/scanpdf-io/scanpdf/actions/workflows/ci.yml)
[![Container image](https://img.shields.io/badge/ghcr.io-scanpdf-2496ed?logo=docker&logoColor=white)](https://github.com/scanpdf-io/scanpdf/pkgs/container/scanpdf)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Turn photos of paper documents into clean, flatbed-scan-quality multi-page
PDFs — entirely in your browser. No accounts, no uploads, no server-side
processing: your documents never leave your machine.

**Live demo: [scanpdf.io](https://scanpdf.io)**

## Features

- **Automatic corner detection** — a multi-strategy OpenCV.js pipeline (Canny
  edges at two sensitivities, brightness and saturation masks, adaptive
  threshold, Hough-line intersections) finds the sheet in the photo and scores
  candidate quadrilaterals geometrically.
- **Precise manual adjustment** — drag corner handles with a magnifier loupe;
  live preview of the corrected result.
- **Perspective and scale correction** — pages come out flat and straight,
  sized to A4, Letter, or auto-fit at ~220 DPI.
- **Scan-style filters** — Color, Grayscale, and a Black & White mode that
  uses background division (not hard thresholding), so shadows are flattened,
  paper turns white, and text stays anti-aliased.
- **Multi-page PDF export** — reorder and delete pages, then save a single
  PDF assembled locally with pdf-lib.
- **EXIF-aware** — phone photo orientation is handled automatically.
- **Zero build system** — plain HTML, CSS, and vanilla ES modules.

## Usage

1. Drop photos of documents onto the page (or click **Add photos**).
2. Corners of each sheet are detected automatically; pages where detection
   failed are marked **adjust corners**.
3. In the editor, drag the corner handles (a loupe appears for precision),
   rotate pages, pick a filter, and reorder or delete pages in the left strip.
4. Choose the page size (A4 / Letter / Auto) and click **Save PDF**.

## Running it yourself

### Prebuilt container image (recommended)

Pull the published image from GitHub Container Registry — no build, no internet
needed at run time:

```sh
docker run -d --rm -p 8080:80 ghcr.io/scanpdf-io/scanpdf   # then open http://localhost:8080
```

The image ships the strict `Content-Security-Policy` from `nginx.conf`, so the
browser blocks every external request — this is the CSP-enforced offline path.
Tags follow semver (`:1.0.0`, `:1.0`, `:latest`) and cover `linux/amd64` and
`linux/arm64`.

Prefer plain static files? Each [release](https://github.com/scanpdf-io/scanpdf/releases)
also attaches `scanpdf-<version>.zip` — the full app with the pinned vendor
libraries baked in — for serving on any static file server (without the strict
CSP guarantee). Verify it with the accompanying `.sha256`.

### Docker (build locally)

```sh
make run      # build the image and start it
# open http://localhost:8080
make stop
```

The running container is fully offline: a strict `Content-Security-Policy`
served by nginx makes the browser block any request to an external origin.
Internet access is needed only once, during `make build`, to fetch the two
pinned libraries (SHA-256 verified).

### Without Docker

```sh
make serve    # downloads the vendor libraries once, then serves with python3
```

### Make targets

| Target        | What it does                                                    |
|---------------|-----------------------------------------------------------------|
| `make build`  | Build the Docker image (the only step that needs internet)      |
| `make run`    | Build + run at `http://localhost:8080` (override with `PORT=…`) |
| `make test`   | Run + smoke-check all endpoints and the CSP header              |
| `make stop`   | Stop the container                                              |
| `make logs`   | Follow nginx logs                                               |
| `make serve`  | Dev loop without Docker (python http.server; vendors libs once) |
| `make vendor` | Download libraries into `site/vendor/` for `make serve`         |

## Privacy

All image processing (OpenCV.js WASM) and PDF assembly (pdf-lib) happen in
your browser. The app makes no network requests with your data — there is no
backend at all.

- **Self-hosted container**: the offline guarantee is enforced by the
  browser itself via the nginx-served CSP (`default-src 'self'`).
- **Hosted demo ([scanpdf.io](https://scanpdf.io))**: the same code served
  from GitHub Pages. Processing is still fully client-side, but headers are
  controlled by GitHub Pages rather than the project's nginx config —
  self-host the container if you want the strict CSP enforcement.

## How it works

- Detection runs on a downscaled (≤1000 px) copy of the image; export warps
  the full-resolution original (capped at 3500 px on the long side, output at
  ≤2600 px ≈ 220 DPI on A4).
- Multiple detection strategies each propose sheet candidates; every
  quadrilateral is scored on area, convexity, and angle regularity, with an
  inward-refinement pass that handles curled paper edges.
- Export renders pages sequentially, embeds them as JPEG into the PDF, and
  sizes pages to the selected format.
- Dependencies are pinned by URL and SHA-256 in
  [vendor-checksums.txt](vendor-checksums.txt): OpenCV.js 4.9.0 and
  pdf-lib 1.17.1. They are fetched at build/deploy time and never committed.

## Project structure

```text
site/                 The whole app (static files)
├── index.html
├── css/app.css
├── js/
│   ├── main.js       Bootstrap, file intake, detection queue
│   ├── detect.js     Multi-strategy corner detection
│   ├── editor.js     Corner editor with loupe and live preview
│   ├── warp.js       Perspective warp and page sizing
│   ├── filters.js    Color / grayscale / B&W filters, rotation
│   ├── export.js     Multi-page PDF assembly
│   ├── pages-ui.js   Thumbnail strip
│   ├── state.js      App state and pub/sub
│   └── cv-loader.js  Lazy OpenCV.js loader
└── vendor/           OpenCV.js + pdf-lib (fetched at build, not committed)

Dockerfile            Two-stage build: fetch+verify libs, then nginx
nginx.conf            Static serving, gzip, strict CSP
tools/vendor.sh       Fetch libs locally for no-Docker development
.github/workflows/    Smoke-test → Pages deploy, plus tagged releases
```

## Deployment

Every push to `main` triggers the
[CI & Deploy workflow](.github/workflows/ci.yml). It first builds the container
and smoke-tests every endpoint plus the CSP header (`make test`); only if that
passes does it download the pinned vendor libraries, verify their checksums,
and publish `site/` to GitHub Pages, served at [scanpdf.io](https://scanpdf.io)
(`site/CNAME` pins the custom domain). Pull requests run the smoke test only —
a broken build can never reach the live site.

Self-hosted deployments are unaffected by the domain: every asset reference in
the app is relative, so it works from any origin and any sub-path.

Pushing a `v*` tag triggers the
[Release workflow](.github/workflows/release.yml): it attaches the offline
`scanpdf-<version>.zip` bundle to a GitHub Release and pushes a multi-arch
image to `ghcr.io/scanpdf-io/scanpdf` (tags `:x.y.z`, `:x.y`, `:latest`).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please
report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
