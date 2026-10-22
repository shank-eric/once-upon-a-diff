/*
 * The inbox from the terminal: read it (inbox), wait for the next question or
 * build request (wait, the listener a Claude session runs as a background
 * task), and answer a question (answer).
 *
 * A story's own wait (`wait --story`) takes that story's questions ahead of a
 * repo-wide one: see the routing rule in ../../inbox/conversation.mjs. With
 * build_request in its --type, it takes the story's Rebuild requests the same
 * way (../../inbox/builds.mjs). Fix requests (fix_request in --type) are
 * routed the same way too, from the queue in ../../inbox/fixes.mjs.
 */
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { REPO_RE, sameRepo, repoOfCheckout, seenCheckout } from '../../config/repos.mjs';
import { Inbox } from '../../inbox/inbox.mjs';
import { Builds } from '../../inbox/builds.mjs';
import { noteHanded, readHanded, routeQuestions } from '../../inbox/conversation.mjs';
import { fixesToHand } from '../../inbox/fixes.mjs';
import { beat } from '../../listeners/listeners.mjs';
import { StoryStore } from '../../stories/store.mjs';
import { slug } from '../../stories/local-story.mjs';
import { readJson, writeJsonAtomic } from '../../util/json-file.mjs';
import { topLevel } from '../../util/git.mjs';
import { out, describe, filterEntries } from '../output.mjs';

const BEAT_MS = 5000;
const POLL_MS = 2000;

function inbox(home, cfg, opts) {
  const messages = new Inbox(home);
  const entries = filterEntries(
    opts.unread ? messages.unread(opts.consumer || 'default', { advance: true }) : messages.all(),
    opts,
  );
  for (const entry of entries) {
    out(opts.json ? JSON.stringify(entry) : describe(entry) + '\n');
  }
}

/** One listener per repo or story: its own cursor and heartbeat unless --consumer says otherwise. */
function consumerOf(opts) {
  if (opts.consumer) {
    return opts.consumer;
  }
  if (opts.story) {
    return `story-${opts.story}`;
  }
  return opts.repo ? `repo-${String(opts.repo).toLowerCase().replace('/', '-')}` : 'default';
}

/** The repo of the checkout this runs in, or null. */
function checkoutRepo() {
  try {
    return repoOfCheckout(topLevel(process.cwd()));
  } catch {
    return null;
  }
}

/**
 * --story's story id. It takes the id itself, a PR (owner/name#N or its URL), or a bare PR number in the repo of
 * this checkout. A PR's story is the one the bridge has for it, else the id `once-upon publish` will give it.
 */
export function storyIdOf(home, value, repoHere = checkoutRepo) {
  const text = String(value).trim();
  const pr =
    /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(text) ||
    /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(text);
  let repo = pr ? pr[1] : null;
  const number = pr ? pr[2] : /^\d+$/.test(text) && text;
  if (!number) {
    return text;
  }
  repo ||= repoHere();
  if (!repo) {
    throw new Error(`--story ${text}: run it in the repo's checkout, or say owner/name#${text}`);
  }
  const found = new StoryStore({ home }).find(repo, number);
  return found ? found.id : slug(`${repo.replace('/', '-')}-${number}`);
}

/** Questions a repo-wide wait left to a live story listener, kept beside its cursor to look at again. */
const deferredFile = (messages, consumer) =>
  messages.cursorFile(consumer).replace(/\.json$/, '.deferred.json');

/**
 * This wait's share of the questions: new ones, plus ones it left to a story listener before. Hands back the ones
 * to take now and remembers the rest.
 */
function questionsToTake(home, messages, consumer, scope, fresh) {
  const file = deferredFile(messages, consumer);
  const before = readJson(file, []) || [];
  const earlier = before.length
    ? messages.all().filter((entry) => entry.type === 'question' && before.includes(entry.id))
    : [];
  const { take, defer } = routeQuestions(home, consumer, scope, [...earlier, ...fresh]);
  const after = defer.map((question) => question.id);
  if (after.length || before.length) {
    writeJsonAtomic(file, after);
  }
  return take;
}

