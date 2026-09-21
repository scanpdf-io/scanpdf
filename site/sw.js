// Service worker: offline app shell, the on-demand scan engine cache and the
// Web Share Target receiver.
//
// GENERATED into site/sw.js by tools/build-i18n.py - edit templates/sw.js.
//
// The site has no fingerprinted assets, so the shell is cached as one
// versioned snapshot: VERSION is a hash over every precached file, and a page
// is always served HTML, CSS and JS from the same snapshot.

const VERSION = 'ce615449b836';
const ENGINE_VERSION = 'f5ebc33a9bb0';
const PRECACHE = [
  "./",
  "404.html",
  "css/app.css",
  "css/base.css",
  "css/content.css",
  "css/tokens.css",
  "de/",
  "de/dokumente-scannen/",
  "de/haeufige-fragen/",
  "de/manifest.webmanifest",
  "de/scannen-ohne-hochladen/",
  "es/",
  "es/como-escanear-documentos/",
  "es/escanear-sin-subir-archivos/",
  "es/manifest.webmanifest",
  "es/preguntas-frecuentes/",
  "faq/",
  "favicon.svg",
  "fr/",
  "fr/comment-numeriser-un-document/",
  "fr/manifest.webmanifest",
  "fr/numeriser-sans-envoi/",
  "fr/questions-frequentes/",
  "hi/",
  "hi/aksar-puche-jane-wale-sawal/",
  "hi/bina-upload-scan/",
  "hi/dastavez-scan-kaise-karen/",
  "hi/manifest.webmanifest",
  "how-to-scan-documents/",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-256.png",
  "icons/icon-512.png",
  "id/",
  "id/cara-memindai-dokumen/",
  "id/manifest.webmanifest",
  "id/pertanyaan-umum/",
  "id/pindai-tanpa-mengunggah/",
  "it/",
  "it/come-scansionare-documenti/",
  "it/domande-frequenti/",
  "it/manifest.webmanifest",
  "it/scansionare-senza-caricare/",
  "js/cv-loader.js",
  "js/detect.js",
  "js/editor.js",
  "js/export.js",
  "js/filters.js",
  "js/format.js",
  "js/formats.js",
  "js/i18n.js",
  "js/icons.js",
  "js/main.js",
  "js/menus.js",
  "js/pages-ui.js",
  "js/pwa.js",
  "js/reorder.js",
  "js/share-target.js",
  "js/split.js",
  "js/state.js",
  "js/theme.js",
  "js/toast.js",
  "js/warp.js",
  "manifest.webmanifest",
  "pt/",
  "pt/como-digitalizar-documentos/",
  "pt/digitalizar-sem-enviar/",
  "pt/manifest.webmanifest",
  "pt/perguntas-frequentes/",
  "scan-without-uploading/",
  "tr/",
  "tr/belge-nasil-taranir/",
  "tr/manifest.webmanifest",
  "tr/sik-sorulan-sorular/",
  "tr/yuklemeden-tarama/"
];
// Not part of the shell: opencv.js is ~10MB and only scanning needs it, so it
// is cached when it is first used or when the app gets installed (main.js).
// Keyed by vendor-checksums.txt, it survives shell updates.
const ENGINE = ['vendor/opencv.js', 'vendor/pdf-lib.min.js'];

// Everything is resolved against the registration scope, never "/": the
// bundle has to keep working from a sub-path. The scope path is also part of
// the cache names, since Cache Storage is shared by the whole origin.
const SCOPE = self.registration.scope;
const PREFIX = 'scanpdf:' + new URL(SCOPE).pathname + ':';
const SHELL_CACHE = PREFIX + 'shell-' + VERSION;
const ENGINE_CACHE = PREFIX + 'engine-' + ENGINE_VERSION;
const SHARE_CACHE = PREFIX + 'share'; // must match js/share-target.js

const abs = (rel) => new URL(rel, SCOPE).href;

// A response that went through a redirect cannot answer a navigation.
const plain = async (res) =>
  res.redirected
    ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
    : res;

