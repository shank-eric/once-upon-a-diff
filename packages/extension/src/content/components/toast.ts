/*
 * A short message at the bottom right of GitHub's page, gone after 5s. Our
 * own element in its own shadow root, so GitHub's CSS can't reach it.
 */
import { mountShadow } from '@once-upon-a-diff/ui-kit/dom';
import { TOKENS_CSS_URL } from './tokens-css.ts';

const TOAST_MS = 5000;
const TOAST_CSS_URL = chrome.runtime.getURL('content/components/toast.css');

export function toast(text: string): void {
  const host = document.createElement('div');
  const { root: message } = mountShadow({
    host,
    stylesheets: [TOKENS_CSS_URL, TOAST_CSS_URL],
    className: 't',
    role: 'status',
    into: document.body,
  });
  message.textContent = text;
  setTimeout(() => host.remove(), TOAST_MS);
}
