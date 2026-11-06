/*
 * `once-upon wait`: the listener a Claude session runs as a background task. It beats (the panel's "listening" light), blocks
 * until a request arrives, and returns what it took, or why it stopped. Printing is the CLI's (cli/commands/inbox.ts).
 *
 * A story's own wait (`--story`) takes that story's questions ahead of a repo-wide one: see the routing rule in
 * queues/requests/conversation.ts. With build_request in its type, it takes the story's Rebuild requests the same way
 * (queues/requests/builds.ts). Fix requests (fix_request in the type) are routed the same way too, from the queue in
 * queues/requests/fixes.ts. A story's wait also stops itself once no page has shown the story for a while (auto-stop.ts), unless
 * --no-auto-stop. A repo's wait stops once none of its stories has been shown, or when the board's Stop listening asks.
 *
 * The order inside one pass is the contract the once-upon-listen skill leans on: what was handed over wins over a due timeout,
 * a due timeout over a story's idle stop, and that over the repo's.
 */
import { repoListenerName } from '@once-upon-a-diff/domain/ids';
import { existsSync, statSync, watch } from 'node:fs';
import {
  REPO_RE,
  sameRepo,
  repoOfCheckout,
  seenCheckout,
  checkoutRoot,
} from '@once-upon-a-diff/foundation/repos';
import {
  Inbox,
  filterEntries,
  readIdList,
  writeIdList,
  type InboxEntry,
  type QuestionEntry,
} from '@once-upon-a-diff/state/queues/requests/inbox';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { noteHanded, routeQuestions } from '@once-upon-a-diff/state/queues/requests/conversation';
import { fixesToHand } from '@once-upon-a-diff/state/queues/requests/fixes';
import {
  relayBinding,
  ownSession,
  touchBinding,
  type Binding,
} from '@once-upon-a-diff/state/records/listeners/binding';
import { beat, listeners } from '@once-upon-a-diff/state/records/listeners/listeners';
import { noteListener } from '@once-upon-a-diff/state/records/listeners/history';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import {
  idleMsOf,
  logStop,
  repoIdleMsOf,
  repoStopReason,
  stopReason,
  stopRequested,
} from './auto-stop.ts';
import { mayRelay, relayEntryMessage, relayFallback, relayStory } from './relay.ts';
import type { Relayable } from './relay.ts';
import { handOverLines, relayBlock, type Printable, type StopScope } from './hand-over.ts';
import { repoAt, resolveStory } from './story-ref.ts';

/** A flag as the command line parsed it: its text, true for a bare flag, or missing. */
type Flag = string | true | undefined;

/** What `wait` was asked for: the flags of `once-upon wait`, and the folder it runs in (the checkout it tells the bridge of). */
export interface WaitOptions {
  repo?: Flag;
  story?: Flag;
  type?: Flag;
  consumer?: Flag;
  /** seconds; none means wait for ever */
  timeout?: Flag;
  noAutoStop?: boolean;
  noRelay?: boolean;
  cwd: string;
}

/** What a wait covers: the beat says so, for the status light and the routing. */
type WaitScope = {
  repo?: string;
  story?: string;
  builds?: boolean;
  fixes?: boolean;
  /** the Claude Code session this wait runs in, and --no-relay: the beat says so, for the panel's "who answers" (binding.ts) */
  session?: string;
  norelay?: boolean;
};

/** An entry the wait hands over, with the lines that tell the session what to do with it. */
export interface HandedItem {
  entry: Printable;
  /** set when the entry goes on to the agent that built its story: the message to send and what to do if it can't be reached */
  relay?: { agent: string; message: string; fallback: string };
  /** after `describe(entry)`: the relay block, or the usual lines for the entry's kind (one print each) */
  lines: string[];
}

export type WaitOutcome =
  | { kind: 'handed'; items: HandedItem[] }
  | { kind: 'timeout' }
  | { kind: 'stopped'; scope: StopScope; reason: string };

const BEAT_MS = 5000;
const POLL_MS = 2000;

/** One listener per repo or story: its own cursor and heartbeat unless --consumer says otherwise. */
function consumerOf(opts: { consumer?: Flag; story?: Flag; repo?: Flag }): string {
  if (opts.consumer) {
    return opts.consumer as string;
  }
  if (opts.story) {
    return `story-${opts.story}`;
  }
  return opts.repo ? repoListenerName(String(opts.repo)) : 'default';
}

/** Questions a repo-wide wait left to a live story listener, kept beside its cursor to look at again. */
const deferredFile = (messages: Inbox, consumer: string) =>
  messages.cursorFile(consumer).replace(/\.json$/, '.deferred.json');

