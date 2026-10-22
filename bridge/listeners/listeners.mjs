/**
 * Is everything connected? Listener heartbeats, and the status the panel's light
 * shows.
 *
 * Heartbeats: `once-upon wait` writes <home>/listeners/<consumer>.json every
 * ≈5s while it waits ({state: 'waiting'}), and once more when it hands a
 * question over ({state: 'handling'}), because the Claude session is busy
 * answering until it starts the next wait. A listener counts as live when a
 * waiting beat is under 15s old and its process is alive, or a handling beat
 * is under 10 minutes old. A beat also says what the wait covers: {repo} for
 * `wait --repo`, {story} for `wait --story`, neither for a wait that takes everything, and {fixes: true} when
 * it takes fix requests (../inbox/fixes.mjs).
 * A story's own listener answers its questions ahead of a repo's (answeringOf).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sameRepo, checkoutFor, tilde } from '../config/repos.mjs';

export const WAITING_FRESH_MS = 15000;
export const HANDLING_FRESH_MS = 10 * 60 * 1000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

export function beat(home, consumer, state = 'waiting', extra = {}) {
  const dir = path.join(home, 'listeners');
  mkdirSync(dir, { recursive: true });
  const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  writeFileSync(
    path.join(dir, `${safe}.json`),
    JSON.stringify({ consumer, pid: process.pid, state, at: new Date().toISOString(), ...extra }),
  );
}

/**
 * A session still at work on what its wait handed it (`once-upon working`) keeps its handling beat fresh, so its
 * listener stays live past HANDLING_FRESH_MS. A waiting beat is left alone: that wait writes its own.
 */
export function touchHandling(home, consumer) {
  const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(home, 'listeners', `${safe}.json`);
  try {
    const last = JSON.parse(readFileSync(file, 'utf8'));
    if (last.state === 'handling') {
      writeFileSync(file, JSON.stringify({ ...last, at: new Date().toISOString() }));
    }
  } catch {
    /* no listener by that name */
  }
}

/** [{consumer, state, at, age_s, live}] newest first. */
export function listeners(home, now = Date.now()) {
  const dir = path.join(home, 'listeners');
  if (!existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const name of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    try {
      const beat = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
      const age = now - Date.parse(beat.at);
      const live =
        beat.state === 'handling'
          ? age < HANDLING_FRESH_MS
          : age < WAITING_FRESH_MS && alive(beat.pid);
      out.push({
        consumer: beat.consumer,
        state: beat.state,
        at: beat.at,
        age_s: Math.round(age / 1000),
        live,
        question: beat.question || null,
        repo: beat.repo || null,
        story: beat.story || null,
        builds: !!beat.builds,
        fixes: !!beat.fixes,
      });
    } catch {
      /* a half-written beat; skip it */
    }
  }
  return out.sort((first, second) => first.age_s - second.age_s);
}

