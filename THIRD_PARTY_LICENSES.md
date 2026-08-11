# Third-party licenses

ScanPDF's own code is released under the [MIT License](LICENSE). At runtime it
loads two third-party libraries. They are **not committed to this repository** —
they are fetched (and SHA-256 verified against
[vendor-checksums.txt](vendor-checksums.txt)) at build/deploy time by
[tools/vendor.sh](tools/vendor.sh) and the [Dockerfile](Dockerfile).

When they are redistributed — inside a release bundle (`scanpdf-<version>.zip`)
or a published container image (`ghcr.io/scanpdf-io/scanpdf`) — they remain under
their original licenses, reproduced/pointed to below.

| Library | Version | License | Source |
|---------|---------|---------|--------|
| OpenCV.js | 4.9.0 | Apache License 2.0 | https://docs.opencv.org/4.9.0/opencv.js |
| pdf-lib | 1.17.1 | MIT | https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js |

## OpenCV.js — Apache License 2.0

OpenCV is licensed under the Apache License, Version 2.0. You may obtain a copy
of the License at https://www.apache.org/licenses/LICENSE-2.0 and the project's
license at https://github.com/opencv/opencv/blob/4.9.0/LICENSE. Unless required
by applicable law or agreed to in writing, the software is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied.

## pdf-lib — MIT License

pdf-lib is licensed under the MIT License. See
https://github.com/Hopding/pdf-lib/blob/master/LICENSE.md for the full text.
