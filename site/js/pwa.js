// PWA plumbing shared by every page: service worker registration, the update
// hand-over and the install button. No imports on purpose - the reading pages
// have neither the toast host nor the #i18n strings.

// Both are read before main.js (the next script) cleans the share URL and
// before any worker can claim this page.
const hadController = !!navigator.serviceWorker?.controller;
const shareLaunch = new URLSearchParams(location.search).has('share-target');

// A reload is free on a reading page and on a scanner with no pages yet.
// Pages live in memory only, so never reload under a session in progress.
const nothingToLose = () =>
  !shareLaunch &&
  (!document.body.classList.contains('app') || document.body.classList.contains('is-empty'));

if ('serviceWorker' in navigator) {
  // Relative to this module, not to the page: the localized pages live one
  // or two directories below the site root. The scope defaults to that root.
  navigator.serviceWorker
    .register(new URL('../sw.js', import.meta.url), { updateViaCache: 'none' })
    .then(watchForUpdates, (err) => console.error('Service worker registration failed', err));

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first worker claiming a fresh page is not an update.
    if (!hadController || reloaded || !nothingToLose()) return;
    reloaded = true;
    location.reload();
  });

  setupInstallButton();
}

// sw.js does not skipWaiting() by itself: the assets are not fingerprinted,
// so a worker swap under a live page would mix two releases. Without this
// hand-over, though, a single tab that only ever reloads would never update.
function watchForUpdates(reg) {
  const promote = () => {
    if (reg.waiting && hadController && nothingToLose()) {
      reg.waiting.postMessage({ type: 'skip-waiting' });
    }
  };
  const track = (next) => {
    next?.addEventListener('statechange', () => {
      if (next.state === 'installed') promote();
    });
  };
  promote();
  // The update check of this page load may already be under way.
  track(reg.installing);
  reg.addEventListener('updatefound', () => track(reg.installing));
}

// Chromium only. Safari has no install prompt (Share -> Add to Home Screen),
// so the button simply stays hidden there.
function setupInstallButton() {
  const button = document.getElementById('install-btn');
  if (!button) return;
  let deferred = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    // An installed app without a worker would POST shared photos to the host.
    navigator.serviceWorker.ready.then(() => {
      if (deferred) button.hidden = false;
    });
  });
  button.addEventListener('click', async () => {
    if (!deferred) return;
    const prompt = deferred;
    deferred = null;
    button.hidden = true;
    await prompt.prompt();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
  });
}
