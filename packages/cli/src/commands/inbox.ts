/*
 * The inbox from the terminal: read it (inbox), wait for the next question or
 * build request (wait, the listener a Claude session runs as a background
 * task), and answer a question (answer).
 *
 * `wait` itself is core's listening service (core/src/features/listeners/wait.ts): it returns what it took or why it stopped,
 * and this prints it, line for line what the once-upon-listen skill acts on.
 */
import { readFileSync } from 'node:fs';
import { newId } from '@once-upon-a-diff/core/foundation/ids';
import { Inbox, filterEntries } from '@once-upon-a-diff/core/queues/requests/inbox';
import {
  clearAsking,
  noteAsking,
  readHanded,
  readQaMarks,
} from '@once-upon-a-diff/core/queues/requests/conversation';
import {
  Listening,
  repoAt,
  stoppedEvent,
  stoppedLines,
} from '@once-upon-a-diff/core/features/listeners/service';
import { StoryStore } from '@once-upon-a-diff/core/records/stories/store';
import { readMeta, storyRepo } from '@once-upon-a-diff/core/records/stories/meta';
import { answerRefs } from '@once-upon-a-diff/core/records/stories/validate';

import { out, describe } from '../output.ts';
import { given } from '../options.ts';
import type { Config } from '@once-upon-a-diff/core/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

function inbox(home: string, cfg: Config, opts: CliOpts) {
  const messages = new Inbox(home);
  const entries = filterEntries(
    opts.unread
      ? messages.unread((opts.consumer as string | undefined) || 'default', { advance: true })
      : messages.all(),
    opts,
  );
  for (const entry of entries) {
    out(opts.json ? JSON.stringify(entry) : describe(entry) + '\n');
  }
}

/**
 * --story's story id. It takes the id itself, a PR (owner/name#N or its URL), or a bare PR number in the repo of
 * this checkout. A PR's story is the one the bridge has for it, else the id `once-upon publish` will give it.
 */
export function storyIdOf(
  home: string,
  value: string,
  repoHere: () => string | null = () => repoAt(process.cwd()),
): string {
  return new Listening(home).resolveStory(value, repoHere);
}

/** `once-upon wait`: prints the request it was handed (or why it stopped), and exits 2 when --timeout ran out. */
async function wait(home: string, cfg: Config, opts: CliOpts) {
  const flag = (value: CliOpts[string]) => value as string | true | undefined;
  const outcome = await new Listening(home).wait({
    repo: flag(opts.repo),
    story: flag(opts.story),
    type: flag(opts.type),
    consumer: flag(opts.consumer),
    timeout: flag(opts.timeout),
    noAutoStop: !!opts['no-auto-stop'],
    noRelay: !!opts['no-relay'],
    cwd: process.cwd(),
  });
  if (outcome.kind === 'timeout') {
    process.exitCode = 2;
    return;
  }
  if (outcome.kind === 'stopped') {
    // a wait that stopped itself: the listener says so and doesn't start it again
    if (opts.json) {
      out(JSON.stringify(stoppedEvent(outcome.scope, outcome.reason)));
      return;
    }
    stoppedLines(outcome.scope, outcome.reason).forEach(out);
    return;
  }
  for (const { entry, relay, lines } of outcome.items) {
    if (opts.json) {
      out(
        JSON.stringify(
          relay ? { ...entry, relay: { agent: relay.agent, message: relay.message } } : entry,
        ),
      );
      continue;
    }
    out(describe(entry));
    lines.forEach(out);
    out('');
  }
}

/** The files of a story (a ref's path must be one of them), or undefined when the story can't be read. */
function storyFilesOf(home: string, id: string): string[] | undefined {
  const data = new StoryStore({ home }).load(id);
  return data ? data.files.map((file) => file.rel) : undefined;
}

function answer(home: string, cfg: Config, opts: CliOpts) {
  const messages = new Inbox(home);
  const text = opts.file ? readFileSync(opts.file as string, 'utf8') : opts.text;
  if (!opts.question || !text || text === true) {
    throw new Error('usage: once-upon answer --question ID (--text T | --file F) [--refs R]');
  }
  const question = messages.questions().find((entry) => entry.id === opts.question);
  if (!question) {
    throw new Error(`no question ${opts.question}`);
  }
  // the places the text links to, as `[text](ref:<id>)`
  const refs =
    typeof opts.refs === 'string'
      ? answerRefs(
          JSON.parse(readFileSync(opts.refs, 'utf8')) as unknown,
          String(text),
          storyFilesOf(home, question.story),
        )
      : [];
  // who answered, for the panel: --consumer, else the wait it was handed to
  const handed = readHanded(home)[question.id];
  const answeredBy = given(opts.consumer) ?? handed?.consumer;
  // a question relayed to its story's agent, which is asked again or answered by someone else meanwhile: the late
  // relay doesn't add a second answer
  if (handed?.via && answeredBy === handed.consumer) {
    if (question.answers.length) {
      throw new Error(`${question.id} is already answered: not adding another`);
    }
    if (readQaMarks(home, question.story).dismissed[question.id]) {
      throw new Error(`${question.id} was dismissed: not answering it`);
    }
  }
  const added = messages.append({
    type: 'answer',
    question: question.id,
    story: question.story,
    text: String(text).trim(),
    ...(answeredBy ? { by: answeredBy } : {}),
    ...(refs.length ? { refs } : {}),
  });
  clearAsking(home, question.id);
  out(added.id);
}

