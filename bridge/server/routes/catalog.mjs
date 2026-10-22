/*
 * The stories the bridge can serve: the list, and every PR page's batched
 * status (ready, building or none, read progress, out of date, and who's
 * listening per repo).
 */
import { readMeta } from '../../stories/meta.mjs';
import { storyFinishes } from '../../inbox/builds.mjs';
import { isRebuild } from '../../stories/rebuild.mjs';
import { stateKeyOf } from '../../github/drafts.mjs';
import { currentHead, newerCount } from '../../github/freshness.mjs';
import { listeningOf } from '../../listeners/listeners.mjs';
import { readReads } from '../../stories/reads.mjs';

const MAX_PRS = 200;
const STATUS_CACHE_MS = 5000;

/** How much of a story they've read, for the PR-list tag: {read, total, next} (next: the first unread step, or null). */
function readSummary(app, id) {
  const reads = readReads(app.home, stateKeyOf(id, readMeta(app.stories.dirOf(id))));
  const done = app.stories.load(id).chapters.map((chapter) => !!reads[chapter.key]);
  const next = done.indexOf(false);
  return {
    read: done.filter(Boolean).length,
    total: done.length,
    next: next < 0 ? null : next + 1,
  };
}

/** One PR's line: its newest story when it has one, else its build request's state. */
function prStatus(app, cache, { repo: rawRepo, number: rawNumber }) {
  const repo = String(rawRepo || '');
  const number = Number(rawNumber);
  const hits = cache.list.filter(
    (story) =>
      story.kind === 'github' &&
      String(story.repo).toLowerCase() === repo.toLowerCase() &&
      Number(story.number) === number,
  );
  let build = app.builds.view(cache.builds[`${repo.toLowerCase()}#${number}`] || null);
  if (!hits.length) {
    const pending = !!(build && build.status === 'pending');
    return { repo, number, state: pending ? build.state : 'none', request: build };
  }
  const id = hits.sort((first, second) => Number(second.version) - Number(first.version))[0].id;
  // a PR list or a tag polling status-many settles a build request too (storyFinishes, as publish does)
  if (storyFinishes(build, readMeta(app.stories.dirOf(id)).head_oid)) {
    build = app.builds.view(app.builds.done(build.id, { story: id }));
    app.statusCache = null;
  }
  const pending = !!(build && build.status === 'pending');
  // an update or a rebuild of the story there is: the tag says Updating… or Rebuilding…
  const updating = pending && (build.mode === 'update' || isRebuild(build));
  return {
    repo,
    number,
    state: 'ready',
    story: id,
    story_head: readMeta(app.stories.dirOf(id)).head_oid || null,
    updating,
    update_state: updating ? build.state : null,
    update_mode: updating ? build.mode : null,
    reads: readSummary(app, id),
  };
}

/** Is each story up to date? (the PR's head, read-only gh, cached 60s; only for PRs that have a story) */
async function addFreshness(result) {
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
      result.newer = await newerCount(result.repo, result.story_head, result.current_head);
    } catch {
      result.newer = null;
    }
  }
}

/** PR lists: ready / building / none for many PRs in one call. */
async function statusMany({ app, body, send }) {
  const prs = Array.isArray(body.prs) ? body.prs.slice(0, MAX_PRS) : [];
  if (!app.statusCache || Date.now() - app.statusCache.at > STATUS_CACHE_MS) {
    app.statusCache = { at: Date.now(), list: app.stories.list(), builds: app.builds.all() };
  }
  const cache = app.statusCache;
  const results = prs.map((pr) => prStatus(app, cache, pr));
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

export const catalogRoutes = [
  {
    path: '/api/stories',
    method: 'GET',
    handle: ({ app, send }) =>
      send(200, { stories: app.stories.list().map(({ dir, ...story }) => story) }),
  },
  { path: '/api/stories/status-many', method: 'POST', handle: statusMany },
];
