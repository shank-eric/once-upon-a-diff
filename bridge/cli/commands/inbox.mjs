/*
 * The inbox from the terminal: read it (inbox), wait for the next question or
 * build request (wait, the listener a Claude session runs as a background
 * task), and answer a question (answer).
 */
import { existsSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { REPO_RE, sameRepo, repoOfCheckout, seenCheckout } from '../../config/repos.mjs';
import { Inbox } from '../../inbox/inbox.mjs';
import { Builds } from '../../inbox/builds.mjs';
import { beat } from '../../listeners/listeners.mjs';
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

/** One listener per repo: its own cursor and heartbeat unless --consumer says otherwise. */
function consumerOf(opts) {
  if (opts.consumer) {
    return opts.consumer;
  }
  return opts.repo ? `repo-${String(opts.repo).toLowerCase().replace('/', '-')}` : 'default';
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

/** Prints what was handed over, with what to run next. */
function printHandOver(entries, opts) {
  for (const entry of entries) {
    if (opts.json) {
      out(JSON.stringify(entry));
      continue;
    }
    out(describe(entry));
    if (entry.type === 'question') {
      out(`Answer with: diff-story answer --question ${entry.id} --text "…"`);
    }
    if (entry.type === 'build_request') {
      out(
        `It's yours (wait claimed it). Write the story: pr-story renders and publishes it, and publishing finishes the request.`,
      );
    }
    if (entry.type === 'build_request' && entry.mode === 'update' && !entry.retell) {
      out(
        `It's an update: follow pr-story's "Since you read it" path from ${entry.since_sha}, unless the PR was rebased past it.`,
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
    throw new Error('usage: diff-story wait --repo owner/name');
  }
  const consumer = consumerOf(opts);
  if (opts.repo) {
    noteCheckout(home, opts.repo);
  }
  const scope = {
    ...(opts.repo ? { repo: String(opts.repo) } : {}),
    ...(opts.story ? { story: String(opts.story) } : {}),
  };
  const want = { ...opts, type: opts.type || 'question,build_request' };
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
  const builds =
    !opts.story && want.type.split(',').includes('build_request') ? new Builds(home) : null;
  try {
    for (;;) {
      let entries = filterEntries(messages.unread(consumer, { advance: true }), want);
      if (builds) {
        entries = [...entries, ...builds.toHand(consumer, { repo: opts.repo || null })];
      }
      if (entries.length) {
        clearInterval(heartbeat);
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
    throw new Error('usage: diff-story answer --question ID (--text T | --file F)');
  }
  const question = messages.questions().find((entry) => entry.id === opts.question);
  if (!question) {
    throw new Error(`no question ${opts.question}`);
  }
  const added = messages.append({
    type: 'answer',
    question: question.id,
    story: question.story,
    text: String(text).trim(),
  });
  out(added.id);
}

export const inboxCommands = [
  {
    name: 'inbox',
    usage: [
      '  diff-story inbox   [--story ID] [--type question,note,...] [--unread] [--consumer NAME] [--json]',
    ],
    run: inbox,
  },
  {
    name: 'wait',
    usage: [
      '  diff-story wait    [--repo OWNER/NAME | --story ID] [--type question,build_request] [--consumer NAME] [--timeout SECONDS] [--json]',
      '                                                                 block until a question or build request arrives, print it, exit (for a background task);',
      "                                                                 --repo takes both for that repo's stories and PRs; a consumer's first wait starts from now,",
      '                                                                 but queued build requests are handed over whenever they were asked',
    ],
    run: wait,
  },
  {
    name: 'answer',
    usage: [
      '  diff-story answer  --question ID (--text T | --file F)          answer a question; the panel shows it',
    ],
    run: answer,
  },
];
