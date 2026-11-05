/*
 * Rebuild: when the story reads wrong, the reviewer asks for it to be told again, all of it ("Rebuild story…" on the Overview)
 * or from the chapter on screen ("Rebuild from here…"), with an optional note on what should change. opts.requestRebuild sends
 * it to the bridge, as a build request a listening Claude session takes. The pulse's `rebuild` says how it stands, on a line
 * under the toolbar on every step.
 *
 * render() works out the status line (its 30-minute expiry comes from the clock then) and the box, and the views draw them.
 * What was typed in the form is kept across redraws and step changes; the form itself belongs to the step it was opened on.
 */
import { html } from '/assets/preact.mjs';
import { LinkButton } from '@once-upon-a-diff/ui/link-button';
import { rebuildAsk, rebuildLine, rebuildPending } from './rebuild.ts';
import type { PanelContext } from '../host/context.ts';
import type { RebuildView } from '@once-upon-a-diff/protocol/types';

const GUIDANCE_PLACEHOLDER =
  'What should change? (optional) For example: chapter 3 tells the save flow backwards';

/** What the box under the step says, as render() worked it out for the step on screen. */
interface Box {
  step: number;
  label: string;
  title: string;
  pending: boolean;
  /** the form's explanation, when the form is open */
  explain: string | null;
}

export function createRebuild(context: PanelContext) {
  const { state, opts, shell } = context;
  let current: RebuildView | null = null; // the pulse's rebuild
  let formFor: number | null = null; // the step whose "what should change" box is open
  let draft = ''; // what they typed, kept across redraws
  let statusText = '';
  let box: Box | null = null;
  let sending = false;

  const pending = () => rebuildPending(current);

  /** What a rebuild from `step` keeps and re-tells, said before they ask. */
  function explain(step: number): string {
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

  function boxOf(step: number): Box {
    let label = step ? 'Rebuild from here…' : 'Rebuild story…';
    const title = step
      ? 'Keep the chapters before this one and tell this one and the rest again'
      : 'Tell the whole story again on the current diff';
    if (pending()) {
      label = (current as RebuildView).state === 'building' ? 'Rebuilding…' : 'Rebuild queued';
    }
    const open = formFor === step && !pending();
    return { step, label, title, pending: pending(), explain: open ? explain(step) : null };
  }

  /** Works out the status line and the box for the step on screen, and has the panel draw them. */
  function render() {
    statusText = rebuildLine(current);
    const chapter = context.chapter();
    box = !opts.requestRebuild || (chapter && chapter.auto) ? null : boxOf(state.n);
    sending = false; // the form is drawn afresh
    shell.redraw();
  }

  // ---------- views

  /** The line under the toolbar. */
  function statusView() {
    const failed = !!current && current.state === 'failed';
    return html`<div class=${failed ? 'ou-rebuilding ou-failed' : 'ou-rebuilding'} role="status" hidden=${!statusText}>${statusText || null}</div>`;
  }

  /** The button that opens the form, or the form, at the foot of the body. */
  function boxView() {
    if (!box) {
      return null;
    }
    const { step } = box;
    if (box.explain !== null) {
      const onSubmit = (event: Event) => {
        event.preventDefault();
        const text = (event.currentTarget as HTMLElement).querySelector(
          'textarea',
        ) as HTMLTextAreaElement;
        send(step, text.value);
      };
      return html`<form class="ou-rebuild-form" onSubmit=${onSubmit}><p class="ou-quiet">${box.explain}</p><textarea rows="3" aria-label="What should change" placeholder=${GUIDANCE_PLACEHOLDER} onInput=${(
        event: Event,
      ) => {
        draft = (event.currentTarget as HTMLTextAreaElement).value;
      }}>${draft}</textarea><div class="ou-rebuild-btns"><button type="submit" disabled=${sending}>Queue rebuild</button><${LinkButton} type="button" data-rebuild-cancel="" onClick=${() => {
        formFor = null;
        render();
      }}>Cancel</${LinkButton}></div></form>`;
    }
    return html`<button type="button" class="ou-rebuild-open" title=${box.title} disabled=${box.pending} onClick=${() => {
      formFor = step;
      render();
      shell.$('.ou-rebuild-form textarea')?.focus();
    }}>${box.label}</button>`;
  }

  async function send(step: number, guidance: string) {
    sending = true;
    shell.redraw();
    try {
      const answer = await opts.requestRebuild!(rebuildAsk(step, guidance)); // the form shows only with it
      formFor = null;
      draft = '';
      current = (answer && answer.rebuild) || current;
      shell.message(
        step > 1
          ? `Asked for a rebuild from chapter ${step}. A Claude session picks it up from the inbox.`
          : 'Asked for a rebuild of the whole story. A Claude session picks it up from the inbox.',
      );
    } catch (e) {
      shell.message(
        `Couldn't ask for a rebuild: ${e && (e as Error).message ? (e as Error).message : e}`,
      );
    }
    render();
  }

  /** The pulse's `rebuild`: redraw when it changed. */
  function update(next: RebuildView | null | undefined) {
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
    statusView,
    boxView,
    get current() {
      return current;
    },
  };
}

export type Rebuild = ReturnType<typeof createRebuild>;
