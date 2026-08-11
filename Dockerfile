# Stage 1: fetch pinned third-party libraries (the only step that needs
# network access; the running container is fully offline).
FROM alpine:3.24 AS vendor
RUN apk add --no-cache curl
WORKDIR /vendor
COPY vendor-checksums.txt .
RUN curl -fsSL -o opencv.js https://docs.opencv.org/4.9.0/opencv.js && \
    curl -fsSL -o pdf-lib.min.js https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js && \
    sha256sum -c vendor-checksums.txt

# Stage 2: static file server.
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY site/ /usr/share/nginx/html/
COPY --from=vendor /vendor/opencv.js /vendor/pdf-lib.min.js /usr/share/nginx/html/vendor/