/**
 * `once-upon ask --story ID --text T [--voice] [--step N]`: files a question on a story as the panel's Ask box does, so
 * it shows in the panel and routes like one (to the story's agent through its relay, else a listener). The voice session
 * runs it for a question the reviewer said aloud.
 */
function ask(home: string, cfg: Config, opts: CliOpts) {
  const text = typeof opts.text === 'string' ? opts.text.trim() : '';
  if (!opts.story || opts.story === true || !text) {
    throw new Error('usage: once-upon ask --story ID --text "<question>" [--voice] [--step N]');
  }
  const id = storyIdOf(home, String(opts.story));
  const dir = new StoryStore({ home }).dirOf(id);
  if (!dir) {
    throw new Error(`no story ${id}: once-upon list shows them`);
  }
  const meta = readMeta(dir);
  const step = typeof opts.step === 'string' ? Number(opts.step) : NaN;
  const added = new Inbox(home).append({
    type: 'question',
    id: newId('q'),
    story: id,
    kind: meta.kind,
    title: meta.title,
    repo: storyRepo(meta),
    step: Number.isInteger(step) && step >= 0 ? step : null,
    chapter: null,
    file: null,
    text: text.slice(0, 8000),
    ...(opts.voice ? { channel: 'voice' as const } : {}),
  });
  out(added.id);
}

/** A session working on a question says what it is up to, and the panel shows it under the question. */
function asking(home: string, cfg: Config, opts: CliOpts) {
  const note = opts.note;
  if (!opts.question || opts.question === true || !note || note === true) {
    throw new Error('usage: once-upon asking --question ID --note "<few words>" [--consumer NAME]');
  }
  const question = new Inbox(home).questions().find((entry) => entry.id === opts.question);
  if (!question) {
    throw new Error(`no question ${opts.question}`);
  }
  if (question.answers.length) {
    return out(`${question.id} is already answered: stop, someone else has it`);
  }
  if (readQaMarks(home, question.story).dismissed[question.id]) {
    return out(`${question.id} was dismissed: stop, the reviewer dropped it`);
  }
  const session = given(opts.consumer);
  noteAsking(
    home,
    question.id,
    String(note),
    session || readHanded(home)[question.id]?.consumer || null,
  );
  return out(`${question.id}: ${String(note).trim()}`);
}

export const inboxCommands: Command[] = [
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
      '  once-upon wait    [--repo OWNER/NAME | --story ID] [--type question,build_request,fix_request,approved] [--consumer NAME] [--timeout SECONDS] [--no-auto-stop] [--json]',
      '                                                                 block until a question, build request or fix request arrives, print it, exit (for a background task);',
      "                                                                 --repo takes both for that repo's stories and PRs; --story (an id, owner/name#N, a PR URL",
      "                                                                 or a PR number here) takes one story's questions, and with build_request its Rebuild",
      "                                                                 requests, ahead of a --repo wait while it's live;",
      "                                                                 a consumer's first wait starts from now, but queued build requests are handed over whenever",
      '                                                                 they were asked; a --story wait and a --repo wait stop themselves (printing "Stopped listening")',
      '                                                                 once no page has shown the story for story_listener_idle_minutes (10; a background tab still counts);',
      '                                                                 run from the session that owns the agent that built a story (once-upon bind), a question on that story',
      '                                                                 is printed with the SendMessage to send the agent instead of to answer; --no-relay answers it here',
    ],
    run: wait,
  },
  {
    name: 'ask',
    usage: [
      '  once-upon ask     --story ID --text "<question>" [--voice] [--step N]',
      "                                                                 file a question on a story, as the panel's Ask box does (--voice: it was asked aloud)",
    ],
    run: ask,
  },
  {
    name: 'asking',
    usage: [
      '  once-upon asking  --question ID --note "<few words>" [--consumer NAME]',
      '                                                                 say what you are doing on a question (reading a file, writing the answer);',
      '                                                                 the panel shows it live under the question until it is answered',
    ],
    run: asking,
  },
  {
    name: 'answer',
    usage: [
      '  once-upon answer  --question ID (--text T | --file F) [--refs R] [--consumer NAME]',
      '                                                                 answer a question; the panel shows it, and who answered',
      '                                                                 --refs R: a JSON file of [{"id","path","side","start","end"}] the text links to as [text](ref:id)',
    ],
    run: answer,
  },
];
