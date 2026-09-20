// Small non-blocking notifications, stacked in #toasts. Errors are announced
// assertively and stay until dismissed; everything else fades on its own.

import { t } from './i18n.js';
import { icon } from './icons.js';

const TIMEOUT = 4500;

/**
 * toast('Saved', { type: 'ok' })
 * type: 'info' | 'ok' | 'error' | 'busy' (spinner, stays until updated/closed)
 * Returns { update(message, opts), close() }.
 */
export function toast(message, opts = {}) {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  let timer = 0;

  function close() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }

  function update(text, { type = 'info', sticky = type === 'error' || type === 'busy' } = {}) {
    clearTimeout(timer);
    el.className = `toast ${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = '';
    if (type === 'busy') {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      el.appendChild(spin);
    } else if (type === 'error') {
      el.appendChild(icon('alert'));
    } else if (type === 'ok') {
      el.appendChild(icon('check'));
    }
    msg.textContent = text;
    el.appendChild(msg);
    if (type !== 'busy') {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'toast-close';
      x.title = t('dismiss');
      x.setAttribute('aria-label', t('dismiss'));
      x.appendChild(icon('x'));
      x.addEventListener('click', close);
      el.appendChild(x);
    }
    if (!sticky) timer = setTimeout(close, TIMEOUT);
  }

  update(message, opts);
  host.appendChild(el);
  return { update, close };
}

/** Say something to screen readers only (the #announcer live region). */
export function announce(text) {
  const el = document.getElementById('announcer');
  if (!el) return;
  el.textContent = '';
  // A fresh text node after a tick is what makes the same sentence re-announce.
  setTimeout(() => (el.textContent = text), 50);
}
