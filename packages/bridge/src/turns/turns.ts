/**
 * The review inbox's turns: what each Claude Code turn changed in a checkout, kept so it can be reviewed later,
 * turn by turn. skills/once-upon/bin/capture-turn.sh (a Stop hook) snapshots the working tree after every turn and
 * posts the two tree ids, the user's prompt and Claude's last message. The bridge makes the diff itself, so a turn's
 * code never rides in a request body, and it never leaves the machine.
 *
 *   <home>/turns/<turn id>.json    the Turn (shared types.ts): repo, branch, session, prompt, files, reviewed_at
 *   <home>/turns/<turn id>.diff    the turn's unified diff, from the session's last snapshot to this one
 *   <home>/turn-<turn id>/         the turn as a local story, made the first time it's opened (openStory), so the
 *                                  local page, the panel's Ask and Fix before push work on it as on any local story
 *
 * Every file is the user's alone (0600, in a 0700 folder). A repo keeps its newest MAX_TURNS turns: older ones go
 * when a new one comes in, with their story folders and the state the page kept.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { HttpError, clipText } from '../server/request.ts';
import { ownerOnly } from '../config/settings.ts';
import { repoOfCheckout, sameRepo } from '../config/repos.ts';
import { parseUnifiedDiff } from '../util/diff.ts';
import { runGitAsync } from '../util/git.ts';
import { readJson } from '../util/json-file.ts';
import { newId } from '../inbox/inbox.ts';
import type { Turn, TurnFile, TurnList } from '@once-upon-a-diff/shared/types';
import type { Body } from '../types.ts';

export const TURN_ID_RE = /^t_[a-z0-9]{6,24}$/;
const TREE_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** What a repo keeps; the oldest turns go first. */
export const MAX_TURNS = 200;
/** The most diff text a turn keeps. Files past it keep their counts but not their lines (`omitted`). */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT = 8000;
const MAX_SUMMARY = 20000;
const DIFF_TIMEOUT_MS = 20000;

const turnsDir = (home: string) => path.join(home, 'turns');
const turnFile = (home: string, id: string) => path.join(turnsDir(home), `${id}.json`);
const diffFile = (home: string, id: string) => path.join(turnsDir(home), `${id}.diff`);
/** The id of the story a turn becomes (stories.ts's ID_RE allows it). */
export const storyIdOf = (turnId: string) => `turn-${turnId}`;

/** A turn by id, or null when there isn't one (or the id isn't a turn's). Reads the file only. */
export function readTurn(home: string, id: string): Turn | null {
  return TURN_ID_RE.test(id) ? readJson<Turn>(turnFile(home, id), null) : null;
}

/** A file written through a temp file and a rename, for the user alone. */
function writePrivate(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

/** The files a unified diff changes, with their counts. */
function filesOf(diffText: string): TurnFile[] {
  return [...parseUnifiedDiff(diffText).values()].map((file) => ({
    path: file.rel,
    kind: file.kind,
    added: file.stats.added,
    removed: file.stats.removed,
    ...(file.binary ? { binary: true } : {}),
  }));
}

/** `diff --git` sections of the diff as separate strings, in order. */
const sectionsOf = (diffText: string): string[] =>
  diffText.split(/^(?=diff --git )/m).filter(Boolean);

/**
 * The diff from one tree to the other, run by git in the checkout, and its files. Past MAX_DIFF_BYTES a file's
 * section is dropped whole and the file says `omitted`. When git can't make the diff in one piece (it's bigger than
 * the buffer), the files come from --numstat and none keeps its lines.
 */
async function diffBetween(repo: string, base: string, head: string) {
  // no external diff, no textconv: nothing in the checkout's config runs
  const flags = [
    '-c',
    'core.quotePath=false',
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
  ];
  const whole = await runGitAsync(repo, [...flags, '--find-renames', base, head], {
    timeout: DIFF_TIMEOUT_MS,
  });
  if (whole.code === 0) {
    const files = filesOf(whole.stdout);
    let kept = '';
    const keptPaths = new Set<string>();
    for (const section of sectionsOf(whole.stdout)) {
      if (Buffer.byteLength(kept) + Buffer.byteLength(section) > MAX_DIFF_BYTES) {
        continue;
      }
      kept += section;
      const names = /^diff --git a\/(.+) b\/(.+)$/m.exec(section);
      if (names) {
        keptPaths.add(names[2]);
      }
    }
    for (const file of files) {
      if (!keptPaths.has(file.path)) {
        file.omitted = true;
      }
    }
    return { diff: kept, files };
  }
  const counts = await runGitAsync(repo, [...flags, '--numstat', base, head], {
    timeout: DIFF_TIMEOUT_MS,
  });
  if (counts.code !== 0) {
    throw new HttpError(
      400,
      `git couldn't diff those trees: ${counts.stderr.trim().slice(0, 300)}`,
    );
  }
  const files: TurnFile[] = counts.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...name] = line.split('\t');
      const binary = added === '-';
      return {
        path: name.join('\t'),
        kind: 'modified' as const,
        added: binary ? 0 : Number(added),
        removed: binary ? 0 : Number(removed),
        ...(binary ? { binary: true } : {}),
        omitted: true,
      };
    });
  return { diff: '', files };
}