/**
 * This wait's share of the questions: new ones, plus ones it left to a story listener before. Hands back the ones
 * to take now and remembers the rest.
 */
function questionsToTake(
  home: string,
  messages: Inbox,
  consumer: string,
  scope: WaitScope,
  fresh: QuestionEntry[],
): QuestionEntry[] {
  const file = deferredFile(messages, consumer);
  const before = readIdList(file);
  const earlier = before.length
    ? messages
        .all()
        .filter(
          (entry): entry is QuestionEntry => entry.type === 'question' && before.includes(entry.id),
        )
    : [];
  const { take, defer } = routeQuestions(home, consumer, scope, [...earlier, ...fresh]);
  const after = defer.map((question) => question.id);
  if (after.length || before.length) {
    writeIdList(file, after);
  }
  return take;
}

/**
 * The approvals this wait takes: a story's live listener (`wait --story`) takes its story's, and a repo or catch-all wait
 * leaves them to it while it is live, so a session hears one approval once. Not held back for later: a story listener
 * was running when it was clicked.
 */
function approvalsToTake(
  home: string,
  consumer: string,
  scope: WaitScope,
  fresh: InboxEntry[],
): InboxEntry[] {
  if (!fresh.length || scope.story) {
    return fresh;
  }
  const storyListeners = listeners(home).filter(
    (listener) => listener.live && listener.story && listener.consumer !== consumer,
  );
  return fresh.filter(
    (entry) => !storyListeners.some((listener) => listener.story === entry.story),
  );
}

/** A wait run from the repo's checkout tells the bridge where that checkout is, for the next prompt. */
function noteCheckout(home: string, repo: string, cwd: string): void {
  try {
    const top = checkoutRoot(cwd);
    if (sameRepo(repoOfCheckout(top), repo)) {
      seenCheckout(home, repo, top);
    }
  } catch {
    /* not in a checkout */
  }
}

/** Resolves when the inbox file changes, or after POLL_MS. */
const inboxChange = (file: string) =>
  new Promise<void>((resolve) => {
    const watcher = watch(file, () => {
      watcher.close();
      resolve();
    });
    setTimeout(() => {
      watcher.close();
      resolve();
    }, POLL_MS);
  });

/** What to print for what was handed over: each entry with its relay (if its story's agent takes it) and its lines. */
function itemsFor(
  entries: Printable[],
  relays: Map<string, Binding>,
  consumer: string,
): HandedItem[] {
  return entries.map((entry) => {
    const bound = relays.get(entry.id);
    if (!bound) {
      return { entry, lines: handOverLines(entry) };
    }
    const message = relayEntryMessage(entry as Relayable, bound.agent);
    const fallback = relayFallback(entry as Relayable, consumer);
    return {
      entry,
      relay: { agent: bound.agent, message, fallback },
      lines: [relayBlock(bound.agent, message, fallback)],
    };
  });
}

/**
 * Waits for the next request this listener takes, and returns it (or why it stopped). Throws for a bad --repo or a --story it
 * can't resolve, before it beats.
 */
