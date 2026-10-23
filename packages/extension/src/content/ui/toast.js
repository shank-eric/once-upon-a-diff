/*
 * A short message at the bottom right of GitHub's page, gone after 5s. Our
 * own element in its own shadow root, so GitHub's CSS can't reach it.
 */
import { hideUntilStyled, stylesheetLink } from '@once-upon-a-diff/shared/util/dom';

const TOAST_MS = 5000;
const TOAST_CSS_URL = chrome.runtime.getURL('content/ui/toast.css');

export function toast(text) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'open' });
  const link = stylesheetLink(TOAST_CSS_URL);
  const message = document.createElement('div');
  message.className = 't';
  message.textContent = text;
  message.setAttribute('role', 'status');
  shadow.append(link, message);
  hideUntilStyled(host, [link]);
  document.body.appendChild(host);
  setTimeout(() => host.remove(), TOAST_MS);
}
