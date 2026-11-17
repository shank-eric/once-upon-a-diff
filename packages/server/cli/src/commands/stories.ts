/*
 * Stories: list what the bridge can serve, make a local story over commits
 * (local), and publish a once-upon folder where the bridge finds it.
 */

import path from 'node:path';
import { openTarget } from '@once-upon-a-diff/foundation/settings';
import { StoryStore } from '@once-upon-a-diff/stories/store';
import { Builds } from '@once-upon-a-diff/state/queues/requests/builds';
import { AGENT_RE, Listening, ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { storyIdOf } from './inbox.ts';

import { afterRebuild } from '@once-upon-a-diff/core/features/publishing/after-rebuild';
import { vetRebuild, vetUpdate } from '@once-upon-a-diff/stories/rebuild';
import { createLocalStory } from '@once-upon-a-diff/stories/local-story';
import { noteTiming } from '@once-upon-a-diff/stories/timings';
import { findingsSummary, localStoryFindings } from '@once-upon-a-diff/stories/story-report';

import { out } from '../output.ts';
import { portState, serve } from '@once-upon-a-diff/core/orchestration/bridge/bridge';
import { localPageUrl } from '@once-upon-a-diff/state/records/page-links/page-key';

import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';
import {
  type Rebuilt,
  pendingRebuild,
  publishPrStory,
} from '@once-upon-a-diff/core/features/publishing/publish';

function list(home: string) {
  const store = new StoryStore({ home });
  for (const story of store.list()) {
    out(
      `${story.id}\t${story.kind}\t${story.repo ? `${story.repo}#${story.number}` : ''}\t${story.title}\t${story.dir}`,
    );
  }
}

/** --agent NAME, checked before a build starts: the named agent that built the story and answers its questions. */
function agentOf(opts: CliOpts): string | null {
  if (opts.agent === undefined) {
    return null;
  }
  if (typeof opts.agent !== 'string' || !AGENT_RE.test(opts.agent)) {
    throw new Error("--agent is the agent's name, like ou-fix-thing (letters, digits, . _ -)");
  }
  return opts.agent;
}

/**
 * Binds the story to its agent, owned by this session (the parent's, for a subagent), and says so, and whether that
 * session is running. A story built without --agent drops an older binding, so a rebuild by someone else doesn't send
 * its questions to the agent that built it before.
 */
function bindStory(home: string, id: string, agent: string | null): void {
  if (!agent) {
    const before = new Listening(home).binding(id);
    if (before && new Listening(home).unbind(id)) {
      process.stderr.write(
        `Story ${id}: no longer bound to ${before.agent} (it was built again without --agent)\n`,
      );
    }
    return;
  }
  const session = ownSession();
  new Listening(home).bind(id, agent, session);
  process.stderr.write(`${bindingLine(home, id, agent, session)}\n`);
}

/** What a new binding says: who relays, or why nothing will. */
function bindingLine(home: string, id: string, agent: string, session: string | null): string {
  if (!session) {
    return `Story ${id}: bound to ${agent}, but no CLAUDE_CODE_SESSION_ID says which session owns it, so nothing will relay (once-upon bind --story ${id} --agent ${agent} --session <id>)`;
  }
  if (!new Listening(home).sessionLive(session)) {
    return `Story ${id}: bound to ${agent}, but session ${session} isn't in Claude Code's session registry as running, so nothing will relay until it is`;
  }
  return `Story ${id}: its questions go to ${agent}, relayed by the session that launched it (once-upon wait there)`;
}

/** `once-upon bind --story ID --agent NAME [--session ID] | --clear`: the story's questions go to the agent that built it. */
function bind(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.story || opts.story === true) {
    throw new Error('usage: once-upon bind --story ID (--agent NAME [--session ID] | --clear)');
  }
  const id = storyIdOf(home, String(opts.story));
  if (!new StoryStore({ home }).dirOf(id)) {
    throw new Error(`no story ${id}: once-upon list shows them`);
  }
  if (opts.clear) {
    out(new Listening(home).unbind(id) ? `${id}: unbound` : `${id}: wasn't bound`);
    return;
  }
  const agent = agentOf(opts);
  if (!agent) {
    const bound = new Listening(home).binding(id);
    out(
      bound
        ? `${id}: ${bound.agent}, session ${bound.session || '(unknown)'}, ${new Listening(home).activeBinding(id) ? 'in use' : 'stale or its session has ended'}`
        : `${id}: not bound`,
    );
    return;
  }
  const session = typeof opts.session === 'string' && opts.session ? opts.session : ownSession();
  new Listening(home).bind(id, agent, session);
  out(`${id}: ${agent}, session ${session || '(unknown)'}`);
  if (!session || !new Listening(home).sessionLive(session)) {
    process.stderr.write(`${bindingLine(home, id, agent, session)}\n`);
  }
}

