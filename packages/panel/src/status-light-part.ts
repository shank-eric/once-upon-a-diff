/*
 * The status light in the toolbar and what hangs off it: the checks it opens, the hint over the Ask box when no session is
 * listening, and the line saying who answers this story, with the Start listening buttons in them. status-light.ts has the
 * checks and the hint and who texts (no DOM, no Preact, so node tests use them); this draws them.
 *
 * The hint and the who line are markup strings (their tests read them), read into nodes with the buttons made components here:
 * Start listening asks the host for idle sessions and types the listen line into one, with its note and its chooser. Each of the
 * two has its own state, which starts over when its markup changes (the redraw that follows a new health), as the old
 * element did when it was written again. A reply that was on its way then lands on the old state and nothing shows.
 */
import { h as preactH, html } from '/assets/preact.mjs';
import { parseMarkup } from '@once-upon-a-diff/ui/parse-markup';
import { askHintHtml, askWhoHtml, classOf, healthChecks, markOf } from './status-light.ts';
import {
  failedNote,
  listenPlan,
  idleFor,
  noSessionNote,
  typedNote,
} from '@once-upon-a-diff/ui/listen';
import type { PanelContext } from './context.ts';
import type { Health } from './status-light.ts';
import type { ListenSession, ListenTarget, StatusError } from '@once-upon-a-diff/protocol/types';
import type { MarkupHooks, VNode } from '@once-upon-a-diff/ui/parse-markup';

const node = (tag: string, props: Record<string, unknown>, child?: unknown) =>
  preactH(tag, props, child as string) as VNode;

/** One Start listening button, with its note: what it says now, and whether it is busy. */
interface ListenUi {
  busy: boolean;
  /** the button's words while it works (null: its own) */
  label: string | null;
  /** the note under it, and the sessions to choose from when it is asking which */
  text: string;
  picking: ListenSession[] | null;
  folded: boolean;
}
const freshListenUi = (): ListenUi => ({
  busy: false,
  label: null,
  text: '',
  picking: null,
  folded: true,
});

