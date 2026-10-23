/*
 * The stories the bridge can serve: the list, and every PR page's batched
 * status (ready, building or none, read progress, out of date, and who's
 * listening per repo).
 */
import { readMeta } from '../../stories/meta.ts';
import { storyFinishes } from '../../inbox/builds.ts';
import { isRebuild } from '../../stories/rebuild.ts';
import { stateKeyOf } from '../../github/drafts.ts';
import { currentHead, newerCount } from '../../github/freshness.ts';
import { listeningOf } from '../../listeners/listeners.ts';
import { readReads } from '../../stories/reads.ts';
import { prKey } from '@once-upon-a-diff/shared/util/github-paths';
import type { StoryData } from '@once-upon-a-diff/shared/types';
import type { ApiRoute, App, Call } from '../../types.ts';

type StatusCache = NonNullable<App['statusCache']>;

/** One PR's line in status-many's answer (the extension's story-tag.ts reads it). */
interface PrStatus {
  repo: string;
  number: number;
  state: string;
  request?: ReturnType<App['builds']['view']>;
  story?: string;
  story_head?: string | null;
  updating?: boolean;
  update_state?: string | null;
  update_mode?: string | null;
  reads?: { read: number; total: number; next: number | null };
  current_head?: string;
  stale?: boolean | null;
  newer?: number | null;
}

const MAX_PRS = 200;
const STATUS_CACHE_MS = 5000;

/** How much of a story they've read, for the PR-list tag: {read, total, next} (next: the first unread step, or null). */
function readSummary(app: App, id: string) {
  const reads = readReads(app.home, stateKeyOf(id, readMeta(app.stories.dirOf(id) as string)));
  const done = (app.stories.load(id) as StoryData).chapters.map((chapter) => !!reads[chapter.key]);
  const next = done.indexOf(false);
  return {
    read: done.filter(Boolean).length,
    total: done.length,
    next: next < 0 ? null : next + 1,
  };
}

/** One PR's line: its newest story when it has one, else its build request's state. */
function prStatus(
  app: App,
  cache: StatusCache,
  { repo: rawRepo, number: rawNumber }: { repo?: unknown; number?: unknown },
): PrStatus {
  const repo = String(rawRepo || '');
  const number = Number(rawNumber);
  const hits = cache.list.filter(
    (story) =>
      story.kind === 'github' &&
      String(story.repo).toLowerCase() === repo.toLowerCase() &&
      Number(story.number) === number,
  );
  let build = app.builds.view(cache.builds[prKey(repo, number)] || null);
  if (!hits.length) {
    const pending = !!(build && build.status === 'pending');
    return { repo, number, state: pending ? build!.state : 'none', request: build };
  }
  const id = hits.sort((first, second) => Number(second.version) - Number(first.version))[0].id;
  // a PR list or a tag polling status-many settles a build request too (storyFinishes, as publish does)
  if (storyFinishes(build, readMeta(app.stories.dirOf(id) as string).head_oid)) {
    build = app.builds.view(app.builds.done(build.id, { story: id }));
    app.statusCache = null;
  }
  const pending = !!(build && build.status === 'pending');
  // an update or a rebuild of the story there is: the tag says Updating… or Rebuilding…
  const updating = pending && (build!.mode === 'update' || isRebuild(build));
  return {
    repo,
    number,
    state: 'ready',
    story: id,
    story_head: readMeta(app.stories.dirOf(id) as string).head_oid || null,
    updating,
    update_state: updating ? build!.state : null,
    update_mode: updating ? build!.mode : null,
    reads: readSummary(app, id),
  };
}

/** Is each story up to date? (the PR's head, read-only gh, cached 60s; only for PRs that have a story) */
async function addFreshness(result: PrStatus) {
  try {
    const head = await currentHead(result.repo, result.number);
    result.current_head = head;
    result.stale = head !== result.story_head;
  } catch {
    result.stale = null;
  }
  // read, and new commits since: how many, for "Read · 3 new commits · Update"
  if (result.stale && result.reads && result.reads.read) {
    try {
      result.newer = await newerCount(
        result.repo,
        result.story_head as string,
        result.current_head as string,
      );
    } catch {
      result.newer = null;
    }
  }
}

/** PR lists: ready / building / none for many PRs in one call. */
async function statusMany({ app, body, send }: Call) {
  const prs = Array.isArray(body.prs) ? body.prs.slice(0, MAX_PRS) : [];
  if (!app.statusCache || Date.now() - app.statusCache.at > STATUS_CACHE_MS) {
    app.statusCache = { at: Date.now(), list: app.stories.list(), builds: app.builds.all() };
  }
  const cache = app.statusCache;
  const results = prs.map((pr: { repo?: unknown; number?: unknown }) => prStatus(app, cache, pr));
  await Promise.all(
    results.filter((result) => result.state === 'ready' && result.story_head).map(addFreshness),
  );
  // is anyone listening for each repo on the page? (the list's "No session listening for owner/name" notice)
  const repos = [
    ...new Map(results.map((result) => [result.repo.toLowerCase(), result.repo])).values(),
  ];
  const listening = Object.fromEntries(
    repos.map((repo) => [repo, listeningOf(app.home, { repo })]),
  );
  return send(200, { results, listening });
}

export const catalogRoutes: ApiRoute[] = [
  {
    path: '/api/stories',
    method: 'GET',
    handle: ({ app, send }) =>
      send(200, { stories: app.stories.list().map(({ dir, ...story }) => story) }),
  },
  { path: '/api/stories/status-many', method: 'POST', handle: statusMany },
];
