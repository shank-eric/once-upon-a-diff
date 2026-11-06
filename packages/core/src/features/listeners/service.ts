/*
 * Listening, in one place. A Claude Code session listens for a repo's (or one story's) requests by running `once-upon wait`;
 * this is the way into everything that does: the wait itself, who is listening and the panel's light, the stop signals, the
 * story-to-agent binding and the board's Listeners lane. The CLI, the HTTP app and the board import this file and nothing else
 * of listening (configs/.dependency-cruiser.mjs, `listening-through-service`).
 *
 * What sits behind it:
 *   state/records/listeners/   the files: heartbeats (listeners/<consumer>.json), the binding (state/<id>/agent.json), the history.
 *                        They stay a tier down because the request queues read heartbeats to route a claim, and a queue can't
 *                        import a feature.
 *   wait.ts              the loop: take or defer, approvals, relays, the stops.  hand-over.ts: what the session reads after it.
 *   auto-stop.ts         seen.json, the idle windows, the board's Stop listening.
 *   relay.ts             the messages for the agent that built a story.
 *   board-view.ts        which session listens, and the Listeners lane.
 */
import type { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  AGENT_RE,
  activeBinding,
  clearBinding,
  ownSession,
  readBinding,
  sessionLive,
  writeBinding,
  type Binding,
} from '@once-upon-a-diff/state/records/listeners/binding';
import {
  answeringOf,
  cliCommand,
  listenPrompt,
  listeners,
  listeningOf,
  statusOf,
  touchHandling,
  type Listener,
} from '@once-upon-a-diff/state/records/listeners/listeners';
import { noteSeen, requestStop } from './auto-stop.ts';
import { resolveStory, repoAt } from './story-ref.ts';
import { wait, type WaitOptions, type WaitOutcome } from './wait.ts';

export class Listening {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /** `once-upon wait`: blocks until a request is handed over, the timeout ends it, or it stops itself. */
  wait(opts: WaitOptions): Promise<WaitOutcome> {
    return wait(this.home, opts);
  }

  /** A `--story` value (an id, owner/name#N, a PR URL or a number in `repoHere`'s repo) as a story id. */
  resolveStory(value: string, repoHere: () => string | null): string {
    return resolveStory(this.home, value, repoHere);
  }

  /** Every listener, newest beat first, each with whether it is live. */
  all(now?: number): Listener[] {
    return listeners(this.home, now);
  }

  /** The live listeners only. */
  live(now?: number): Listener[] {
    return listeners(this.home, now).filter((listener) => listener.live);
  }

  /** A session still working on what its wait handed it keeps its handling beat fresh. */
  touchHandling(consumer: string): void {
    touchHandling(this.home, consumer);
  }

  /** Is a session listening for this repo or story, and the prompt that starts one (the panel's light). */
  listening(page: { repo?: string | null; story?: string | null } = {}) {
    return listeningOf(this.home, page);
  }

  /** What the panel's status light shows. */
  status(input: Omit<Parameters<typeof statusOf>[0], 'home'>) {
    return statusOf({ home: this.home, ...input });
  }

  /** The board's Stop listening: every `wait --repo` for the repo ends on its next look. */
  stop(repo: string, now?: number): void {
    requestStop(this.home, repo, now);
  }

  /** A page shows this story now (a story listener stops itself once none has for a while). */
  seen(stories: StoryStore, story: string, now?: number, minGap?: number): void {
    noteSeen(stories, story, now, minGap);
  }

  /** The story's binding as saved, whatever its age. */
  binding(story: string): Binding | null {
    return readBinding(this.home, story);
  }

  /** The story's binding while it can still be used: fresh, and its session still running. */
  activeBinding(story: string): Binding | null {
    return activeBinding(this.home, story);
  }

  /** Binds the story to the agent that built it, owned by `session`. */
  bind(story: string, agent: string, session: string | null): Binding {
    return writeBinding(this.home, story, agent, session);
  }

  /** Removes the story's binding. True when there was one. */
  unbind(story: string): boolean {
    return clearBinding(this.home, story);
  }

  /** Is a Claude Code process running for this session id? */
  sessionLive(session: string): boolean {
    return sessionLive(this.home, session);
  }
}

// what needs no home
export { AGENT_RE, answeringOf, cliCommand, listenPrompt, ownSession, repoAt };
export { stoppedEvent, stoppedLines } from './hand-over.ts';
export {
  adoptHandlers,
  listeningOnly,
  listenersLane,
  parentMap,
  sessionOfPid,
  storyListening,
} from './board-view.ts';
export type { Binding, Listener };
export type { Printable, StopScope } from './hand-over.ts';
export type { HandedItem, WaitOptions, WaitOutcome } from './wait.ts';
export type { LaneInput, MarkInput } from './board-view.ts';