export async function wait(home: string, opts: WaitOptions): Promise<WaitOutcome> {
  const messages = new Inbox(home);
  if (opts.repo && !REPO_RE.test(String(opts.repo))) {
    throw new Error('usage: once-upon wait --repo owner/name');
  }
  const story: Flag = opts.story
    ? resolveStory(home, opts.story as string, () => repoAt(opts.cwd))
    : opts.story;
  const flags = { repo: opts.repo, story };
  const consumer = consumerOf({ consumer: opts.consumer, ...flags });
  if (opts.repo) {
    noteCheckout(home, opts.repo as string, opts.cwd);
  }
  const type = (opts.type as string | undefined) || 'question,build_request,fix_request,approved';
  const takesBuilds = type.split(',').includes('build_request');
  const takesFixes = type.split(',').includes('fix_request');
  const scope: WaitScope = {
    ...(opts.repo ? { repo: String(opts.repo) } : {}),
    ...(story ? { story: String(story) } : {}),
    // a story wait that takes build requests gets the story's rebuilds ahead of the repo's wait
    ...(story && takesBuilds ? { builds: true } : {}),
    // the beat says it takes fix requests, so the panel names this session on Send
    ...(takesFixes ? { fixes: true } : {}),
  };
  const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
  // a story's wait ends on its own once no page has shown the story for the idle window
  const autoStop =
    story && !opts.noAutoStop
      ? {
          stories: new StoryStore({ home }),
          story: String(story),
          startedAt: Date.now(),
          idleMs: idleMsOf(home),
        }
      : null;
  // a repo's wait ends on its own once no page has shown one of the repo's stories for the idle window, or when the
  // board's Stop listening asks (both logged to listeners.log)
  const repoStop =
    opts.repo && !story && !opts.noAutoStop
      ? {
          stories: new StoryStore({ home }),
          repo: String(opts.repo),
          startedAt: Date.now(),
          idleMs: repoIdleMsOf(home),
        }
      : null;
  messages.ensureFile();
  // a reader new to the inbox starts from now, not from every old question
  if (!existsSync(messages.cursorFile(consumer))) {
    messages.setCursor(consumer, statSync(messages.file).size);
  }
  // a wait run from the session that owns a story's agent relays that story's questions to it (binding.ts), whatever
  // it covers; the beat says which session this is, so the panel can name the agent as the one that answers
  const noRelay = !!opts.noRelay;
  const owner = ownSession();
  if (owner) {
    scope.session = owner;
  }
  if (noRelay) {
    scope.norelay = true;
  }
  // the heartbeat the panel's "Claude listening" light reads
  beat(home, consumer, 'waiting', scope);
  if (opts.repo && !story) {
    noteListener(home, String(opts.repo), consumer);
  }
  const heartbeat = setInterval(() => beat(home, consumer, 'waiting', scope), BEAT_MS);
  // build requests come from builds.json (queued ones, claimed as they're handed over), so none are missed or given twice
  const builds = takesBuilds ? new Builds(home) : null;
  try {
    for (;;) {
      const unread = filterEntries(messages.unread(consumer, { advance: true }), {
        type,
        ...flags,
      });
      const questions = questionsToTake(
        home,
        messages,
        consumer,
        scope,
        unread.filter((entry): entry is QuestionEntry => entry.type === 'question'),
      );
      let entries: Printable[] = [
        ...questions,
        // (fix requests come from fixes.json, not the inbox file)
        ...approvalsToTake(
          home,
          consumer,
          scope,
          unread.filter((entry) => entry.type === 'approved'),
        ),
        ...unread.filter(
          (entry) =>
            entry.type !== 'question' &&
            entry.type !== 'approved' &&
            (entry.type as string) !== 'fix_request',
        ),
      ];
      if (takesFixes) {
        entries = [...entries, ...fixesToHand(home, consumer, scope)];
      }
      if (builds) {
        entries = [
          ...entries,
          ...builds.toHand(consumer, {
            repo: (opts.repo as string | undefined) || null,
            story: (story as string | undefined) || null,
          }),
        ];
      }
      if (entries.length) {
        clearInterval(heartbeat);
        // a question of a story built by an agent this session owns goes on to the agent, from any wait here
        const relays = new Map<string, Binding>();
        const bindings = new Map<string, Binding | null>();
        for (const entry of noRelay ? [] : entries) {
          const relayed = relayStory(entry);
          if (!relayed) {
            continue;
          }
          if (!bindings.has(relayed)) {
            bindings.set(relayed, relayBinding(home, relayed, owner));
          }
          const bound = bindings.get(relayed);
          if (bound && mayRelay(home, entry, bound.agent)) {
            relays.set(entry.id as string, bound);
            touchBinding(home, relayed); // in use, so a long session's binding doesn't expire under it
          }
        }
        const own = questions.filter((question) => !relays.has(question.id));
        noteHanded(
          home,
          own.map((question) => question.id),
          consumer,
        );
        for (const [id, bound] of relays) {
          if (questions.some((question) => question.id === id)) {
            noteHanded(home, [id], bound.agent, consumer);
          }
        }
        beat(home, consumer, 'handling', {
          ...scope,
          question: entries[0].id,
          questions: questions.map((question) => question.id),
        });
        return { kind: 'handed', items: itemsFor(entries, relays, consumer) };
      }
      if (Date.now() > deadline) {
        clearInterval(heartbeat);
        return { kind: 'timeout' };
      }
      const reason = autoStop && stopReason({ home, consumer, ...autoStop });
      if (reason) {
        clearInterval(heartbeat);
        logStop(home, `${consumer} stopped listening for story ${autoStop!.story}: ${reason}`);
        return { kind: 'stopped', scope: { story: autoStop!.story }, reason };
      }
      const repoReason =
        repoStop &&
        (stopRequested(home, repoStop.repo, repoStop.startedAt) ||
          repoStopReason({ home, consumer, ...repoStop }));
      if (repoReason) {
        clearInterval(heartbeat);
        logStop(home, `${consumer} stopped listening for ${repoStop!.repo}: ${repoReason}`);
        return { kind: 'stopped', scope: { repo: repoStop!.repo }, reason: repoReason };
      }
      await inboxChange(messages.file);
    }
  } finally {
    clearInterval(heartbeat); // an error mustn't leave the heartbeat running
  }
}