/** A wait run from the repo's checkout tells the bridge where that checkout is, for the next prompt. */
function noteCheckout(home, repo) {
  try {
    const top = topLevel(process.cwd());
    if (sameRepo(repoOfCheckout(top), repo)) {
      seenCheckout(home, repo, top);
    }
  } catch {
    /* not in a checkout */
  }
}

/** What a session does with a fix request, after the request itself. */
function fixGuidance(entry) {
  const where = entry.kind === 'local' ? 'the local story' : `${entry.repo} PR`;
  return [
    `It's yours (wait claimed it). Fix these notes on ${where}${entry.branch ? `, on branch ${entry.branch}` : ''}:`,
    `1. Say what you'll change: once-upon working --story ${entry.story} --request ${entry.id} --files <path[:start-end]>,...`,
    '2. Start the wait again, then make one change that addresses the notes, committed as the house rules say. Never push.',
    `3. Report it: once-upon fixed --request ${entry.id} --sha <sha> [--notes <ids it fixes>] (or --failed --note "<why>").`,
  ].join('\n');
}

/** Prints what was handed over, with what to run next. */
function printHandOver(entries, opts) {
  for (const entry of entries) {
    if (opts.json) {
      out(JSON.stringify(entry));
      continue;
    }
    out(describe(entry));
    if (entry.type === 'question') {
      out(`Answer with: once-upon answer --question ${entry.id} --text "…"`);
    }
    if (entry.type === 'build_request') {
      out(
        `It's yours (wait claimed it). Write the story: once-upon renders and publishes it, and publishing finishes the request.`,
      );
    }
    if (entry.type === 'build_request' && entry.mode === 'rebuild') {
      out(
        `It's a rebuild: follow once-upon's "Rebuilding a story" path. Re-tell the whole story, keep the id, and publish it again.`,
      );
    }
    if (entry.type === 'build_request' && entry.mode === 'rebuild_from') {
      out(
        `It's a rebuild from chapter ${entry.from_step}: follow once-upon's "Rebuilding a story" path. Chapters 1-${entry.from_step - 1} stay exactly as published.`,
      );
    }
    if (entry.type === 'fix_request') {
      out(fixGuidance(entry));
    }
    if (entry.type === 'build_request' && entry.mode === 'update' && !entry.retell) {
      out(
        `It's an update: follow once-upon's "Since you read it" path from ${entry.since_sha}, unless the PR was rebased past it.`,
      );
    }
    out('');
  }
}

/** Resolves when the inbox file changes, or after POLL_MS. */
const inboxChange = (file) =>
  new Promise((resolve) => {
    const watcher = watch(file, () => {
      watcher.close();
      resolve();
    });
    setTimeout(() => {
      watcher.close();
      resolve();
    }, POLL_MS);
  });

