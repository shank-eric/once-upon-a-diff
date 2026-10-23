// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/*
 * Rebuild: when the story reads wrong, the reviewer asks for it to be told
 * again, all of it ("Rebuild story…" on the Overview) or from the chapter on
 * screen ("Rebuild from here…"), with an optional note on what should change.
 * opts.requestRebuild sends it to the bridge, as a build request a listening
 * Claude session takes. The pulse's `rebuild` says how it stands, on a line
 * under the toolbar on every step: queued, rebuilding, then rebuilt (with what
 * the rebuild kept) or failed.
 *
 * rebuildAsk and rebuildLine have no DOM, so node tests can use them.
 */
import { html } from '../util/html.ts';
import { setHtml } from '../util/dom.ts';
import { clockTime } from '../util/time.ts';

/** How long the panel says a rebuild finished, after it did. */
export const DONE_SHOWN_MS = 30 * 60 * 1000;

/** The request for a rebuild asked on `step` (0, the Overview, or 1: the whole story). */
export function rebuildAsk(step, guidance = '') {
  const note = String(guidance || '').trim();
  const from = Number(step) > 1 ? Number(step) : 1;
  return {
    mode: from > 1 ? 'rebuild_from' : 'rebuild',
    ...(from > 1 ? { from_step: from } : {}),
    ...(note ? { guidance: note } : {}),
    requested_at: new Date().toISOString(),
  };
}

/** Is the rebuild still to be done? */
export const rebuildPending = (rebuild) =>
  !!rebuild && (rebuild.state === 'queued' || rebuild.state === 'building');

/** The status line for the story's rebuild ('' when there's nothing to say). */
export function rebuildLine(rebuild, now = Date.now()) {
  if (!rebuild) {
    return '';
  }
  const from = rebuild.from_step ? `from chapter ${rebuild.from_step}` : '';
  const asked = clockTime(rebuild.requested_at);
  if (rebuild.state === 'queued') {
    return `Rebuild ${from || 'of the whole story'} queued${asked ? ` at ${asked}` : ''}. No Claude session has taken it yet.`;
  }
  if (rebuild.state === 'building') {
    const details = [rebuild.claimed_by || '', asked ? `asked at ${asked}` : ''].filter(Boolean);
    return `Rebuilding ${from || 'the whole story'}…${details.length ? ` (${details.join(', ')})` : ''}`;
  }
  const finished = Date.parse(rebuild.done_at || '');
  if (!Number.isFinite(finished) || now - finished > DONE_SHOWN_MS) {
    return '';
  }
  const finishedAt = clockTime(rebuild.done_at);
  const when = finishedAt ? ` at ${finishedAt}` : '';
  if (rebuild.state === 'failed') {
    return `The rebuild ${from || 'of the whole story'} failed${when}${rebuild.note ? `: ${rebuild.note}` : '.'}`;
  }
  return `Rebuilt ${from || 'the whole story'}${when}.${rebuild.note ? ` ${rebuild.note}` : ''}`;
}

const GUIDANCE_PLACEHOLDER =
  'What should change? (optional) For example: chapter 3 tells the save flow backwards';

export function createRebuild(context) {
  const { state, opts, shell } = context;
  const { $ } = shell;
  let current = null; // the pulse's rebuild
  let formFor = null; // the step whose "what should change" box is open
  let draft = ''; // what they typed, kept across redraws

  const pending = () => rebuildPending(current);

  /** What a rebuild from `step` keeps and re-tells, said before they ask. */
  function explain(step) {
    if (step <= 1) {
      return 'A Claude session tells the whole story again on the current diff, at the same link. Drafts whose line is still in the diff are kept, the others are kept and flagged, and questions move to the chapter that tells their file.';
    }
    const fresh = context.freshness.current;
    const stale =
      fresh && fresh.state === 'stale'
        ? ' The PR has commits this story doesn’t tell yet, so Update, or Rebuild story on the Overview, may fit better.'
        : '';
    const kept =
      step === 2
        ? 'Chapter 1 stays exactly as it is.'
        : `Chapters 1–${step - 1} stay exactly as they are.`;
    return `${kept} Chapter ${step} and the ones after it are told again, and every file and hunk the kept chapters don’t tell still gets a place. Their drafts and questions are kept.${stale}`;
  }

  function boxHtml(step) {
    let label = step ? 'Rebuild from here…' : 'Rebuild story…';
    const title = step
      ? 'Keep the chapters before this one and tell this one and the rest again'
      : 'Tell the whole story again on the current diff';
    if (pending()) {
      label = current.state === 'building' ? 'Rebuilding…' : 'Rebuild queued';
    }
    const open = formFor === step && !pending();
    if (open) {
      const guidance = html`<textarea rows="3" aria-label="What should change" placeholder="${GUIDANCE_PLACEHOLDER}">${draft}</textarea>`;
      const buttons = html`<div class="ou-rebuild-btns"><button type="submit">Queue rebuild</button><button type="button" class="ou-linkish" data-rebuild-cancel>Cancel</button></div>`;
      return html`<form class="ou-rebuild-form"><p class="ou-quiet">${explain(step)}</p>${guidance}${buttons}</form>`;
    }
    return html`<button type="button" class="ou-rebuild-open" title="${title}"${pending() && html` disabled`}>${label}</button>`;
  }

  function renderStatus() {
    const line = $('.ou-rebuilding');
    const text = rebuildLine(current);
    line.textContent = text;
    line.hidden = !text;
    line.classList.toggle('ou-failed', !!current && current.state === 'failed');
  }

  function render() {
    renderStatus();
    const box = $('.ou-body .ou-rebuild-box');
    if (!box) {
      return;
    }
    const chapter = context.chapter();
    if (!opts.requestRebuild || (chapter && chapter.auto)) {
      setHtml(box, '');
      return;
    }
    const step = state.n;
    setHtml(box, boxHtml(step));
    const openButton = box.querySelector('.ou-rebuild-open');
    if (openButton) {
      openButton.onclick = () => {
        formFor = step;
        render();
        box.querySelector('textarea')?.focus();
      };
    }
    const form = box.querySelector('form');
    if (!form) {
      return;
    }
    const text = form.querySelector('textarea');
    text.oninput = () => {
      draft = text.value;
    };
    form.querySelector('[data-rebuild-cancel]').onclick = () => {
      formFor = null;
      render();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      send(step, text.value);
    };
  }

  async function send(step, guidance) {
    const submit = $('.ou-body .ou-rebuild-form button[type="submit"]');
    if (submit) {
      submit.disabled = true;
    }
    try {
      const answer = await opts.requestRebuild(rebuildAsk(step, guidance));
      formFor = null;
      draft = '';
      current = (answer && answer.rebuild) || current;
      shell.message(
        step > 1
          ? `Asked for a rebuild from chapter ${step}. A Claude session picks it up from the inbox.`
          : 'Asked for a rebuild of the whole story. A Claude session picks it up from the inbox.',
      );
    } catch (e) {
      shell.message(`Couldn't ask for a rebuild: ${e && e.message ? e.message : e}`);
    }
    render();
  }

  /** The pulse's `rebuild`: redraw when it changed. */
  function update(next) {
    const value = next || null;
    if (JSON.stringify(value) === JSON.stringify(current)) {
      return;
    }
    current = value;
    render();
  }

  return {
    render,
    update,
    get current() {
      return current;
    },
  };
}