/** A folder git says is a checkout's top level, or an error for the caller. */
async function checkoutTop(dir: string): Promise<string> {
  if (!path.isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new HttpError(400, 'repo_path must be an existing absolute folder');
  }
  const top = await runGitAsync(dir, ['rev-parse', '--show-toplevel'], { timeout: 5000 });
  if (top.code !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(dir)) {
    throw new HttpError(400, 'repo_path must be the top of a git checkout');
  }
  return dir;
}

export class TurnStore {
  declare home: string;
  constructor(home: string) {
    this.home = home;
  }

  /**
   * Keeps a turn: `repo_path` (a checkout's top level), `base_tree` and `head_tree` (the session's last snapshot and this
   * one), `session`, `branch`, `at`, and the turn's `prompt` and `summary`. Resolves to null when the trees don't differ.
   */
  async add(body: Body): Promise<Turn | null> {
    const repoPath = await checkoutTop(String(body.repo_path || ''));
    const base = String(body.base_tree || '');
    const head = String(body.head_tree || '');
    if (!TREE_RE.test(base) || !TREE_RE.test(head)) {
      throw new HttpError(400, 'base_tree and head_tree must be full object ids');
    }
    if (base === head) {
      return null;
    }
    const { diff, files } = await diffBetween(repoPath, base, head);
    if (!files.length) {
      return null;
    }
    const session = SESSION_RE.test(String(body.session || '')) ? String(body.session) : 'unknown';
    const when = new Date(String(body.at || ''));
    const turn: Turn = {
      id: newId('t'),
      repo: repoOfCheckout(repoPath),
      repo_name: path.basename(repoPath),
      repo_path: repoPath,
      branch: clipText(body.branch, 200) || null,
      session,
      base_tree: base,
      head_tree: head,
      at: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
      prompt: clipText(body.prompt, MAX_PROMPT)?.trim() || null,
      summary: clipText(body.summary, MAX_SUMMARY)?.trim() || null,
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      truncated: files.some((file) => file.omitted),
      reviewed_at: null,
    };
    ownerOnly(turnsDir(this.home));
    writePrivate(diffFile(this.home, turn.id), diff);
    writePrivate(turnFile(this.home, turn.id), JSON.stringify(turn, null, 2));
    this.prune(repoPath);
    return turn;
  }

