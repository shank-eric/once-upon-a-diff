/*
 * "Start listening", on the panel, the PR pages and the local page: types the listen line into a live Claude Code session
 * through the host's listen port (the panel's opts.listen), which the bridge backs (its board routes for the extension, the story's own routes for the
 * local page). It asks for the idle sessions on click: one (or one clearly fresher than the rest) is typed into at once,
 * several close together are listed to choose from, and none leaves a note saying to start one and click again.
 *
 * `listenPlan` and the texts have no DOM, so node tests can use them.
 */
import { obviousChoice, freshestFirst } from '@once-upon-a-diff/protocol/domain/choice';
import { compactAge } from '@once-upon-a-diff/protocol/domain/time';
import type { ListenSession, ListenTarget } from '@once-upon-a-diff/protocol/types';

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

/** The note when no session can be typed into: start one, then click again. */
export function noSessionNote(
  target: ListenTarget,
  repo: string | null | undefined,
  checkout: string | null | undefined,
) {
  const where = checkout ? `in ${checkout}` : `in your ${repo || 'repo'} checkout`;
  return (
    `No idle Claude Code session in ${repo || 'the repo'} has an iTerm tab to type into. ` +
    `Start one ${where}, then click Start listening${target.scope === 'story' ? ' for this story' : ''} again` +
    (target.scope === 'repo' ? `, or run /once-upon-listen ${target.repo} in it yourself.` : '.')
  );
}

/** The note after the line was typed. */
export const typedNote = (title: string, target: ListenTarget, repo: string | null | undefined) =>
  `Typed into “${title}” to listen for ${forWhat(target, repo)}. It should show as listening in a few seconds.`;

/** The note when the bridge refused or could not be asked (its words, or a plain reason). */
export const failedNote = (message: string) => `Couldn't start it: ${message}.`;

/** How a host reaches the idle sessions and types the listen line into one (the panel's `opts.listen`). */
export interface ListenPort {
  sessions(target: ListenTarget): Promise<ListenSession[]>;
  start(session: string, target: ListenTarget): Promise<unknown>;
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
  const say = (text: string) => {
    note.replaceChildren(text);
    note.hidden = !text;
  };
  const rest = () => {
    button.disabled = false;
    button.textContent = label;
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function start(session: ListenSession) {
    note.replaceChildren(`Typing into “${session.title}”…`);
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
    let sessions: ListenSession[];
    try {
      sessions = await listen.sessions(target);
    } catch (err) {
      say(failedNote(message(err)));
      rest();
      return;
    }
    rest();
    const plan = listenPlan(sessions);
    if (plan.kind === 'none') {
      say(noSessionNote(target, where.repo, where.checkout));
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
      note.replaceChildren(list);
      note.hidden = false;
    }
  };
}