async function local(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.repo || !opts.base) {
    throw new Error('usage: once-upon local --repo DIR --base REF [--head REF] [--chapters FILE]');
  }
  const agent = agentOf(opts);
  const builds = new Builds(home);
  let rebuilt = null as Rebuilt | null; // set by vet, when it publishes a rebuild
  let updated = null as string | null; // set by vet, when it publishes a local story's Update: the story's id
  let replaced = null as string | null; // set by vet, when a plain re-tell stands in for a pending Update: the story's id
  const started = performance.now();
  // how long the telling took, in the story's scratch folder beside story.mjs's own timings; a refused telling is
  // marked failed, as story.mjs marks its own
  const noteLocal = (extra: Record<string, unknown>) => {
    if (opts.chapters) {
      noteTiming(path.dirname(path.resolve(opts.chapters as string)), {
        command: 'local',
        ms: performance.now() - started,
        ...extra,
      });
    }
  };
  let made: ReturnType<typeof createLocalStory>;
  try {
    made = createLocalStory({
      home,
      repo: path.resolve(opts.repo as string),
      base: opts.base as string,
      head: (opts.head as string | undefined) || 'HEAD',
      chapters: opts.chapters as string | undefined,
      id: opts.id as string | undefined,
      title: opts.title as string | undefined,
      allowMissing: !!opts['allow-missing'],
      allowUncovered: !!opts['allow-uncovered'],
      // the panel's Rebuild asked for these chapters: they must keep what it keeps and tell the whole diff
      vet: ({ id, meta, diff, before, after }) => {
        const build = pendingRebuild(builds, id, meta);
        if (!build) {
          // an Update of this story waits: when the chapters lead with a "Since you read it" chapter they are vetted as the
          // Update (that chapter and the old ones as they were); any other telling is a plain re-tell, which replaces the Update
          if (builds.updateOf(id)) {
            if (!(after.chapters as { since?: unknown }[])[0]?.since) {
              replaced = id;
              return null;
            }
            vetUpdate(before, after, meta.head_oid, diff, {
              allowUncovered: !!opts['allow-uncovered'],
            });
            updated = id;
            return after;
          }
          return null;
        }
        const counts = vetRebuild(build, before, after, diff, {
          allowUncovered: !!opts['allow-uncovered'],
        });
        rebuilt = { build, before, after, counts };
        return after;
      },
    });
  } catch (err) {
    noteLocal({ failed: true });
    throw err;
  }
  noteLocal({ chapters: made.chapters, expanded: made.expanded });
  if (rebuilt) {
    const note = afterRebuild(home, { id: made.id, stateKey: made.id, ...rebuilt });
    builds.settleStory(made.id, { note });
    process.stderr.write(`${note}\n`);
  }
  if (replaced) {
    const note = 'Re-told from scratch, which replaces the Update that was asked for.';
    builds.settleStory(made.id, { note });
    process.stderr.write(`${note}\n`);
  }
  if (updated) {
    const note = 'Added a "Since you read it" chapter for what changed since it was read.';
    builds.settleStory(made.id, { note });
    process.stderr.write(`${note}\n`);
  }
  bindStory(home, made.id, agent);
  process.stderr.write(
    `Story ${made.id}: ${made.files} files, ${made.chapters} chapters (${made.dir})\n`,
  );
  if (made.ambiguous.length) {
    process.stderr.write(
      `  ${opts.head} is the tip of ${made.ambiguous.join(', ')}, so the story has no branch (no Create pull request); name one with --head\n`,
    );
  }
  if (made.unplaced.length) {
    process.stderr.write(
      `  ${made.unplaced.length} files aren't in a chapter; they show in a last "Not in a chapter yet" step\n`,
    );
  }
  if (made.unknown.length) {
    process.stderr.write(
      `  ${made.unknown.length} chapter files aren't in the diff and are skipped: ${made.unknown.join(', ')}\n`,
    );
  }
  if (opts.chapters) {
    // the quality rules the publish does not refuse (story.mjs check lists them); the exit status is not touched
    for (const line of findingsSummary(() => localStoryFindings(made.dir))) {
      process.stderr.write(`${line}\n`);
    }
  }
  const port = Number(opts.port || cfg.port);
  const url = localPageUrl(port, made.id, cfg.token);
  const state = await portState(home, port, cfg.token);
  const taken = `Port ${port} is held by something that isn't this home's bridge (another program, or a bridge for another home). Free it, or pass --port N`;
  if (state === 'old-token') {
    process.stderr.write(
      `The bridge on port ${port} started before the token changed, so this link won't open. Restart it: stop the running once-upon serve, then run it again\n`,
    );
  } else if (state === 'foreign' && !opts['no-serve']) {
    throw new Error(taken);
  } else if (state === 'foreign') {
    process.stderr.write(`${taken}\n`);
  } else if (state === 'free' && !opts['no-serve']) {
    await serve(home, cfg, { ...opts, port });
  } else if (state === 'free') {
    process.stderr.write(`No bridge on port ${port}. Start one with: once-upon serve\n`);
  }
  out(printedLink(url, opts));
  if (!opts['no-open']) {
    openTarget(url, home);
  }
}

