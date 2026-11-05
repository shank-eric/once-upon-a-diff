/*
 * The parts strip, "you are here": the repo's named parts (protocol/src/domain/parts.ts), a row for each group, with the ones a
 * step touches lit. A lit part says so by a mark (●, an unlit one has ○), a heavier border and weight, never by colour alone,
 * and in words for a screen reader. In a chapter a group with nothing lit folds into one "Not touched" line; the Overview
 * (`counts`) shows every group, with how many files each lit part holds. Styled by ui.css (`ou-ui-parts*`). It takes plain
 * data and knows nothing of stories, so the panel and the pages can both draw it.
 */
import { html } from '/assets/preact.mjs';
import type { StoryParts } from '@once-upon-a-diff/protocol/domain/parts';
import { plural } from '@once-upon-a-diff/protocol/domain/text';

/** The strip for the parts `touched` (ids). With `counts` (part id: files) it is the whole story's, and every group shows. Nothing touched: nothing drawn. */
export function PartsStrip(props: {
  parts: StoryParts;
  touched: readonly string[];
  counts?: Record<string, number>;
}) {
  const { parts, touched, counts } = props;
  if (!touched.length) {
    return null;
  }
  const lit = new Set(touched);
  const groups = parts.groups
    .map((group) => ({ group, items: parts.parts.filter((part) => part.group === group) }))
    .filter(({ items }) => items.length);
  const shown = counts
    ? groups
    : groups.filter(({ items }) => items.some((part) => lit.has(part.id)));
  const folded = counts ? [] : groups.filter((one) => !shown.includes(one));

  const cell = (part: StoryParts['parts'][number]) => {
    const active = lit.has(part.id);
    const count = counts && active ? counts[part.id] : undefined;
    const title = [part.note, count === undefined ? '' : plural(count, 'file')]
      .filter(Boolean)
      .join(' · ');
    return html`<li class=${active ? 'ou-ui-part ou-ui-part-on' : 'ou-ui-part'} title=${title || undefined}>
      <span aria-hidden="true">${active ? '●' : '○'} </span>${part.name}${
        active
          ? html`<span class="ou-ui-parts-sr"> touched${count === undefined ? '' : `, ${count} ${count === 1 ? 'file' : 'files'}`}</span>`
          : null
      }${count === undefined ? null : html`<span class="ou-ui-part-count" aria-hidden="true"> ${count}</span>`}
    </li>`;
  };

  return html`<div class="ou-ui-parts" role="group" aria-label=${counts ? 'Parts this story touches' : 'Parts this chapter touches'}>
    ${shown.map(
      ({ group, items }) =>
        html`<div class="ou-ui-parts-row"><span class="ou-ui-parts-group">${group}</span><ul class="ou-ui-parts-list">${items.map(cell)}</ul></div>`,
    )}${
      folded.length
        ? html`<p class="ou-ui-parts-rest">Not touched: ${folded.map(({ group }) => group).join(', ')}</p>`
        : null
    }
  </div>`;
}
