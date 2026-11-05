/*
 * Where a story tag (story-tag.ts) lives on GitHub's page: our own span
 * after the PR's title, with its own shadow root, so GitHub's CSS can't reach
 * it and its clicks and keys stay ours. Used on PR lists and the
 * Conversation tab.
 */
import { html, render } from '/assets/preact.mjs';
import { mountShadow } from '@once-upon-a-diff/ui-kit/dom';
import type { AnswersBadge, Tag } from '../tag-model.ts';
import { TagView } from './story-tag.ts';

const TAG_CSS_URL = chrome.runtime.getURL('content/components/story-tag.css');

/** A new tag host marked attribute=key, calling onClick for clicks inside it. */
export function createTagHost(
  attribute: string,
  key: string,
  onClick: (event: Event) => void,
): HTMLSpanElement {
  const host = document.createElement('span');
  host.setAttribute(attribute, key);
  const { shadow } = mountShadow({
    host,
    stylesheets: [TAG_CSS_URL],
    tag: 'span',
    className: 'slot',
    isolateKeys: 'shadow',
  });
  shadow.addEventListener('click', onClick);
  return host;
}

/** Draws the tag (and its answers badge) in its host; drawing the same again changes nothing. */
export function showTag(host: Element, tag: Tag, badge: AnswersBadge | null): void {
  const slot = host.shadowRoot!.querySelector('.slot')!; // createTagHost made both
  render(html`<${TagView} tag=${tag} badge=${badge} />`, slot);
}

/** The tag button a click landed on (Build story, Update, Re-tell), or null: the Story link is a plain link. */
export function clickedTagButton(event: Event): HTMLButtonElement | null {
  const target = event.composedPath()[0] as Element;
  return (target.closest && target.closest<HTMLButtonElement>('button[data-act]')) || null;
}
