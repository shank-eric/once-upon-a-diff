/*
 * Where a story tag (story-tag.js) lives on GitHub's page: our own span
 * after the PR's title, with its own shadow root, so GitHub's CSS can't reach
 * it and its clicks and keys stay ours. Used on PR lists and the
 * Conversation tab.
 */
import {
  hideUntilStyled,
  setHtml,
  stopKeyEvents,
  stylesheetLink,
} from '../../../shared/util/dom.js';

const TAG_CSS_URL = chrome.runtime.getURL('content/ui/story-tag.css');

/** A new tag host marked attribute=key, calling onClick for clicks inside it. */
export function createTagHost(attribute, key, onClick) {
  const host = document.createElement('span');
  host.setAttribute(attribute, key);
  const shadow = host.attachShadow({ mode: 'open' });
  const link = stylesheetLink(TAG_CSS_URL);
  const slot = document.createElement('span');
  slot.className = 'slot';
  shadow.append(link, slot);
  hideUntilStyled(host, [link]);
  shadow.addEventListener('click', onClick);
  stopKeyEvents(shadow);
  return host;
}

/** Draws the tag's html`` markup (story-tag.js tagHtml) in its host, only when it changed. */
export function showTag(host, tagMarkup) {
  const slot = host.shadowRoot.querySelector('.slot');
  const markup = String(tagMarkup);
  if (slot.getAttribute('data-html') !== markup) {
    slot.setAttribute('data-html', markup);
    setHtml(slot, tagMarkup);
  }
}

/** The tag button a click landed on (Build story, Update, Re-tell), or null: the Story link is a plain link. */
export function clickedTagButton(event) {
  const target = event.composedPath()[0];
  return (target.closest && target.closest('button[data-act]')) || null;
}
