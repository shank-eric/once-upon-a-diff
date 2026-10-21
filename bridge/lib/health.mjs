/**
 * Is everything connected? Listener heartbeats, the status the panel's light
 * shows, and the optional auto-answer runner.
 *
 * Heartbeats: `diff-story wait` writes <home>/listeners/<consumer>.json every
 * ≈5s while it waits ({state: 'waiting'}), and once more when it hands a
 * question over ({state: 'handling'}), because the Claude session is busy
 * answering until it starts the next wait. A listener counts as live when a
 * waiting beat is under 15s old and its process is alive, or a handling beat
 * is under 10 minutes old. A beat also says what the wait covers: {repo} for
 * `wait --repo`, {story} for `wait --story`, neither for a wait that takes everything.
 *
 * autoAnswer (off unless config.json turns it on) runs a command for each new
 * question. It's an argv array, never run through a shell. {question},
 * {context}, {story} and {id} in its arguments are replaced. {context} is a
 * JSON file with the story's overview, the asked-about chapter's narrative
 * and files, and that chapter's diff when the bridge has one. Whatever the
 * command prints to stdout, if it exits 0, becomes the answer:
 *   "autoAnswer": {"enabled": true, "command": ["claude", "-p", "Answer this review question using {context}: {question}"]}
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff } from './diff.mjs';
import { sameRepo, checkoutFor, tilde } from './repos.mjs';

export const WAITING_FRESH_MS = 15000;
export const HANDLING_FRESH_MS = 10 * 60 * 1000;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function beat(home, consumer, state = 'waiting', extra = {}) {
  const dir = path.join(home, 'listeners');
  mkdirSync(dir, { recursive: true });
  const safe = String(consumer || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  writeFileSync(path.join(dir, `${safe}.json`), JSON.stringify({ consumer, pid: process.pid, state, at: new Date().toISOString(), ...extra }));
}

/** [{consumer, state, at, age_s, live}] newest first. */
export function listeners(home, now = Date.now()) {
  const dir = path.join(home, 'listeners');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const l = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const age = now - Date.parse(l.at);
      const live = l.state === 'handling' ? age < HANDLING_FRESH_MS : age < WAITING_FRESH_MS && alive(l.pid);
      out.push({ consumer: l.consumer, state: l.state, at: l.at, age_s: Math.round(age / 1000), live, question: l.question || null, repo: l.repo || null, story: l.story || null });
    } catch { /* a half-written beat; skip it */ }
  }
  return out.sort((a, b) => a.age_s - b.age_s);
}

