/*
 * Stories: list what the bridge can serve, make a local story over commits
 * (local), and publish a once-upon folder where the bridge finds it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openArgv } from '../../config/settings.ts';
import { StoryStore } from '../../stories/store.ts';
import { Builds } from '../../inbox/builds.ts';
import {
  AGENT_RE,
  activeBinding,
  clearBinding,
  ownSession,
  readBinding,
  sessionLive,
  writeBinding,
} from '../../inbox/binding.ts';
import { storyIdOf } from './inbox.ts';
import { copyFileAtomic, readJson, writeJsonAtomic } from '../../util/json-file.ts';
import { parseUnifiedDiff } from '../../util/diff.ts';
import { stateKeyOf } from '../../github/drafts.ts';
import { vetRebuild, afterRebuild } from '../../stories/rebuild.ts';
import { createLocalStory, slug } from '../../stories/local-story.ts';
import { storyDirFor } from '../../stories/placement.ts';
import { out } from '../output.ts';
import { portState, serve } from './bridge.ts';
import { localPageUrl } from '../../server/page-key.ts';
import type { Build } from '../../inbox/builds.ts';
import type { Plan } from '../../stories/chapters.ts';
import type { Config } from '../../config/settings.ts';
import type { CliOpts, Command, StoryMeta } from '../../types.ts';

/** A rebuild that's being published: its request, the chapters before and after, and the drafts carried over. */
type Rebuilt = {
  build: Build;
  before: Plan;
  after: Plan;
  counts: { carried: number; unmapped: number };
};

/** once-upon's pr.json: just what publish reads. */
interface PrJson {
  url?: string;
  number?: number;
  title?: string;
  author?: { login?: string } | null;
  headRefOid?: string;
  baseRefOid?: string;
  headRefName?: string;
}

function list(home: string) {
  const store = new StoryStore({ home });
  for (const story of store.list()) {
    out(
      `${story.id}\t${story.kind}\t${story.repo ? `${story.repo}#${story.number}` : ''}\t${story.title}\t${story.dir}`,
    );
  }
}

/** The story's pending rebuild request, or null. */
function pendingRebuild(builds: Builds, id: string, meta: StoryMeta): Build | null {
  const build = builds.rebuildOf(id, meta);
  return build && build.status === 'pending' ? build : null;
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
    const before = readBinding(home, id);
    if (before && clearBinding(home, id)) {
      process.stderr.write(
        `Story ${id}: no longer bound to ${before.agent} (it was built again without --agent)\n`,
      );
    }
    return;
  }
  const session = ownSession();
  writeBinding(home, id, agent, session);
  process.stderr.write(`${bindingLine(home, id, agent, session)}\n`);
}