  /** Every turn, newest first, or only a repo's (owner/name, as GitHub spells it, or the checkout's folder name). */
  all({ repo }: { repo?: string | null } = {}): Turn[] {
    let names: string[];
    try {
      names = readdirSync(turnsDir(this.home));
    } catch {
      return [];
    }
    const turns = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readTurn(this.home, name.slice(0, -'.json'.length)))
      .filter((turn): turn is Turn => !!turn)
      .filter((turn) => !repo || sameRepo(turn.repo || turn.repo_name, repo))
      .sort(
        (first, second) => second.at.localeCompare(first.at) || second.id.localeCompare(first.id),
      );
    return turns;
  }

  /** The inbox: the turns (at most `limit`), and each repo's counts. */
  list({ repo, limit = 100 }: { repo?: string | null; limit?: number } = {}): TurnList {
    const everything = this.all();
    const counts = new Map<string, { repo: string; count: number; unreviewed: number }>();
    for (const turn of everything) {
      const name = turn.repo || turn.repo_name;
      const entry = counts.get(name.toLowerCase()) || { repo: name, count: 0, unreviewed: 0 };
      entry.count++;
      entry.unreviewed += turn.reviewed_at ? 0 : 1;
      counts.set(name.toLowerCase(), entry);
    }
    const turns = repo ? this.all({ repo }) : everything;
    return { turns: turns.slice(0, limit), repos: [...counts.values()] };
  }

  /** The turn and its diff text, or null. */
  read(id: string): { turn: Turn; diff: string } | null {
    const turn = readTurn(this.home, id);
    if (!turn) {
      return null;
    }
    let diff = '';
    try {
      diff = readFileSync(diffFile(this.home, id), 'utf8');
    } catch {
      diff = '';
    }
    return { turn, diff };
  }

  /** Marks a turn reviewed (or, with `reviewed` false, unreviewed). Null when there is no such turn. */
  markReviewed(id: string, reviewed = true): Turn | null {
    const turn = readTurn(this.home, id);
    if (!turn) {
      return null;
    }
    turn.reviewed_at = reviewed ? new Date().toISOString() : null;
    writePrivate(turnFile(this.home, id), JSON.stringify(turn, null, 2));
    return turn;
  }

  /**
   * The turn as a local story, made the first time it's opened: its diff, one chapter holding every file with the
   * prompt and Claude's message as its story. Returns the story's id. Its refs are tree ids, not commits, so the
   * local page keeps the diff written here (refreshLocal leaves a diff alone when its refs don't resolve).
   */
  openStory(id: string): string | null {
    const kept = this.read(id);
    if (!kept) {
      return null;
    }
    const { turn, diff } = kept;
    const storyId = storyIdOf(id);
    const dir = path.join(this.home, storyId);
    if (existsSync(path.join(dir, 'meta.json'))) {
      return storyId;
    }
    ownerOnly(dir);
    const title = `${turn.repo_name}: ${firstLine(turn.prompt) || 'a Claude turn'}`;
    const quote = (text: string) =>
      text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
    const rels = turn.files.filter((file) => !file.omitted).map((file) => file.path);
    const left = turn.files.length - rels.length;
    const narrative = [
      turn.prompt && `**You asked:**\n\n${quote(turn.prompt)}`,
      turn.summary && `**Claude's last message:**\n\n${quote(turn.summary.slice(0, 3000))}`,
      left && `${left} larger file${left === 1 ? '' : 's'} left out to keep the turn small.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    writePrivate(path.join(dir, 'local.diff'), diff);
    writePrivate(
      path.join(dir, 'chapters.json'),
      JSON.stringify({
        mode: 'turn',
        title,
        overview: `A Claude Code turn in ${turn.repo_name}${turn.branch ? ` on ${turn.branch}` : ''}. One chapter holds everything it changed.`,
        chapters: [
          {
            title: 'Chapter 1: What this turn changed',
            summary: `${rels.length} file${rels.length === 1 ? '' : 's'}.`,
            narrative,
            files: rels,
          },
        ],
      }),
    );
    writePrivate(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        kind: 'local',
        repo_path: turn.repo_path,
        repo_name: turn.repo_name,
        repo: turn.repo,
        // not refs (a ref name can't hold a space), so refreshLocal leaves the diff above alone; the page shows them
        base: 'before this turn',
        head: 'after this turn',
        base_oid: turn.base_tree,
        head_oid: turn.head_tree,
        // no branch: a turn isn't pushed or turned into a PR from here (the page shows no Create pull request)
        branch: null,
        title,
        turn: id,
        updated_at: turn.at,
      }),
    );
    return storyId;
  }

  /** A repo's turns past the newest MAX_TURNS go, with the story folder and page state each one made. */
  prune(repoPath: string): void {
    const mine = this.all().filter((turn) => turn.repo_path === repoPath);
    for (const turn of mine.slice(MAX_TURNS)) {
      for (const file of [turnFile(this.home, turn.id), diffFile(this.home, turn.id)]) {
        rmSync(file, { force: true });
      }
      rmSync(path.join(this.home, storyIdOf(turn.id)), { recursive: true, force: true });
      rmSync(path.join(this.home, 'state', storyIdOf(turn.id)), { recursive: true, force: true });
    }
  }
}

/** The first line of a prompt, cut to a title's length. */
function firstLine(text: string | null): string {
  const line = String(text || '')
    .split('\n')
    .find((candidate) => candidate.trim());
  const clean = (line || '').trim().replace(/\s+/g, ' ');
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}