/** Is cmd runnable as typed (a path that exists, or a name on PATH)? */
export function onPath(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) return existsSync(cmd);
  try { execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/diff-story.mjs');
const shq = s => (/^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
let cliCache = null;
/** How to run the CLI from a shell: `diff-story` when it's on PATH, else node and the script by full path. */
export function cliCommand(found = cliCache ?? (cliCache = onPath('diff-story'))) {
  return found ? 'diff-story' : `${shq(process.execPath)} ${shq(BIN)}`;
}

/**
 * "Copy prompt for Claude": one line for the diff-story-listen skill (skills/diff-story-listen), naming the repo,
 * plus the long form for a session without the skill.
 */
export function listenPrompt({ repo = null, story = null, checkout = null } = {}, cli = cliCommand()) {
  const arg = repo ? ` ${repo}` : story ? ` --story ${story}` : '';
  const wait = `${cli} wait${repo ? ` --repo ${repo}` : story ? ` --story ${story}` : ''}`;
  const where = checkout ? `In ${tilde(checkout)}, run` : repo ? `In your checkout of ${repo}, run` : 'Run';
  return {
    repo, checkout: checkout ? tilde(checkout) : null,
    prompt: `/diff-story-listen${arg}`,
    command: wait,
    details: `${where} \`${wait}\` as a background task, and start it again each time it exits. For a question, answer it and run \`${cli} answer --question <id> --text "<answer>"\`. `
      + `For a build request, run \`${cli} builds --start <id>\`, build the story with /pr-story <PR url>, then run \`${cli} done <id>\`. Keep going until I say stop.`,
  };
}

/**
 * Is a Claude session listening for this page, and the prompt that starts one. A wait with no --repo or --story
 * covers everything, a --repo wait covers that repo's stories and PRs, and a --story wait that story.
 */
export function listeningOf(home, { repo = null, story = null } = {}) {
  const ls = listeners(home);
  const covers = l => (!l.repo && !l.story) || (repo && sameRepo(l.repo, repo)) || (story && l.story === story);
  const live = ls.filter(l => l.live && covers(l));
  return {
    ok: live.length > 0,
    consumers: live.map(l => ({ consumer: l.consumer, state: l.state, age_s: l.age_s, repo: l.repo })),
    last_seen: ls[0] ? ls[0].at : null,
    start: repo ? `In Claude Code, in your checkout of ${repo}: /diff-story-listen ${repo}` : 'In Claude Code: /diff-story-listen',
    ...listenPrompt({ repo, story: repo ? null : story, checkout: checkoutFor(home, repo) }),
  };
}

const onOff = cfg => (cfg && cfg.enabled ? { enabled: true, command: cfg.command || null } : { enabled: false });

/** What the panel's status light shows. */
export function statusOf({ home, version, story, repo = null, autoBuild, autoAnswer, extensionSeen }) {
  return {
    bridge: { ok: true, version },
    story: story === undefined ? null : { ok: !!story, id: story || null },
    listening: listeningOf(home, { repo, story: story || null }),
    repo,
    autoBuild: onOff(autoBuild),
    autoAnswer: onOff(autoAnswer),
    extension_seen: extensionSeen || null,
  };
}

/** The context file auto-answer hands its command: the story and the asked-about chapter, with its diff when there is one. */
export function answerContext(storyData, storyDir, q) {
  const n = Number(q.step) || 0;
  const ch = n > 0 ? storyData.chapters[n - 1] : null;
  const rels = new Set((ch ? ch.files : storyData.files).map(f => f.rel));
  let diff = null;
  for (const f of ['local.diff', 'pr.diff']) {
    const file = storyDir && path.join(storyDir, f);
    if (file && existsSync(file)) {
      const parsed = parseUnifiedDiff(readFileSync(file, 'utf8'));
      diff = [...parsed.values()].filter(x => rels.has(x.rel)).map(x => ({ rel: x.rel, hunks: x.hunks.map(h => ({ at: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines: h.lines })) }));
      break;
    }
  }
  return {
    question: { id: q.id, text: q.text, file: q.file || null, step: n, chapter: q.chapter || null },
    story: { id: storyData.id, kind: storyData.kind, title: storyData.title, pr: storyData.pr, overview: storyData.overview || storyData.summary || '' },
    chapter: ch ? { title: ch.title, narrative: ch.narrative, files: ch.files, comments: ch.comments } : null,
    diff,
  };
}

/** autoAnswer: run the configured command for one question; stdout (exit 0) becomes the answer. */
export function runAutoAnswer({ home, autoAnswer, question, context, onAnswer, onFail }) {
  const cmd = autoAnswer && autoAnswer.command;
  if (!Array.isArray(cmd) || !cmd.length || !cmd.every(a => typeof a === 'string')) { onFail('autoAnswer.command must be an array of strings'); return; }
  const dir = path.join(home, 'answers');
  mkdirSync(dir, { recursive: true });
  const ctxFile = path.join(dir, `${question.id}.context.json`);
  writeFileSync(ctxFile, JSON.stringify(context, null, 2));
  const fill = a => a.replace(/\{question\}/g, question.text).replace(/\{context\}/g, ctxFile).replace(/\{story\}/g, question.story).replace(/\{id\}/g, question.id);
  const cwd = autoAnswer.cwd ? autoAnswer.cwd.replace(/^~(?=\/|$)/, os.homedir()) : os.homedir();
  let stdout = '';
  let stderr = '';
  let child;
  try {
    child = spawn(cmd[0], cmd.slice(1).map(fill), {
      cwd: existsSync(cwd) ? cwd : os.homedir(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DIFF_STORY_QUESTION_ID: question.id, DIFF_STORY_CONTEXT: ctxFile, DIFF_STORY_STORY: question.story },
    });
  } catch (e) { onFail(`autoAnswer could not start: ${e.message}`); return; }
  const timeout = setTimeout(() => child.kill('SIGTERM'), (autoAnswer.timeout_s || 600) * 1000);
  child.stdout.on('data', d => { if (stdout.length < 100000) stdout += d; });
  child.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
  child.on('error', e => { clearTimeout(timeout); onFail(`autoAnswer could not start: ${e.message}`); });
  child.on('exit', code => {
    clearTimeout(timeout);
    writeFileSync(path.join(dir, `${question.id}.log`), `exit ${code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`);
    if (code === 0 && stdout.trim()) onAnswer(stdout.trim());
    else onFail(`autoAnswer exited ${code}`);
  });
}