/** What a new binding says: who relays, or why nothing will. */
function bindingLine(home: string, id: string, agent: string, session: string | null): string {
  if (!session) {
    return `Story ${id}: bound to ${agent}, but no CLAUDE_CODE_SESSION_ID says which session owns it, so nothing will relay (once-upon bind --story ${id} --agent ${agent} --session <id>)`;
  }
  if (!sessionLive(home, session)) {
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
    out(clearBinding(home, id) ? `${id}: unbound` : `${id}: wasn't bound`);
    return;
  }
  const agent = agentOf(opts);
  if (!agent) {
    const bound = readBinding(home, id);
    out(
      bound
        ? `${id}: ${bound.agent}, session ${bound.session || '(unknown)'}, ${activeBinding(home, id) ? 'in use' : 'stale or its session has ended'}`
        : `${id}: not bound`,
    );
    return;
  }
  const session = typeof opts.session === 'string' && opts.session ? opts.session : ownSession();
  writeBinding(home, id, agent, session);
  out(`${id}: ${agent}, session ${session || '(unknown)'}`);
  if (!session || !sessionLive(home, session)) {
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
  const made = createLocalStory({
    home,
    repo: path.resolve(opts.repo as string),
    base: opts.base as string,
    head: (opts.head as string | undefined) || 'HEAD',
    chapters: opts.chapters as string | undefined,
    id: opts.id as string | undefined,
    title: opts.title as string | undefined,
    // the panel's Rebuild asked for these chapters: they must keep what it keeps and tell the whole diff
    vet: ({ id, meta, diff, before, after }) => {
      const build = pendingRebuild(builds, id, meta);
      if (!build) {
        return null;
      }
      const counts = vetRebuild(build, before, after, diff, {
        allowUncovered: !!opts['allow-uncovered'],
      });
      rebuilt = { build, before, after, counts };
      return after;
    },
  });
  if (rebuilt) {
    const note = afterRebuild(home, { id: made.id, stateKey: made.id, ...rebuilt });
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
  out(url);
  if (!opts['no-open']) {
    const [cmd, ...args] = openArgv(url, home);
    execFile(cmd, args, () => {});
  }
}

/** `once-upon page --story ID`: prints (and opens) a local story's page link, with its key. */
function page(home: string, cfg: Config, opts: CliOpts) {
  const id = String(opts.story || '');
  const store = new StoryStore({ home });
  const story = store.list().find((candidate) => candidate.id === id);
  if (!story || story.kind !== 'local') {
    throw new Error(`no local story ${id || '(say --story ID)'}: once-upon list shows them`);
  }
  const url = localPageUrl(Number(opts.port || cfg.port), id, cfg.token);
  out(url);
  const bound = activeBinding(home, id);
  if (bound) {
    process.stderr.write(
      `Built by the agent ${bound.agent}: run once-upon wait --story ${id} in the session that launched it, and its questions go to the agent\n`,
    );
  }
  if (!opts['no-open']) {
    const [cmd, ...args] = openArgv(url, home);
    execFile(cmd, args, () => {});
  }
}

function publish(home: string, cfg: Config, opts: CliOpts) {
  if (!opts.dir) {
    throw new Error('usage: once-upon publish --dir <once-upon folder>');
  }
  const agent = agentOf(opts);
  const source = path.resolve(opts.dir as string);
  const pr = readJson<PrJson>(path.join(source, 'pr.json'), null);
  const repo = pr && pr.url ? pr.url.split('/').slice(3, 5).join('/') : null;
  if (!repo || !pr!.number) {
    throw new Error(`${source} doesn't say which PR it is (no pr.json naming it)`);
  }
  const prJson = pr as PrJson & { number: number }; // named above
  const id = (opts.id as string | undefined) || slug(`${repo.replace('/', '-')}-${prJson.number}`);
  const builds = new Builds(home);
  const meta: StoryMeta = { kind: 'github', repo, number: prJson.number };
  const rebuild = pendingRebuild(builds, id, meta);
  // a rebuild the panel asked for: what was published before, checked against and carried into the new chapters
  let rebuilt: Rebuilt | null = null;
  if (rebuild) {
    const served = new StoryStore({ home }).dirOf(id);
    const before = (served && readJson<Plan>(path.join(served, 'chapters.json'), null)) || {};
    const after = readJson<Plan>(path.join(source, 'chapters.json'), null);
    if (!after || !existsSync(path.join(source, 'pr.diff'))) {
      throw new Error(`${source} needs chapters.json and pr.diff to publish a rebuild`);
    }
    const diff = parseUnifiedDiff(readFileSync(path.join(source, 'pr.diff'), 'utf8'));
    const counts = vetRebuild(rebuild, before, after, diff, {
      allowUncovered: !!opts['allow-uncovered'],
    });
    if (counts.carried || counts.unmapped) {
      writeJsonAtomic(path.join(source, 'chapters.json'), after); // so the next build keeps them
    }
    rebuilt = { build: rebuild, before, after, counts };
  }
  // into the repo's checkout (.once-upon/<id>, kept out of git) when the bridge knows it, else ~/.once-upon/<id>
  const dest = storyDirFor(home, id, { repo });
  for (const name of ['chapters.json', 'file-map.json']) {
    if (existsSync(path.join(source, name))) {
      copyFileAtomic(path.join(source, name), path.join(dest, name));
    }
  }
  writeJsonAtomic(path.join(dest, 'meta.json'), {
    kind: 'github',
    repo,
    number: prJson.number,
    url: prJson.url,
    pr_title: prJson.title || null,
    pr_author: prJson.author?.login || null, // whose PR it is: Fix before push is on only for the viewer's own
    head_oid: prJson.headRefOid || null, // the commit the story was told from
    base_oid: prJson.baseRefOid || null,
    head_ref: prJson.headRefName || null, // the PR's branch, where a fix request's change goes
    source,
    published_at: new Date().toISOString(),
  });
  let note = null;
  if (rebuilt) {
    note = afterRebuild(home, { id, stateKey: stateKeyOf(id, meta), ...rebuilt });
    process.stderr.write(`${note}\n`);
  }
  // the story is here, so a Build story or Update request for the PR is done, and a rebuild with it published again
  builds.settle(repo, prJson.number, {
    story: id,
    head: prJson.headRefOid || null,
    published: true,
    note,
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
    usage: [
      '  once-upon local   --repo DIR --base REF [--head REF] [--chapters FILE] [--id ID] [--title T] [--agent NAME] [--no-open] [--allow-uncovered]',
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
    usage: [
      "  once-upon page    --story ID [--no-open]                      a local story's page link, with the key for that story only",
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