/** Is cmd runnable as typed (a path that exists, or a name on PATH)? */
export function onPath(cmd) {
  if (!cmd) {
    return false;
  }
  if (cmd.includes('/')) {
    return existsSync(cmd);
  }
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/once-upon.mjs');
const shq = (word) =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(word) ? word : `'${String(word).replace(/'/g, "'\\''")}'`;
let cliCache = null;
/** How to run the CLI from a shell: `once-upon` when it's on PATH, else node and the script by full path. */
export function cliCommand(found = cliCache ?? (cliCache = onPath('once-upon'))) {
  return found ? 'once-upon' : `${shq(process.execPath)} ${shq(BIN)}`;
}

/**
 * "Copy prompt for Claude": one line for the once-upon-listen skill (skills/once-upon-listen), naming the repo
 * (or the one story), plus the long form for a session without the skill. A story's wait takes its questions and
 * its Rebuild requests.
 */
export function listenPrompt(
  { repo = null, story = null, checkout = null } = {},
  cli = cliCommand(),
) {
  let arg = '';
  let waitFor = '';
  if (repo) {
    arg = ` ${repo}`;
    waitFor = ` --repo ${repo}`;
  } else if (story) {
    arg = ` --story ${story}`;
    waitFor = ` --story ${story} --type question,build_request,fix_request`;
  }
  const wait = `${cli} wait${waitFor}`;
  let where = 'Run';
  if (checkout) {
    where = `In ${tilde(checkout)}, run`;
  } else if (repo) {
    where = `In your checkout of ${repo}, run`;
  }
  let builds = '';
  if (repo) {
    builds = `For a build request, build the story with /once-upon <PR url>; publishing it finishes the request (run \`${cli} done <id> --failed\` if it can't be built). `;
  } else if (story) {
    builds = `For a build request (the panel's Rebuild), rebuild the story with /once-upon as its "Rebuilding a story" section says; publishing it finishes the request. `;
  }
  const fixes =
    `For a fix request, make one change that addresses its notes, commit it as my repo rules say, never push, and run \`${cli} fixed --request <id> --sha <sha>\`; ` +
    `say which files you're changing first with \`${cli} working --story <story> --files <a,b>\`. `;
  return {
    repo,
    story: repo ? null : story,
    checkout: checkout ? tilde(checkout) : null,
    prompt: `/once-upon-listen${arg}`,
    command: wait,
    details:
      `${where} \`${wait}\` as a background task, and start it again each time it exits. For a question, answer it and run \`${cli} answer --question <id> --text "<answer>"\`. ` +
      `${builds}${fixes}Keep going until I say stop.`,
  };
}

/**
 * Who answers a story's questions now: a live listener for that story, else one for its repo, else a wait that
 * takes everything. {consumer, scope: 'story'|'repo'|'all'} or null. once-upon wait routes them the same way.
 */
export function answeringOf(live, { repo = null, story = null } = {}) {
  const forStory = story && live.find((listener) => listener.story === story);
  if (forStory) {
    return { consumer: forStory.consumer, scope: 'story' };
  }
  const forRepo = repo && live.find((listener) => listener.repo && sameRepo(listener.repo, repo));
  if (forRepo) {
    return { consumer: forRepo.consumer, scope: 'repo' };
  }
  const forAll = live.find((listener) => !listener.repo && !listener.story);
  return forAll ? { consumer: forAll.consumer, scope: 'all' } : null;
}

/**
 * Is a Claude session listening for this page, and the prompt that starts one. A wait with no --repo or --story
 * covers everything, a --repo wait covers that repo's stories and PRs, and a --story wait that story.
 */
export function listeningOf(home, { repo = null, story = null } = {}) {
  const all = listeners(home);
  const covers = (listener) =>
    (!listener.repo && !listener.story) ||
    (repo && sameRepo(listener.repo, repo)) ||
    (story && listener.story === story);
  const live = all.filter((listener) => listener.live && covers(listener));
  const storyPrompt = story ? listenPrompt({ story }) : null;
  return {
    ok: live.length > 0,
    consumers: live.map((listener) => ({
      consumer: listener.consumer,
      state: listener.state,
      age_s: listener.age_s,
      repo: listener.repo,
      story: listener.story,
    })),
    answering: answeringOf(live, { repo, story }),
    last_seen: all[0] ? all[0].at : null,
    start: repo
      ? `In Claude Code, in your checkout of ${repo}: /once-upon-listen ${repo}`
      : 'In Claude Code: /once-upon-listen',
    ...listenPrompt({ repo, story: repo ? null : story, checkout: checkoutFor(home, repo) }),
    // "Copy prompt for this story", for the session that built it
    story_prompt: storyPrompt
      ? { prompt: storyPrompt.prompt, command: storyPrompt.command, details: storyPrompt.details }
      : null,
  };
}

/** What the panel's status light shows. */
export function statusOf({ home, version, story, repo = null, extensionSeen }) {
  return {
    bridge: { ok: true, version },
    story: story === undefined ? null : { ok: !!story, id: story || null },
    listening: listeningOf(home, { repo, story: story || null }),
    repo,
    extension_seen: extensionSeen || null,
  };
}