async function wait(home, cfg, opts) {
  const messages = new Inbox(home);
  if (opts.repo && !REPO_RE.test(String(opts.repo))) {
    throw new Error('usage: once-upon wait --repo owner/name');
  }
  if (opts.story) {
    opts = { ...opts, story: storyIdOf(home, opts.story) };
  }
  const consumer = consumerOf(opts);
  if (opts.repo) {
    noteCheckout(home, opts.repo);
  }
  const want = { ...opts, type: opts.type || 'question,build_request,fix_request' };
  const takesBuilds = want.type.split(',').includes('build_request');
  const takesFixes = want.type.split(',').includes('fix_request');
  const scope = {
    ...(opts.repo ? { repo: String(opts.repo) } : {}),
    ...(opts.story ? { story: String(opts.story) } : {}),
    // a story wait that takes build requests gets the story's rebuilds ahead of the repo's wait
    ...(opts.story && takesBuilds ? { builds: true } : {}),
    // the beat says it takes fix requests, so the panel names this session on Send
    ...(takesFixes ? { fixes: true } : {}),
  };
  const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : Infinity;
  if (!existsSync(messages.file)) {
    writeFileSync(messages.file, '', { mode: 0o600 });
  }
  // a reader new to the inbox starts from now, not from every old question
  if (!existsSync(messages.cursorFile(consumer))) {
    messages.setCursor(consumer, statSync(messages.file).size);
  }
  // the heartbeat the panel's "Claude listening" light reads
  beat(home, consumer, 'waiting', scope);
  const heartbeat = setInterval(() => beat(home, consumer, 'waiting', scope), BEAT_MS);
  // build requests come from builds.json (queued ones, claimed as they're handed over), so none are missed or given twice
  const builds = takesBuilds ? new Builds(home) : null;
  try {
    for (;;) {
      const unread = filterEntries(messages.unread(consumer, { advance: true }), want);
      const questions = questionsToTake(
        home,
        messages,
        consumer,
        scope,
        unread.filter((entry) => entry.type === 'question'),
      );
      let entries = [
        ...questions,
        ...unread.filter((entry) => entry.type !== 'question' && entry.type !== 'fix_request'),
      ];
      if (takesFixes) {
        entries = [...entries, ...fixesToHand(home, consumer, scope)];
      }
      if (builds) {
        entries = [
          ...entries,
          ...builds.toHand(consumer, { repo: opts.repo || null, story: opts.story || null }),
        ];
      }
      if (entries.length) {
        clearInterval(heartbeat);
        noteHanded(
          home,
          questions.map((question) => question.id),
          consumer,
        );
        beat(home, consumer, 'handling', { ...scope, question: entries[0].id });
        printHandOver(entries, opts);
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(heartbeat);
        process.exitCode = 2;
        return;
      }
      await inboxChange(messages.file);
    }
  } finally {
    clearInterval(heartbeat); // an error mustn't leave the heartbeat running
  }
}

function answer(home, cfg, opts) {
  const messages = new Inbox(home);
  const text = opts.file ? readFileSync(opts.file, 'utf8') : opts.text;
  if (!opts.question || !text || text === true) {
    throw new Error('usage: once-upon answer --question ID (--text T | --file F)');
  }
  const question = messages.questions().find((entry) => entry.id === opts.question);
  if (!question) {
    throw new Error(`no question ${opts.question}`);
  }
  // who answered, for the panel: --consumer, else the wait it was handed to
  const handed = readHanded(home)[question.id];
  const answeredBy =
    opts.consumer && opts.consumer !== true ? String(opts.consumer) : handed?.consumer;
  const added = messages.append({
    type: 'answer',
    question: question.id,
    story: question.story,
    text: String(text).trim(),
    ...(answeredBy ? { by: answeredBy } : {}),
  });
  out(added.id);
}

export const inboxCommands = [
  {
    name: 'inbox',
    usage: [
      '  once-upon inbox   [--story ID] [--type question,note,...] [--unread] [--consumer NAME] [--json]',
    ],
    run: inbox,
  },
  {
    name: 'wait',
    usage: [
      '  once-upon wait    [--repo OWNER/NAME | --story ID] [--type question,build_request,fix_request] [--consumer NAME] [--timeout SECONDS] [--json]',
      '                                                                 block until a question, build request or fix request arrives, print it, exit (for a background task);',
      "                                                                 --repo takes both for that repo's stories and PRs; --story (an id, owner/name#N, a PR URL",
      "                                                                 or a PR number here) takes one story's questions, and with build_request its Rebuild",
      "                                                                 requests, ahead of a --repo wait while it's live;",
      "                                                                 a consumer's first wait starts from now, but queued build requests are handed over whenever",
      '                                                                 they were asked',
    ],
    run: wait,
  },
  {
    name: 'answer',
    usage: [
      '  once-upon answer  --question ID (--text T | --file F) [--consumer NAME]',
      '                                                                 answer a question; the panel shows it, and who answered',
    ],
    run: answer,
  },
];
