// Page side of the Web Share Target. The service worker parks the photos
// shared from another app in Cache Storage and redirects to the scanner with
// ?share-target=<count>; this module turns them back into Files and deletes
// the parked copies.

// Must match SHARE_CACHE in templates/sw.js.
const SHARE_CACHE = 'scanpdf:' + new URL('../', import.meta.url).pathname + ':share';

// Android sometimes shares files without a MIME type, and intake only accepts
// image/*.
const TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
};

// Resolves to null on a normal launch, otherwise to { files, failed }.
export async function takeSharedFiles() {
  const status = new URLSearchParams(location.search).get('share-target');
  if (status === null) {
    // A share that was never picked up (the tab was closed mid-redirect).
    if ('caches' in window) caches.delete(SHARE_CACHE).catch(() => {});
    return null;
  }
  // A reload must not look like a second share.
  history.replaceState(null, '', location.pathname + location.hash);
  if (status === 'failed' || !('caches' in window)) return { files: [], failed: true };

  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = (await cache.keys()).sort((a, b) => (a.url < b.url ? -1 : 1));
    const files = [];
    for (const key of keys) {
      const res = await cache.match(key);
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared');
      const type = blob.type.startsWith('image/')
        ? blob.type
        : TYPES[name.split('.').pop().toLowerCase()] || blob.type;
      files.push(new File([blob], name, { type }));
    }
    return { files, failed: false };
  } catch (err) {
    console.error('Could not read the shared files', err);
    return { files: [], failed: true };
  } finally {
    await caches.delete(SHARE_CACHE).catch(() => {});
  }
}