/**
 * The link to print. What a command prints lands in a session's report and transcript, so the key stays out of it: the link
 * prints without its #key, and the page has remembered the key from the keyed link the command opened. The keyed link prints
 * on a terminal or with --with-key (to open elsewhere, or in a browser profile that has not opened one yet).
 */
function printedLink(url: string, opts: CliOpts): string {
  return process.stdout.isTTY || opts['with-key'] ? url : url.split('#')[0];
}

/** `once-upon page --story ID`: prints a local story's page link (keyless unless on a terminal or --with-key) and opens it with its key. */
function page(home: string, cfg: Config, opts: CliOpts) {
  const id = String(opts.story || '');
  const store = new StoryStore({ home });
  const story = store.list().find((candidate) => candidate.id === id);
  if (!story || story.kind !== 'local') {
    throw new Error(`no local story ${id || '(say --story ID)'}: once-upon list shows them`);
  }
  const url = localPageUrl(Number(opts.port || cfg.port), id, cfg.token);
  out(printedLink(url, opts));
  const bound = new Listening(home).activeBinding(id);
  if (bound) {
    process.stderr.write(
      `Built by the agent ${bound.agent}: run once-upon wait --story ${id} in the session that launched it, and its questions go to the agent\n`,
    );
  }
  if (!opts['no-open']) {
    openTarget(url, home);
  }
}

function publish(home: string, _cfg: Config, opts: CliOpts) {
  if (!opts.dir) {
    throw new Error('usage: once-upon publish --dir <once-upon folder>');
  }
  const agent = agentOf(opts);
  const { id, dest } = publishPrStory(home, {
    dir: opts.dir as string,
    id: opts.id as string | undefined,
    allowUncovered: !!opts['allow-uncovered'],
    onNote: (note) => process.stderr.write(`${note}\n`),
  });
  bindStory(home, id, agent);
  out(dest);
}

export const storyCommands: Command[] = [
  {
    name: 'list',
    usage: [
      '  once-upon list                                                stories the bridge can serve',
    ],
    run: list,
  },
  {
    name: 'local',
    needsConfig: true,
    usage: [
      '  once-upon local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--agent NAME] [--no-open] [--with-key] [--allow-uncovered] [--allow-missing]',
      '                                                                 story over local commits, served at /local/<id>/; with a Rebuild',
      '                                                                 pending, the chapters must keep what it keeps and tell every file and hunk',
    ],
    run: local,
  },
  {
    name: 'bind',
    usage: [
      '  once-upon bind    --story ID (--agent NAME [--session ID] | --clear)   the agent that built a story answers its questions: the session that owns',
      "                                                                 the agent (a subagent has its parent's, from CLAUDE_CODE_SESSION_ID) relays them with SendMessage",
      '                                                                 when it waits for the story; publish and local take --agent NAME to bind as they build',
    ],
    run: bind,
  },
  {
    name: 'page',
    needsConfig: true,
    usage: [
      "  once-upon page    --story ID [--no-open] [--with-key]         a local story's page link (keyless; --with-key or a terminal prints its key too)",
    ],
    run: page,
  },
  {
    name: 'publish',
    usage: [
      '  once-upon publish --dir DIR [--id ID] [--agent NAME] [--allow-uncovered]     copy a once-upon folder into <checkout>/.once-upon/<owner>-<repo>-<N>/ (or ~/.once-upon/)',
      "                                                                 and finish the PR's build request; a Rebuild must keep what it keeps, tell",
      '                                                                 every file and hunk, and keeps the drafts the new chapters dropped',
    ],
    run: publish,
  },
];
