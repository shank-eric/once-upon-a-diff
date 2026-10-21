/*
 * A short message at the bottom right of GitHub's page, gone after 5s.
 */

const TOAST_MS = 5000;

export function toast(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText =
    'position:fixed;right:16px;bottom:16px;z-index:100;max-width:360px;padding:8px 12px;border-radius:6px;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'background:var(--bgColor-emphasis,#25292e);color:var(--fgColor-onEmphasis,#fff);box-shadow:0 4px 12px rgba(0,0,0,.2)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), TOAST_MS);
}
