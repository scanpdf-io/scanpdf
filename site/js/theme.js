// Theme switching: system (default), light or dark. With no script the page
// already follows the OS through prefers-color-scheme in tokens.css; this adds
// the forced choice, kept in localStorage and applied as data-theme on <html>.
//
// Loaded as a plain blocking script from <head> so a forced theme is in place
// before the first paint. It cannot be inline: the container's CSP is
// script-src 'self'.

(function () {
  var KEY = 'scanpdf-theme';
  var MODES = ['system', 'light', 'dark'];
  var root = document.documentElement;

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function store(mode) {
    try {
      if (mode === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch (e) {
      // Storage blocked: the choice still holds for this page view.
    }
  }

  function setAttr(mode) {
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  }

  var mode = stored();
  setAttr(mode);

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.querySelector('.theme-toggle');
    var metas = Array.prototype.slice.call(document.querySelectorAll('meta[name="theme-color"]'));
    var metaDefaults = metas.map(function (meta) { return meta.content; });

    // The theme-color metas are media-scoped to the OS scheme, so a forced
    // theme has to overwrite both with the page background actually in use.
    function syncMeta() {
      var bg = mode === 'system' ? '' : getComputedStyle(root).getPropertyValue('--bg').trim();
      metas.forEach(function (meta, i) { meta.content = bg || metaDefaults[i]; });
    }

    function syncButton() {
      if (!button) return;
      var label = button.getAttribute('data-label-' + mode);
      button.setAttribute('aria-label', label);
      button.title = label;
    }

    function apply(next) {
      mode = next;
      setAttr(mode);
      syncMeta();
      syncButton();
    }

    apply(mode);

    if (button) {
      button.hidden = false;
      button.addEventListener('click', function () {
        var next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
        store(next);
        apply(next);
      });
    }

    // Keep other open tabs in step.
    window.addEventListener('storage', function (event) {
      if (event.key === KEY || event.key === null) apply(stored());
    });
  });
})();
