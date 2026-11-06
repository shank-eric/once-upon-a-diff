/*
 * The stories the bridge can serve: the list, and every PR page's batched
 * status (ready, building or none, read progress, out of date, and who's
 * listening per repo).
 */
import { readMeta, stateKeyOf } from '@once-upon-a-diff/core/records/stories/meta';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { parseBody } from '../validate.ts';
import { storyFinishes } from '@once-upon-a-diff/core/queues/requests/builds';
import { isRebuild } from '@once-upon-a-diff/core/records/stories/rebuild';
import { currentHead, newerCount } from '@once-upon-a-diff/core/features/review/freshness';
import { Listening } from '@once-upon-a-diff/core/features/listeners/service';
import { readReads } from '@once-upon-a-diff/core/records/stories/reads';
import { unreadAnswers } from '@once-upon-a-diff/core/queues/requests/conversation';
import { prKey } from '@once-upon-a-diff/domain/pr-key';
import type { StoryData } from '@once-upon-a-diff/contracts/types';
import type { ApiRoute, App, Call } from '../types.ts';

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
  /** deprecated: sent for an older extension, which reads it (see update_kind) */
  update_mode?: string | null;
  update_kind?: 'update' | 'rebuild' | null;
  reads?: { read: number; total: number; next: number | null };
  /** questions of the story whose answer the reviewer hasn't read */
  unread_answers?: number;
  current_head?: string;
  stale?: boolean | null;
  newer?: number | null;
}

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
  { repo, number }: { repo: string; number: number },
  unread: Map<string, number>,
): PrStatus {
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
  const storyHead = readMeta(app.stories.dirOf(id) as string).head_oid || null;
  if (storyFinishes(build, storyHead)) {
    // settle checks again under the lock: the cached request may have been finished or replaced since
    build = app.builds.view(app.builds.settle(repo, number, { story: id, head: storyHead }));
    app.statusCache = null;
  }
  const pending = !!(build && build.status === 'pending');
  // an update or a rebuild of the story there is: the tag says Updating… or Rebuilding…
  const updating = pending && (build!.mode === 'update' || isRebuild(build));
  const kind = isRebuild(build) ? 'rebuild' : 'update';
  return {
    repo,
    number,
    state: 'ready',
    story: id,
    story_head: storyHead,
    updating,
    update_state: updating ? build!.state : null,
    update_mode: updating ? build!.mode : null,
    update_kind: updating ? kind : null,
    reads: readSummary(app, id),
    unread_answers: unread.get(id) || 0,
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
  const { prs } = parseBody('statusMany', body);
  if (!app.statusCache || Date.now() - app.statusCache.at > STATUS_CACHE_MS) {
    app.statusCache = { at: Date.now(), list: app.stories.list(), builds: app.builds.all() };
  }
  const cache = app.statusCache;
  const unread = unreadAnswers(app.home, app.inbox);
  const results = prs.map((pr) => prStatus(app, cache, pr, unread));
  await Promise.all(
    results.filter((result) => result.state === 'ready' && result.story_head).map(addFreshness),
  );
  // is anyone listening for each repo on the page? (the list's "No session listening for owner/name" notice)
  const repos = [
    ...new Map(results.map((result) => [result.repo.toLowerCase(), result.repo])).values(),
  ];
  const listening = Object.fromEntries(
    repos.map((repo) => [repo, new Listening(app.home).listening({ repo })]),
  );
  return send(200, { results, listening });
}

export const catalogRoutes: ApiRoute[] = [
  {
    route: ROUTES.stories,
    handle: ({ app, send }) =>
      send(200, { stories: app.stories.list().map(({ dir, ...story }) => story) }),
  },
  { route: ROUTES.statusMany, handle: statusMany },
];
