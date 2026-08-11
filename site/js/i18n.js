// UI strings for the JS modules. The page is generated per locale by
// tools/build-i18n.py, which emits them as data-* attributes on #i18n.
//
// They travel as attributes rather than an inline <script> because the
// container's Content-Security-Policy is script-src 'self': an inline script
// would be blocked. Reading a dataset is also synchronous, so no module has
// to wait for a fetch before it can render.

const strings = document.getElementById('i18n')?.dataset ?? {};

/**
 * Look up a string by its camelCase key, replacing {placeholders}.
 * Falls back to the key itself so a missing translation is visible rather
 * than silently blank.
 */
export function t(key, params) {
  const value = strings[key] ?? key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}
