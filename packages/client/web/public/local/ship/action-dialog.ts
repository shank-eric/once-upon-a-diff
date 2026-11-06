/*
 * ActionDialog: the confirm box Push, Push for an open PR and Create pull request share. It asks the bridge where the branch stands
 * (`load`), shows what an action would do and why it can't, and runs the action on its Go button (`go`). The boxes give it their
 * route, their texts and their blocker. It owns the rest: the "Checking..." line, "Couldn't check the branch" with Close, the
 * read-only refusal, the form shell with Cancel and Go, the working line, the result (or "The push didn't go through." and git's
 * lines, with Go back on) and Go turning into Done. The page draws one at a time (dialogs.ts) and takes it away when it says it
 * closed (Cancel, Close, Escape, a click on the backdrop).
 */
import { html, useEffect, useMemo, useState } from '/assets/preact.mjs';
import { Banner } from '/assets/ui-kit/components/banner.ts';
import { Dialog } from '/assets/ui-kit/components/dialog.ts';
import { shortSha } from '/assets/terms/text.ts';

/** What a read-only link is told in place of the box: it can read the story but not push. */
export interface Refusal {
  title: string;
  /** "push its branch": what the link can't do */
  cant: string;
  /** "push and open the PR": what to do from a full link */
  to: string;
  story: string;
}

export interface ActionSpec<V> {
  /** Set on a read-only link: the box says so and never asks the bridge. */
  refusal: Refusal | null;
  /** The line while `load` runs. */
  checking: string;
  load(): Promise<V>;
  /** Runs once with the view `load` answered (the page keeps its header in step with it). */
  loaded?(view: V): void;
  title(view: V): string;
  lead(view: V): unknown;
  /** What the action would do, in the box's banner. */
  standing(view: V): unknown;
  /** More form fields below the banner. They are the form's own: nothing redraws them while the reviewer types. */
  fields?(view: V): unknown;
  /** Why Go is off, shown in the result line; null when it can go. */
  blocker(view: V): string | null;
  goLabel(view: V): string;
  /** The line while `go` runs; null for none. */
  working?(view: V): string | null;
  /** Does the action. `ok` is what the box says on success, `output` is git's lines. A throw is "didn't go through". */
  go(view: V, form: HTMLFormElement): Promise<{ ok: unknown; output?: string }>;
  /** A button between Cancel and Go. */
  extra?(view: V, close: () => void): unknown;
}

/** The commits a push would send, as the boxes list them. */
export function CommitList(props: { view: { to_push: { sha: string; subject: string }[] } }) {
  return html`<ul class="ou-local-pr-commits">${props.view.to_push.map(
    (commit) => html`<li><code>${shortSha(commit.sha)}</code> ${commit.subject}</li>`,
  )}</ul>`;
}

function Form<V>(props: { spec: ActionSpec<V>; view: V; onClose: () => void }) {
  const { spec, view, onClose } = props;
  const blocker = spec.blocker(view);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const [result, setResult] = useState<unknown>(
    blocker ? html`<p class="ou-local-pr-stop">${blocker}</p>` : null,
  );
  // the same nodes at every draw, so a redraw (Go busy, a result) leaves what has been typed alone
  const body = useMemo(
    () => ({
      title: spec.title(view),
      lead: spec.lead(view),
      standing: spec.standing(view),
      fields: spec.fields?.(view),
      extra: spec.extra?.(view, onClose),
    }),
    [view],
  );
  const submit = async (event: Event) => {
    event.preventDefault();
    if (blocker || phase !== 'idle') {
      return;
    }
    const working = spec.working?.(view);
    setPhase('busy');
    setResult(working ? html`<p>${working}</p>` : null);
    try {
      // go starts inside the click, so a tab it opens isn't blocked
      const { ok, output } = await spec.go(view, event.currentTarget as HTMLFormElement);
      setResult(html`${ok}${output && html`<pre class="ou-local-pr-output">${output}</pre>`}`);
      setPhase('done');
    } catch (err) {
      setResult(
        html`<p class="ou-local-pr-stop">The push didn't go through.</p><pre class="ou-local-pr-output">${(err as Error).message}</pre>`,
      );
      setPhase('idle');
    }
  };
  return html`<form class="ou-local-pr-form" onSubmit=${submit}>
    <h2>${body.title}</h2>
    ${body.lead}
    <${Banner} tone="muted" class="ou-local-pr-standing">${body.standing}</${Banner}>
    ${body.fields}
    <div class="ou-local-pr-result" role="status">${result}</div>
    <div class="ou-local-pr-buttons">
      <button type="button" data-pr-cancel onClick=${onClose}>Cancel</button>
      ${body.extra}
      <button type="submit" class="ou-local-pr-go" disabled=${!!blocker || phase !== 'idle'}>${phase === 'done' ? 'Done' : spec.goLabel(view)}</button>
    </div>
  </form>`;
}

function Closer(props: { onClose: () => void }) {
  return html`<div class="ou-local-pr-buttons"><button type="button" data-pr-cancel onClick=${props.onClose}>Close</button></div>`;
}

export function ActionDialog<V>(props: { spec: ActionSpec<V>; onClose: () => void }) {
  const { spec, onClose } = props;
  const [load, setLoad] = useState<{ view: V } | { error: string } | null>(null);
  useEffect(() => {
    if (spec.refusal) {
      return;
    }
    spec.load().then(
      (view) => {
        spec.loaded?.(view);
        setLoad({ view });
      },
      (err: Error) => setLoad({ error: err.message }),
    );
  }, []);
  let content;
  if (spec.refusal) {
    const { title, cant, to, story } = spec.refusal;
    content = html`<form class="ou-local-pr-form"><h2>${title}</h2>
      <p>This page was opened with a read-only link, which can read the story but not ${cant}.</p>
      <p>To ${to}, open the story from the agent board (<b>Open story</b>) or run <code>once-upon page --story ${story}</code>.</p>
      <${Closer} onClose=${onClose} /></form>`;
  } else if (!load) {
    content = html`<p class="ou-local-muted">${spec.checking}</p>`;
  } else if ('error' in load) {
    content = html`<p class="ou-local-pr-stop">Couldn't check the branch: ${load.error}</p><${Closer} onClose=${onClose} />`;
  } else {
    content = html`<${Form} spec=${spec} view=${load.view} onClose=${onClose} />`;
  }
  return html`<${Dialog} id="ou-local-pr-box" onClose=${onClose}>${content}</${Dialog}>`;
}
