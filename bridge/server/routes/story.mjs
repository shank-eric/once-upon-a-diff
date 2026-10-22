/*
 * One story: its data (GET /api/stories/<id>), its version (the pages poll it
 * to redraw when chapters.json changes), its pulse (version plus what else the
 * panel polls for), the panel's saved state (ui), where the reviewer is
 * (position) and whether the story is up to date (freshness).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readPrefs } from '../../config/settings.mjs';
import { seenCheckout } from '../../config/repos.mjs';
import { freshness } from '../../github/freshness.mjs';
import { readMarks, stateKeyOf } from '../../github/drafts.mjs';
import { listeningOf } from '../../listeners/listeners.mjs';
import { refreshLocal } from '../../stories/local-diff.mjs';
import { storyVersion, localVersion } from '../../stories/meta.mjs';
import { clipText, toInt } from '../request.mjs';
import { questionsOf } from './questions.mjs';

function load({ app, send }, story) {
  if (story.meta.kind === 'local' && story.ref.repo) {
    seenCheckout(app.home, story.ref.repo, story.meta.repo_path); // where to tell a listener to work from
  }
  return send(200, app.stories.load(story.id));
}

/** Changes when chapters.json does, and for a local story when its diff or Hide whitespace does. */
function versionOf(app, story) {
  if (story.meta.kind === 'local') {
    refreshLocal(story.dir, readMetaFile(story.dir));
    return localVersion(story.dir, readPrefs(app.home));
  }
  return storyVersion(story.dir);
}

const version = ({ app, send }, story) => send(200, { version: versionOf(app, story) });

const revOf = (value) =>
  createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * One cheap call the panel can poll in place of version, questions, status and drafts:
 * when a field changes, it fetches that one. questions_rev covers answers, dismissals,
 * collapses and handovers. drafts_rev covers the drafts and the
 * reviewer's marks, not what gh finds on GitHub, which the panel still checks on its own.
 */
function pulse({ app, send }, story) {
  const questions = questionsOf(app, story).map((question) => [
    question.id,
    question.answers.length,
    question.dismissed,
    question.collapsed,
    question.handed_to,
  ]);
  const listening = listeningOf(app.home, { repo: story.ref.repo, story: story.id });
  const comments = app.stories.load(story.id).chapters.map((chapter) => chapter.comments || []);
  const marks = readMarks(app.home, stateKeyOf(story.id, story.meta));
  return send(200, {
    version: versionOf(app, story),
    questions_rev: revOf(questions),
    drafts_rev: revOf([comments, marks]),
    listening: listening.ok,
    // who answers this story's questions, so the panel redraws when a story listener takes over from the repo's
    answering: listening.answering ? listening.answering.consumer : null,
  });
}

/** meta.json as written, for the local diff refresh (readMeta fills in defaults). Throws when it's missing or broken. */
const readMetaFile = (dir) => JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));

function panelState({ app, req, body, send }, story) {
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
    at: new Date().toISOString(),
  };
  app.stories.writeState(story.id, 'ui.json', saved);
  return send(200, saved);
}

function position({ app, body, send }, story) {
  const where = {
    step: toInt(body.step),
    chapter: clipText(body.chapter, 300),
    file: clipText(body.file, 1000),
    url: clipText(body.url, 2000),
  };
  app.stories.writeState(story.id, 'position.json', { ...where, at: new Date().toISOString() });
  return send(200, { ok: true });
}

async function storyFreshness({ app, send }, story) {
  const { meta } = story;
  const lastBuild =
    meta.kind === 'github' && meta.repo && meta.number
      ? app.builds.get(meta.repo, meta.number)
      : null;
  return send(200, await freshness(meta, app.stories.load(story.id).chapters, { lastBuild }));
}

export const storyRoutes = [
  { what: '', method: 'GET', handle: load },
  { what: 'version', method: 'GET', handle: version },
  { what: 'pulse', method: 'GET', handle: pulse },
  { what: 'ui', handle: panelState },
  { what: 'position', method: 'POST', handle: position },
  { what: 'freshness', method: 'GET', handle: storyFreshness },
];