export function createStatusLight(context: PanelContext) {
  const { opts, shell } = context;
  let health: Health | null = null;
  let healthOpen = false;
  // what the light shows, from the last answer
  let level: string | undefined;
  let title = 'Checking the connection…';
  let checks: Health['checks'] | null = null;
  // the hint and who markup as last drawn (null: never): the same markup is not drawn again, so a note stays put
  let hintMarkup: string | null = null;
  let hintHidden = true;
  let whoMarkup: string | null = null;
  let whoHidden = true;
  let repoUi = freshListenUi();
  let storyUi = freshListenUi();
  let detailsOpen = false;

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // ---------- Start listening (the flow wireStartListening has, over state instead of nodes)

  function say(slot: ListenUi, text: string) {
    slot.text = text;
    slot.picking = null;
    slot.folded = !text;
    shell.redraw();
  }
  function rest(slot: ListenUi) {
    slot.busy = false;
    slot.label = null;
    shell.redraw();
  }
  async function typeInto(
    slot: ListenUi,
    session: ListenSession,
    target: ListenTarget,
    where: Health,
  ) {
    slot.text = `Typing into “${session.title}”…`;
    slot.picking = null;
    slot.busy = true;
    shell.redraw();
    try {
      await opts.listen!.start(session.id, target);
      say(slot, typedNote(session.title, target, where.repo));
    } catch (err) {
      say(slot, failedNote(message(err)));
    }
    rest(slot);
  }
  async function clickStart(slot: ListenUi, target: ListenTarget) {
    const where = health as Health;
    if (slot.busy) {
      return;
    }
    if (slot.picking) {
      say(slot, '');
      return;
    }
    slot.busy = true;
    slot.label = 'Looking…';
    shell.redraw();
    let sessions: ListenSession[];
    try {
      sessions = await opts.listen!.sessions(target);
    } catch (err) {
      say(slot, failedNote(message(err)));
      rest(slot);
      return;
    }
    rest(slot);
    const plan = listenPlan(sessions);
    if (plan.kind === 'none') {
      say(slot, noSessionNote(target, where.repo, where.checkout));
    } else if (plan.kind === 'one') {
      await typeInto(slot, plan.session, target, where);
    } else {
      slot.text = '';
      slot.picking = plan.sessions;
      slot.folded = false;
      shell.redraw();
    }
  }

  /** The hooks that make the buttons in a hint or who line what they are: `slot()` is the state of the one it belongs to. */
  function hooksFor(slot: () => ListenUi, target: () => ListenTarget): MarkupHooks {
    return {
      element(tag, props, source) {
        const classes = String(props.class || '');
        if (tag === 'button' && /\bou-start(listen|story)\b/.test(classes)) {
          const own = slot();
          return node(
            'button',
            { ...props, disabled: own.busy, onClick: () => clickStart(own, target()) },
            own.label ?? source.textContent,
          );
        }
        if (tag === 'div' && classes.includes('ou-startnote')) {
          const own = slot();
          const chooser =
            own.picking &&
            html`<span class="ou-startpick">Type into which session? ${own.picking.map(
              (session) => {
                const idle = idleFor(session.since);
                return html`<button type="button" title=${`Types the listen line into “${session.title}” and presses Enter`} onClick=${() => void typeInto(own, session, target(), health as Health)}>${idle ? `${session.title} · ${idle}` : session.title}</button>${' '}`;
              },
            )}</span>`;
          return node('div', { ...props, hidden: own.folded }, chooser || own.text);
        }
        if (tag === 'button' && classes.includes('ou-promptmore')) {
          return node(
            'button',
            {
              ...props,
              'aria-expanded': String(detailsOpen),
              onClick: () => {
                detailsOpen = !detailsOpen;
                shell.redraw();
              },
            },
            detailsOpen ? 'hide details' : 'show details',
          );
        }
        if (tag === 'pre' && classes.includes('ou-promptlong')) {
          props.hidden = !detailsOpen;
        }
      },
    };
  }
  const hintHooks = hooksFor(
    () => repoUi,
    () => ({ scope: 'repo', repo: (health as Health).repo as string }),
  );
  const whoHooks = hooksFor(
    () => storyUi,
    () => ({ scope: 'story' }),
  );

  // ---------- what the last answer says

  function render(result: Health) {
    level = result.level;
    title =
      result.checks.map((check) => `${markOf(check)} ${check.name}: ${check.detail}`).join('\n') +
      '\n(click for details)';
    checks = result.checks;
    renderWho(result);
    renderHint(result);
    shell.redraw();
  }

  function renderHint(result: Health) {
    const showHint = opts.ask && result.level !== 'ok' && !result.listening;
    hintHidden = !showHint;
    if (!showHint) {
      return;
    }
    const canStart = !!opts.listen && !!result.repo && !!result.prompt;
    const markup = String(askHintHtml(result, canStart));
    // drawn on every refresh, so only when it changes (a Start listening note stays put)
    if (hintMarkup === markup) {
      return;
    }
    hintMarkup = markup;
    repoUi = freshListenUi();
    detailsOpen = false;
  }

  function renderWho(result: Health) {
    const markup = opts.ask ? String(askWhoHtml(result, !!opts.listen)) : '';
    whoHidden = !markup;
    // drawn only when it changes, so a Start listening note stays put
    if (whoMarkup === markup) {
      return;
    }
    whoMarkup = markup;
    storyUi = freshListenUi();
  }

  async function refresh() {
    if (!opts.status) {
      return;
    }
    try {
      health = healthChecks(await opts.status());
    } catch (err) {
      health = healthChecks(null, (err || {}) as Partial<StatusError>);
    }
    render(health);
  }

  // ---------- what is drawn

  /** The light in the toolbar. */
  function lightView() {
    return html`<button class="ou-light" title=${title} aria-label="Connection status" aria-expanded=${String(healthOpen)} data-level=${level} hidden=${!opts.status} onClick=${() => {
      healthOpen = !healthOpen;
      shell.redraw();
    }}><span class="ou-dot"></span></button>`;
  }

  /** The checks the light opens. */
  function healthView() {
    const rows = (checks || []).map((check) => {
      const fixText =
        check.fix &&
        check.fix.replace(
          /^In a Claude Code session, run as a background task: /,
          'In Claude Code, run as a background task: ',
        );
      const fix = fixText && html`<br /><span class="ou-why">${fixText}</span>`;
      return html`<li><span class=${classOf(check)}>${markOf(check)}</span> <b>${check.name}</b>: ${check.detail}${fix}</li>`;
    });
    return html`<div class="ou-health" hidden=${!healthOpen}>${checks ? html`<ul>${rows}</ul>` : null}</div>`;
  }

  /** The hint over the Ask box. */
  function hintView() {
    return html`<div class="ou-askhint" hidden=${hintHidden}>${hintMarkup === null ? null : parseMarkup(hintMarkup, hintHooks)}</div>`;
  }

  /** The line under the Ask box saying who answers. */
  function whoView() {
    return html`<div class="ou-askwho" hidden=${whoHidden}>${whoMarkup === null ? null : parseMarkup(whoMarkup, whoHooks)}</div>`;
  }

  if (opts.status) {
    refresh();
  }

  return {
    get current() {
      return health;
    },
    refresh,
    lightView,
    healthView,
    hintView,
    whoView,
  };
}

export type StatusLight = ReturnType<typeof createStatusLight>;
