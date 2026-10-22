/*
 * "Copy as gh script": the story's line drafts still to post, as one shell
 * script that puts them all into a single pending review with
 * `gh api repos/{owner}/{repo}/pulls/{n}/reviews`.
 *
 * The panel only copies the script. Running it is the reviewer's call, and
 * even then nothing is published: the request has no `event`, so GitHub keeps
 * the review PENDING, visible only to them until they submit it on GitHub.
 * The comments go in as JSON on stdin through a quoted heredoc, so nothing in
 * a path or a body reaches the shell.
 *
 * Only drafts the panel shows as drafts go in: not dismissed, posted, already
 * in their pending review (Add to my review) or a fix-before-push note.
 * General drafts have no line, so they're left for Copy.
 *
 * No DOM here, so node tests can use it.
 */
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const END = 'PR_STORY_REVIEW_JSON';

/** Is it in their pending review already (Add to my review, or gh found it there)? */
const inPendingReview = (row) =>
  !!row && !row.dismissed && !row.fix && (!!row.added || row.status === 'pending');
/** Does the panel show it as a draft still to post? The same call as draftView's 'draft'. */
const stillDraft = (row) =>
  !row ||
  (!row.dismissed && !row.fix && !row.added && row.status !== 'posted' && row.status !== 'pending');

/** The file a draft names: exact, else the one file it's a path suffix of, else as written. */
function fullPath(name, rels) {
  const clean = String(name || '').replace(/^\.\//, '');
  if (rels.includes(clean)) {
    return clean;
  }
  const matches = rels.filter((rel) => rel.endsWith('/' + clean));
  return matches.length === 1 ? matches[0] : clean;
}

/**
 * What goes in the script, from the chapters' drafts and the bridge's rows for them.
 * @param {object[]} chapters the story's chapters, each with its `comments`
 * @param {object[]} rows the bridge's draft rows ({chapter, index, status, dismissed, added, fix})
 * @param {string[]} rels every file in the story
 * @returns {{comments: {path: string, line: number, side: 'LEFT'|'RIGHT', body: string}[], general: number, inReview: number}}
 *   general: drafts with no line, left out. inReview: drafts already in their pending review.
 */
export function scriptDrafts(chapters, rows, rels) {
  const byKey = new Map(rows.map((row) => [`${row.chapter}:${row.index}`, row]));
  const out = { comments: [], general: 0, inReview: 0 };
  chapters.forEach((chapter, chapterIndex) =>
    (chapter.comments || []).forEach((comment, index) => {
      const row = byKey.get(`${chapterIndex + 1}:${index}`);
      if (inPendingReview(row)) {
        out.inReview++;
      }
      const body = String(comment.body || '').trim();
      if (!stillDraft(row) || !body) {
        return;
      }
      const line = Number(comment.line);
      if (!comment.path || !(line > 0) || /^\(/.test(comment.path)) {
        out.general++;
        return;
      }
      out.comments.push({
        path: fullPath(comment.path, rels),
        line,
        side: comment.side === 'L' ? 'LEFT' : 'RIGHT',
        body,
      });
    }),
  );
  return out;
}

/**
 * The script itself. It runs in a subshell, so its `unset GITHUB_TOKEN` (when PR Story's config asks for it)
 * doesn't touch the reviewer's own shell.
 * @param {{repo: string, number: number, comments: object[], general?: number, inReview?: number}} input
 */
export function reviewScript({ repo, number, comments, general = 0, inReview = 0 }) {
  if (
    !REPO_RE.test(String(repo || '')) ||
    !Number.isInteger(Number(number)) ||
    Number(number) < 1
  ) {
    throw new Error('the story has no PR to add a review to');
  }
  const payload = JSON.stringify({ comments }, null, 2);
  const count = comments.length === 1 ? '1 drafted comment' : `${comments.length} drafted comments`;
  const notes = [
    `# PR Story: ${count} on ${repo}#${number}, as one pending review.`,
    "# It starts a review in your name and doesn't submit it: nobody else sees it until you submit it on GitHub.",
    '# GitHub allows one pending review per PR, so this fails if you already have one.',
  ];
  if (inReview) {
    notes.push(
      `# You do: ${inReview === 1 ? '1 draft is' : `${inReview} drafts are`} in it already. Submit or delete it first, or use Add to my review in the panel for these.`,
    );
  }
  if (general) {
    notes.push(
      `# Left out: ${general === 1 ? '1 general comment with no line. Copy it' : `${general} general comments with no line. Copy them`} from the panel.`,
    );
  }
  return [
    ...notes,
    '(',
    `  [ "$(jq -r '.gh_unset_github_token // false' "\${PR_STORY_HOME:-$HOME/.pr-story}/config.json" 2>/dev/null)" = true ] && unset GITHUB_TOKEN`,
    `  gh api --method POST repos/${repo}/pulls/${Number(number)}/reviews --input - --jq '"Pending review started: " + .html_url' <<'${END}'`,
    payload,
    END,
    ')',
    '',
  ].join('\n');
}
