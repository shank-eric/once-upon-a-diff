/*
 * A story tag, drawn: the one control a PR gets (tag-model.ts says what it shows and does), and the badge beside it when
 * answers wait unread. Preact components, drawn by tag-host.ts into each tag's shadow root and styled by story-tag.css.
 */
import { html } from '/assets/preact.mjs';
import type { AnswersBadge, Tag } from '../tag-model.ts';

/** The tag: a link, a button (with its small alt button) or a progress pill. */
export function StoryTag({ tag }: { tag: Tag }) {
  const inner = html`${tag.spin && html`<span class="spin"></span>`}${tag.label}`;
  if (tag.kind === 'link') {
    return html`<a class=${`b ${tag.cls}`} href=${tag.href} title=${tag.title}>${inner}</a>`;
  }
  if (tag.kind === 'button') {
    const alt =
      tag.alt &&
      html`<button class="alt" data-act=${tag.alt.act} title=${tag.alt.title}>${tag.alt.label}</button>`;
    return html`<button class=${`b ${tag.cls}`} data-act=${tag.act} title=${tag.title}>${inner}</button>${alt}`;
  }
  return html`<span class=${`b ${tag.cls}`} title=${tag.title} aria-live="polite">${inner}</span>`;
}

/** "1 new answer", linking Files changed with the Ask dock open. */
export function AnswersLink({ badge }: { badge: AnswersBadge }) {
  return html`<a class="ans" href=${badge.href} title=${badge.title}>${badge.label}</a>`;
}

/** What a tag host holds: the tag, then the answers badge when there is one. */
export function TagView({ tag, badge }: { tag: Tag; badge: AnswersBadge | null }) {
  return html`<${StoryTag} tag=${tag} />${badge && html`<${AnswersLink} badge=${badge} />`}`;
}
