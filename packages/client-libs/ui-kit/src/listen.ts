/*
 * "Start listening", on the panel, the PR pages and the local page: types the listen line into a live Claude Code session
 * through the host's listen port (the panel's opts.listen), which the bridge backs (its board routes for the extension, the story's own routes for the
 * local page). It asks for the idle sessions on click: one (or one clearly fresher than the rest) is typed into at once,
 * several close together are listed to choose from, and none leaves a note saying to start one and click again.
 *
 * `listenPlan` and the texts have no DOM, so node tests can use them.
 */
import { obviousChoice, freshestFirst } from '@once-upon-a-diff/terms/choice';
import { compactAge } from '@once-upon-a-diff/terms/time';
import { html, render } from '/assets/preact.mjs';
import { ListenLine } from './components/listen-line.ts';
import type {
  ListenSession,
  ListenSessions,
  ListenTarget,
} from '@once-upon-a-diff/contracts/types';

/** What the bridge answers a click on Start listening with: the sessions to type into, and the line to run by hand. */
export type ListenOffer = Omit<ListenSessions, 'repo'>;

/** The line to run by hand for this target (a story's own line when the answer has one). */
export const lineFor = (offer: ListenOffer, target: ListenTarget): string =>
  (target.scope === 'story' && offer.storyLine) || offer.line;

/** What to do with the sessions the bridge offered. */
export type ListenPlan =
  | { kind: 'none' }
  | { kind: 'one'; session: ListenSession }
  | { kind: 'choose'; sessions: ListenSession[] };

/** None, the one to use without asking (the only one, or clearly the freshest), or the sessions to choose from, freshest first. */
export function listenPlan(sessions: readonly ListenSession[]): ListenPlan {
  if (!sessions.length) {
    return { kind: 'none' };
  }
  const obvious = obviousChoice(sessions);
  return obvious
    ? { kind: 'one', session: obvious }
    : { kind: 'choose', sessions: freshestFirst(sessions) };
}

/** "idle 12m", "idle 3h" or "idle 2d" for the chooser, from the time it went idle (nothing when unknown). */
export function idleFor(since: string | null, now = Date.now()): string {
  const age = compactAge(since, now, 24);
  if (!age) {
    return '';
  }
  return age === 'now' ? 'idle just now' : `idle ${age}`;
}

const forWhat = (target: ListenTarget, repo: string | null | undefined) =>
  target.scope === 'story' ? 'this story' : repo || 'the repo';

/**
 * The note when no session can be typed into, ahead of the line to run by hand (`lineNote`, with its Copy button): with no
 * iTerm (`typing` false) there is no tab at all, else no idle session has one.
 */
export function noSessionNote(
  target: ListenTarget,
  repo: string | null | undefined,
  checkout: string | null | undefined,
  typing = true,
) {
  const where = checkout ? `in ${checkout}` : `in your ${repo || 'repo'} checkout`;
  if (!typing) {
    return `iTerm isn't set up here, so there is no tab to type into. Run this line in Claude Code ${where}:`;
  }
  return (
    `No idle Claude Code session in ${repo || 'the repo'} has an iTerm tab to type into. ` +
    `Run this line in Claude Code ${where}, or start a session there and click Start listening${target.scope === 'story' ? ' for this story' : ''} again:`
  );
}

/** The note after Queue: any message in a session there starts it (the hook, `once-upon install-hooks`, claims the request). */
export const queuedNote = (checkout: string | null | undefined, repo: string | null | undefined) =>
  `Queued for 15 minutes. Send any message in a Claude Code session ${checkout ? `in ${checkout}` : `in your ${repo || 'repo'} checkout`} and it will start listening (needs the hook: once-upon install-hooks).`;

/** The note after the line was typed. */
export const typedNote = (title: string, target: ListenTarget, repo: string | null | undefined) =>
  `Typed into “${title}” to listen for ${forWhat(target, repo)}. It should show as listening in a few seconds.`;

/** The note when the bridge refused or could not be asked (its words, or a plain reason). */
export const failedNote = (message: string) => `Couldn't start it: ${message}.`;

/** How a host reaches the idle sessions and types the listen line into one (the panel's `opts.listen`). */
export interface ListenPort {
  sessions(target: ListenTarget): Promise<ListenOffer>;
  start(session: string, target: ListenTarget): Promise<unknown>;
  /** Queue Start listening for the next session in that checkout (a hook claims it); a host that cannot says nothing. */
  queue?(target: ListenTarget): Promise<unknown>;
}

/** What the panel knows of where it is, for the notes. */
export interface ListenWhere {
  repo?: string | null;
  checkout?: string | null;
}

/**
 * Wires `button` (Start listening) to ask for sessions and type into one, showing every outcome in `note`. Clicking while
 * the chooser is open closes it. Returns nothing: the button and note are the whole interface, and are drawn again by
 * the status light when the listener shows up.
 */
export function wireStartListening(
  button: HTMLButtonElement,
  note: HTMLElement,
  target: ListenTarget,
  listen: ListenPort,
  where: ListenWhere,
): void {
  const label = button.textContent;
  /** Shows `parts` in the note (nothing hides it). */
  const show = (...parts: (string | Node)[]) => {
    note.replaceChildren(...parts);
    note.hidden = !parts.some(Boolean);
  };
  const say = (text: string) => show(text);
  const rest = () => {
    button.disabled = false;
    button.textContent = label;
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** No session to type into: why, the line to run by hand with Copy, and Queue when the host has it. */
  function showLine(offer: ListenOffer) {
    const box = note.ownerDocument.createElement('span');
    const queue = listen.queue
      ? async () => {
          try {
            await listen.queue!(target);
            say(queuedNote(where.checkout, where.repo));
          } catch (err) {
            say(failedNote(message(err)));
          }
        }
      : undefined;
    render(html`<${ListenLine} line=${lineFor(offer, target)} onQueue=${queue} />`, box);
    show(noSessionNote(target, where.repo, where.checkout, offer.typing), ' ', box);
  }

  async function start(session: ListenSession) {
    say(`Typing into “${session.title}”…`);
    button.disabled = true;
    try {
      await listen.start(session.id, target);
      say(typedNote(session.title, target, where.repo));
    } catch (err) {
      say(failedNote(message(err)));
    }
    rest();
  }

  button.onclick = async () => {
    if (button.disabled) {
      return;
    }
    if (note.querySelector('.ou-startpick')) {
      say('');
      return;
    }
    button.disabled = true;
    button.textContent = 'Looking…';
    let offer: ListenOffer;
    try {
      offer = await listen.sessions(target);
    } catch (err) {
      say(failedNote(message(err)));
      rest();
      return;
    }
    rest();
    const plan = listenPlan(offer.sessions);
    if (plan.kind === 'none') {
      showLine(offer);
    } else if (plan.kind === 'one') {
      await start(plan.session);
    } else {
      const doc = note.ownerDocument;
      const list = doc.createElement('span');
      list.className = 'ou-startpick';
      list.append('Type into which session? ');
      for (const session of plan.sessions) {
        const pick = doc.createElement('button');
        pick.type = 'button';
        const idle = idleFor(session.since);
        pick.textContent = idle ? `${session.title} · ${idle}` : session.title;
        pick.title = `Types the listen line into “${session.title}” and presses Enter`;
        pick.onclick = () => {
          start(session);
        };
        list.append(pick, ' ');
      }
      show(list);
    }
  };
}
