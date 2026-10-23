/*
 * One story: its data (GET /api/stories/<id>), its version (the pages poll it
 * to redraw when chapters.json changes), its pulse (version plus what else the
 * panel polls for), the panel's saved state (ui), where the reviewer is
 * (position), whether the story is up to date (freshness), and its Rebuild
 * (rebuild: ask for one, or how the last one stands).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPrefs } from '../../config/settings.ts';
import { seenCheckout } from '../../config/repos.ts';
import { freshness } from '../../github/freshness.ts';
import { readMarks, stateKeyOf } from '../../github/drafts.ts';
import { listeningOf } from '../../listeners/listeners.ts';
import { noteSeen } from '../../listeners/auto-stop.ts';
import { refreshLocal } from '../../stories/local-diff.ts';
import { storyVersion, localVersion } from '../../stories/meta.ts';
import { HttpError, clipText, toInt } from '../request.ts';
import { questionsOf } from './questions.ts';
import { fixesView } from '../../inbox/fixes.ts';
import { workingOf } from '../../stories/working.ts';
import type { RebuildView, StoryData } from '@once-upon-a-diff/shared/types';
import type { App, Call, LocalMeta, ServedStory, StoryRoute } from '../../types.ts';

function load({ app, send }: Call, story: ServedStory) {
  if (story.meta.kind === 'local' && story.ref.repo) {
    seenCheckout(app.home, story.ref.repo, story.meta.repo_path); // where to tell a listener to work from
  }
  return send(200, app.stories.load(story.id));
}

/** Changes when chapters.json does, and for a local story when its diff or Hide whitespace does. */
function versionOf(app: App, story: ServedStory): string {
  if (story.meta.kind === 'local') {
    refreshLocal(story.dir, readMetaFile(story.dir));
    return localVersion(story.dir, readPrefs(app.home));
  }
  return storyVersion(story.dir);
}

// the local page's own poll while its panel is closed: a page shows the story
function version({ app, send }: Call, story: ServedStory) {
  noteSeen(app.stories, story.id);
  return send(200, { version: versionOf(app, story) });
}

const revOf = (value: unknown) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * One cheap call the panel can poll in place of version, questions, status and drafts:
 * when a field changes, it fetches that one. questions_rev covers answers, dismissals,
 * collapses and handovers. drafts_rev covers the drafts and the
 * reviewer's marks, not what gh finds on GitHub, which the panel still checks on its own. fixes_rev covers
 * fix before push, and working_rev the "being changed" marks.
 */
function pulse({ app, send }: Call, story: ServedStory) {
  noteSeen(app.stories, story.id); // a panel shows the story (for a story listener's natural end)
  const questions = questionsOf(app, story).map((question) => [
    question.id,
    question.answers.length,
    question.dismissed,
    question.collapsed,
    question.handed_to,
  ]);
  const listening = listeningOf(app.home, { repo: story.ref.repo, story: story.id });
  const comments = (app.stories.load(story.id) as StoryData).chapters.map(
    (chapter) => chapter.comments || [],
  );
  const marks = readMarks(app.home, stateKeyOf(story.id, story.meta));
  return send(200, {
    version: versionOf(app, story),
    questions_rev: revOf(questions),
    drafts_rev: revOf([comments, marks]),
    listening: listening.ok,
    // who answers this story's questions, so the panel redraws when a story listener takes over from the repo's
    answering: listening.answering ? listening.answering.consumer : null,
    rebuild: rebuildView(app, story),
    // fix before push (notes, Auto-send, requests and who'd get a send) and "being changed" marks
    fixes_rev: revOf(fixesView(app.home, app.stories, story)),
    working_rev: revOf(workingOf(app.home, story.id).marks),
  });
}

/** The story's Rebuild as the panel shows it: {id, mode, from_step, state, requested_at, done_at, note}, or null. */
function rebuildView(app: App, story: ServedStory): (RebuildView & { id: string }) | null {
  const build = app.builds.view(app.builds.rebuildOf(story.id, story.meta));
  if (!build) {
    return null;
  }
  return {
    id: build.id,
    mode: build.mode as RebuildView['mode'], // rebuildOf finds only rebuilds
    from_step: build.from_step || null,
    state: build.state as RebuildView['state'],
    requested_at: build.requested_at,
    claimed_by: build.state === 'building' ? build.claimed_by || null : null,
    done_at: build.done_at || null,
    note: build.note || null,
  };
}

/**
 * GET: rebuildView. POST {mode: 'rebuild'|'rebuild_from', from_step, guidance}: the panel's Rebuild story or Rebuild
 * from here, a build request a listener hands to a Claude session. A request already being built comes back as it is.
 */
function rebuild({ app, req, body, send }: Call, story: ServedStory) {
  if (req.method === 'POST') {
    const chapters = ((app.stories.load(story.id) as StoryData).chapters || []).filter(
      (chapter) => !chapter.auto,
    );
    if (!chapters.length) {
      throw new HttpError(400, 'the story has no chapters to rebuild');
    }
    app.statusCache = null;
    app.builds.requestRebuild({
      story: story.id,
      meta: story.meta,
      mode: String(body.mode || ''),
      from_step: toInt(body.from_step),
      guidance: clipText(body.guidance, 4000),
      chapters: chapters.length,
      story_dir: story.dir,
      requested_at: body.requested_at,
    });
  }
  return send(200, { rebuild: rebuildView(app, story) });
}

/** meta.json as written, for the local diff refresh (readMeta fills in defaults). Throws when it's missing or broken. */
const readMetaFile = (dir: string): LocalMeta =>
  JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));

function panelState({ app, req, body, send }: Call, story: ServedStory) {
  if (req.method === 'GET') {
    return send(200, app.stories.readState(story.id, 'ui.json', {}));
  }
  const saved = {
    n: toInt(body.n) ?? 0,
    all: !!body.all,
    collapsed: !!body.collapsed,
    width: toInt(body.width),
    hidden: !!body.hidden,
    filesOpen: !!body.filesOpen,
    chatOpen: !!body.chatOpen,
    chatHeight: toInt(body.chatHeight),
    at: new Date().toISOString(),
  };
  app.stories.writeState(story.id, 'ui.json', saved);
  return send(200, saved);
}

function position({ app, body, send }: Call, story: ServedStory) {
  const where = {
    step: toInt(body.step),
    chapter: clipText(body.chapter, 300),
    file: clipText(body.file, 1000),
    url: clipText(body.url, 2000),
  };
  app.stories.writeState(story.id, 'position.json', { ...where, at: new Date().toISOString() });
  return send(200, { ok: true });
}

async function storyFreshness({ app, send }: Call, story: ServedStory) {
  const { meta } = story;
  const lastBuild =
    meta.kind === 'github' && meta.repo && meta.number
      ? app.builds.get(meta.repo, meta.number)
      : null;
  return send(
    200,
    await freshness(meta, (app.stories.load(story.id) as StoryData).chapters, { lastBuild }),
  );
}

export const storyRoutes: StoryRoute[] = [
  { what: '', method: 'GET', handle: load },
  { what: 'version', method: 'GET', handle: version },
  { what: 'pulse', method: 'GET', handle: pulse },
  { what: 'ui', handle: panelState },
  { what: 'position', method: 'POST', handle: position },
  { what: 'freshness', method: 'GET', handle: storyFreshness },
  { what: 'rebuild', handle: rebuild },
];
