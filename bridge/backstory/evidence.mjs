/*
 * Evidence from the extractor's story, kept only inside the time window:
 *   edit    an Edit/Write on a file of the diff, in any checkout of the repo
 *   commit  a `git commit` whose subject (or printed SHA) is a commit in the range
 *   check   a lint/test/build command run in a checkout
 *   shell   a write-ish shell command naming a diff file (sed -i, a script, --fix)
 *   look    anything else run in a checkout (dropped later unless its agent did something)
 */
import { HOME, clip, toMillis } from './text.mjs';
import { rangesFor } from './range.mjs';

const COMMIT_RE = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/;
const WRITE_RE =
  /\bsed\s+-i|\bperl\s+-p?i|\bpython3?\b[^|]*<<|\bnode\s+(?:-\S+\s+)*(?:-e|--eval|-p|--print)\s|--fix\b|--write\b|\bgit\s+(apply|checkout|restore)\b/;
// a redirect or tee counts only when it writes to a file of the diff, not to a scratch file or a log
const REDIRECT_RE = /(?:>>?|\btee\s+(?:-a\s+)?)\s*["']?([^\s"';&|<>]+)/g;
const isWrite = (cmd, rels) =>
  WRITE_RE.test(cmd) ||
  [...cmd.matchAll(REDIRECT_RE)].some((match) =>
    rels.some(
      (rel) =>
        match[1] === rel ||
        match[1].endsWith('/' + rel) ||
        (rel.includes('/') && match[1].endsWith(rel.split('/').slice(-2).join('/'))),
    ),
  );

export function evidenceFromStory(story, range, win, index) {
  const home = (root) => (root.startsWith(HOME) ? '~' + root.slice(HOME.length) : root);
  // a checkout's path, not a longer sibling's (~/x/repo is not ~/x/repo-worktrees/y)
  const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = new Map(
    range.roots.map((root) => [
      root,
      new RegExp(`(?:${esc(root)}|${esc(home(root))})(?=[\\s/;&|'")]|$)`),
    ]),
  );
  const mentions = (cmd, root) => pathRe.get(root).test(cmd);
  const inRoot = (cmd) => range.roots.some((root) => mentions(cmd, root));
  const finalRels = [...range.final.keys()];
  const relOf = (file) => {
    for (const root of range.roots) {
      if (file.startsWith(root + '/')) {
        return file.slice(root.length + 1);
      }
    }
    return null;
  };
  const when = new Map(
    ((story.trace && story.trace.events) || []).map((e) => [e.id, e.started_at]),
  );
  const inWin = (timestamp) => {
    const millis = toMillis(timestamp);
    return Number.isFinite(millis) && millis >= win.start && millis <= win.end;
  };
  const evidence = [];
  // the checkouts this range was made in: where its commits were run and its files edited.
  // Checks and scripts elsewhere (another worktree of the same repo) belong to other work.
  const active = new Set();
  for (const turn of story.turns) {
    for (const e of turn.edits || []) {
      const root = range.roots.find((candidate) => (e.file || '').startsWith(candidate + '/'));
      if (root && range.final.has(relOf(e.file))) {
        active.add(root);
      }
    }
    for (const run of turn.bash || []) {
      const cmd = String(run.command || '');
      if (COMMIT_RE.test(cmd) && range.commits.some((commit) => cmd.includes(commit.subject))) {
        for (const root of range.roots) {
          if (mentions(cmd, root)) {
            active.add(root);
          }
        }
      }
    }
  }
  const inActive = (cmd) =>
    [...(active.size ? active : range.roots)].some((root) => mentions(cmd, root));
  for (const turn of story.turns) {
    for (const e of turn.edits || []) {
      const rel = relOf(e.file || '');
      if (!rel || !range.final.has(rel)) {
        continue;
      }
      const editedAt = when.get(e.id) || turn.at;
      if (!inWin(editedAt)) {
        continue;
      }
      const added = (e.hunks || []).flatMap((hunk) =>
        hunk.lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)),
      );
      const fromStrings = !added.length && e.new_string ? String(e.new_string).split('\n') : [];
      evidence.push({
        type: 'edit',
        at: editedAt,
        turn: turn.index,
        agent: e.by_subagent || null,
        rel,
        tool: e.tool,
        stats: e.stats,
        lines: rangesFor(index, rel, added.length ? added : fromStrings),
      });
    }
    for (const run of turn.bash || []) {
      const cmd = String(run.command || '');
      if (!inWin(run.at) || !inRoot(cmd)) {
        continue;
      }
      if (!COMMIT_RE.test(cmd) && !inActive(cmd)) {
        continue;
      }
      const agent = run.by_subagent || null;
      const named = finalRels.filter(
        (rel) =>
          cmd.includes(rel) ||
          (rel.includes('/') && cmd.includes(rel.split('/').slice(-2).join('/'))),
      );
      if (COMMIT_RE.test(cmd)) {
        const printed = [
          ...String(run.output_tail || '').matchAll(/\[[^\]\s]+ ([0-9a-f]{7,40})\]/g),
        ].map((match) => match[1]);
        const hits = range.commits.filter(
          (commit) =>
            cmd.includes(commit.subject) ||
            printed.some((printedSha) => commit.sha.startsWith(printedSha)),
        );
        for (const commit of hits) {
          evidence.push({
            type: 'commit',
            at: run.at,
            turn: turn.index,
            agent,
            sha: commit.sha,
            ok: run.ok,
          });
        }
        if (hits.length) {
          continue;
        }
      }
      const bare = cmd
        .replace(/^(cd [^;&]+(&&|;)\s*)+/, '')
        .replace(/^(export [^;&]+(&&|;)\s*|unset [^;&]+(&&|;)\s*)+/, '');
      if (
        ['test', 'lint', 'build'].includes(run.category) &&
        !isWrite(cmd, named) &&
        !/^(git|gh)\b/.test(bare)
      ) {
        evidence.push({
          type: 'check',
          at: run.at,
          turn: turn.index,
          agent,
          category: run.category,
          ok: run.ok,
          command: clip(cmd.replace(/^cd [^;&]+(&&|;)\s*/, ''), 220),
          rels: named,
        });
        continue;
      }
      if (isWrite(cmd, named) && (named.length || /\.py\b|<<'?PY/.test(cmd))) {
        evidence.push({
          type: 'shell',
          at: run.at,
          turn: turn.index,
          agent,
          command: clip(cmd.replace(/^cd [^;&]+(&&|;)\s*/, ''), 220),
          rels: named,
          ok: run.ok,
        });
      } else {
        evidence.push({ type: 'look', at: run.at, turn: turn.index, agent, rels: named });
      }
    }
  }
  return evidence;
}
