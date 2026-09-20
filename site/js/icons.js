// Icons live in the <symbol> sprite at the top of the page (templates/app.html).

const SVG_NS = 'http://www.w3.org/2000/svg';

/** <svg class="ico"><use href="#i-name"></svg> */
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

let overlay;

/** Colours for things drawn on top of photos: the --overlay-* tokens. */
export function overlayColors() {
  if (overlay) return overlay;
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(`--overlay-${name}`).trim();
  overlay = {
    accent: get('accent'),
    accentSoft: get('accent-soft'),
    warn: get('warn'),
    dim: get('dim'),
    handle: get('handle'),
  };
  return overlay;
}