/* ---------- Lifecycle ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      precache(),
      // Export needs pdf-lib on every scanner page. Best effort: a checkout
      // without `make vendor` must still be able to install.
      engineFile('vendor/pdf-lib.min.js').catch(() => {}),
    ]),
  );
});

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    PRECACHE.map(async (rel) => {
      // 'reload' skips the HTTP cache, which could hold a file from the
      // previous version.
      const res = await fetch(new Request(abs(rel), { cache: 'reload' }));
      if (!res.ok) throw new Error(`precache ${rel}: ${res.status}`);
      await cache.put(abs(rel), await plain(res));
    }),
  );
}

// No skipWaiting() here: taking over a live page would mix two snapshots.
// js/pwa.js asks for it when the page has nothing to lose (see 'message').
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        const mine = key.startsWith(PREFIX + 'shell-') || key.startsWith(PREFIX + 'engine-');
        if (mine && key !== SHELL_CACHE && key !== ENGINE_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/* ---------- Fetch ---------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req.url.startsWith(SCOPE)) return;
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  const rel = url.href.slice(SCOPE.length).split(/[?#]/)[0];
  event.respondWith(ENGINE.includes(rel) ? engineFile(rel) : fromShell(req, url));
});

async function fromShell(req, url) {
  // Never the global caches.match(): while an update waits, the next
  // snapshot's cache already exists next to this one.
  const cache = await caches.open(SHELL_CACHE);
  const opts = { ignoreSearch: true, ignoreVary: true };
  const hit = await cache.match(req, opts);
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch (err) {
    if (req.mode !== 'navigate') throw err;
    // Offline: "/faq" is cached as "/faq/" - redirect like the server would,
    // or the page's relative links break. Anything else is a 404.
    const dir = url.origin + url.pathname + '/';
    if (!url.pathname.endsWith('/') && (await cache.match(dir, opts))) {
      return Response.redirect(dir + url.search, 301);
    }
    const notFound = await cache.match(abs('404.html'));
    if (!notFound) throw err;
    return new Response(await notFound.blob(), { status: 404, headers: notFound.headers });
  }
}

const inflight = new Map();

// Cache-first. Concurrent requests for the same file share one download.
function engineFile(rel) {
  if (!inflight.has(rel)) {
    inflight.set(
      rel,
      (async () => {
        const cache = await caches.open(ENGINE_CACHE);
        const hit = await cache.match(abs(rel));
        if (hit) return hit;
        // vendor/ is served with a one-year lifetime and no fingerprint:
        // 'no-cache' revalidates, so a stale copy cannot end up stored under
        // a new ENGINE_VERSION.
        const res = await fetch(abs(rel), { cache: 'no-cache' });
        if (!res.ok) return res;
        await cache.put(abs(rel), res.clone());
        announceIfComplete(cache);
        return res;
      })().finally(() => inflight.delete(rel)),
    );
  }
  return inflight.get(rel).then((res) => res.clone());
}

async function announceIfComplete(cache) {
  for (const rel of ENGINE) if (!(await cache.match(abs(rel)))) return;
  for (const client of await self.clients.matchAll({ type: 'window' })) {
    client.postMessage({ type: 'engine-cached' });
  }
}

/* ---------- Web Share Target ---------- */

// The manifests declare "./share-target" as a multipart POST target. There is
// no server behind it: the photos are parked in Cache Storage and the locale's
// scanner page picks them up (js/share-target.js) and deletes them.
async function receiveShare(request) {
  // Relative to the request, not to this script: /es/share-target -> /es/
  const home = new URL('./', request.url);
  try {
    const form = await request.formData();
    const files = form.getAll('images').filter((f) => f instanceof File);
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(
      files.map((file, i) =>
        cache.put(
          abs('share-target/' + String(i).padStart(4, '0')),
          new Response(file, {
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name || `shared-${i + 1}`),
            },
          }),
        ),
      ),
    );
    home.search = '?share-target=' + files.length;
  } catch (err) {
    // Most likely the storage quota.
    await caches.delete(SHARE_CACHE).catch(() => {});
    home.search = '?share-target=failed';
  }
  return Response.redirect(home.href, 303);
}

/* ---------- Messages from the pages ---------- */

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'cache-engine') {
    event.waitUntil(Promise.all(ENGINE.map((rel) => engineFile(rel))).catch(() => {}));
  }
  if (type === 'skip-waiting') {
    event.waitUntil(
      (async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const others = windows.filter((c) => c.id !== event.source.id && c.url.startsWith(SCOPE));
        if (!others.length) await self.skipWaiting();
      })(),
    );
  }
});
