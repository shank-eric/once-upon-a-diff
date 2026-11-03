/**
 * Where a ledger agent goes on the board. By default it is a card of its own, on its own lane: its `lane:<name>` tag,
 * else the repo it worked in when its task text says (a worktree path, or a lane name), else its parent's lane. It is
 * nested inside its parent's card only when it is tightly tied to it, which is what `tiedToParent` decides, the one
 * place for that rule. An agent that claimed a backlog card is none of this: it is shown on that card (claims.ts).
 * The text placement here is for agents with no claim; bl_mw12ymyrceec6c audits it and replaces it with explicit links.
 */
import type { BoardCard } from '@once-upon-a-diff/protocol/types';
import type { LedgerAgent } from '../ledger/ledger.ts';

/** Lowercase letters and digits only, so "Once Upon a Diff" and "once-upon-a-diff" compare equal. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether the text names the branch as a whole token: bounded by the start or end, whitespace, or punctuation other
 * than `/`, `-`, `_` and `.`, so a branch `ui` is not found inside "build" or "ui-kit", and `feat/x` not in `feat/x-2`.
 * A `.` ends a token only as the end of a sentence (followed by whitespace or the end).
 */
export function namesBranch(text: string, branch: string): boolean {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w/.-])${escaped}(?![\\w/-]|\\.\\w)`, 'i').test(text);
}

/** Whether the agent's task names the card's branch (as a whole token, see `namesBranch`), or its PR by number (#7, PR 7 or /pull/7). Text matching, kept for unclaimed agents: bl_mw12ymyrceec6c. */
function namesCard(agent: LedgerAgent, card: BoardCard): boolean {
  const task = `${agent.name} ${agent.task || ''}`;
  if (card.branch && namesBranch(task, card.branch)) {
    return true;
  }
  const number = card.pr?.number;
  return !!number && new RegExp(`(?:#|\\bPR |/pull/)${number}\\b`, 'i').test(task);
}

/**
 * Whether the agent is working on the same branch or PR as its parent's card, so it belongs inside it: the card is a
 * branch or PR (not a session alone), the agent has no lane tag that names another lane, and its task says the card's
 * branch (as a whole token, see `namesBranch`) or PR number. An agent that says neither is not tied, so it gets its own card.
 * (Text matching, kept for unclaimed agents until bl_mw12ymyrceec6c replaces it.)
 */
export function tiedToParent(agent: LedgerAgent, card: BoardCard): boolean {
  if (card.kind !== 'work') {
    return false;
  }
  if (agent.lane && agent.lane.toLowerCase() !== card.lane.toLowerCase()) {
    return false;
  }
  return namesCard(agent, card);
}

/** Whether a lane tag and a lane name are the same lane, loosely: "once-upon" is the lane "once-upon-a-diff". */
function sameLane(tag: string, lane: string): boolean {
  const first = squash(tag);
  const second = squash(lane);
  return !!first && !!second && (first.startsWith(second) || second.startsWith(first));
}

/**
 * The branch or PR card a gated agent (a plan to check, a reviewer, findings being fixed) belongs in, wherever its
 * launching session is: the work card whose branch or PR its task names, in a lane its tag matches loosely. Only one
 * match counts. When several cards fit (the same branch name in two repos), the one on the parent's lane wins, else none.
 * (Text matching, kept for unclaimed agents: reviewers and gates have no card to claim. bl_mw12ymyrceec6c replaces it.)
 */
export function gatedHome(
  agent: LedgerAgent,
  cards: BoardCard[],
  parentLane: string | null,
): BoardCard | null {
  const fits = cards.filter(
    (card) =>
      card.kind === 'work' &&
      (!agent.lane || sameLane(agent.lane, card.lane)) &&
      namesCard(agent, card),
  );
  if (fits.length <= 1) {
    return fits[0] ?? null;
  }
  const near = fits.filter(
    (card) => parentLane && card.lane.toLowerCase() === parentLane.toLowerCase(),
  );
  return near.length === 1 ? near[0] : null;
}

/**
 * The lane for an agent with its own card: its tag, else the known lane (a repo or tag already on the board) its task
 * text names (a `<repo>-worktrees/` path, or the lane's name, which "Once Upon a Diff" matches for once-upon-a-diff),
 * else its parent's lane, else "No live session". (Text matching, kept for unclaimed agents: bl_mw12ymyrceec6c.)
 */
export function laneForAgent(
  agent: LedgerAgent,
  knownLanes: string[],
  parentLane: string | null,
  fallback: string,
): string {
  if (agent.lane) {
    return agent.lane;
  }
  const task = agent.task || '';
  const worktree = /([\w.-]+)-worktrees\//.exec(task)?.[1];
  const byWorktree =
    squash(worktree || '') && knownLanes.find((lane) => squash(lane) === squash(worktree || ''));
  if (byWorktree) {
    return byWorktree;
  }
  const text = squash(task);
  const named = [...knownLanes]
    .sort((first, second) => second.length - first.length)
    .find((lane) => {
      const flat = squash(lane);
      // a name with no letters or digits (a cwd of /, a lane tag of --) is nothing to look for: it would match every task
      if (!flat) {
        return false;
      }
      // a short name (SDK) has to stand as a word of its own, a longer one can be written with other spacing
      return flat.length >= 5
        ? text.includes(flat)
        : new RegExp(`\\b${lane.replace(/\W/g, '')}\\b`, 'i').test(task);
    });
  return named || parentLane || fallback;
}

const SHA = String.raw`(?<![\w:/.-])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w-])`;
const BRANCHY = String.raw`[\w.]*[-/][\w./-]*`;
/**
 * A sha the agent produced, not one it quotes: in the result's lead, after a commit word or an arrow (`sha 0637f8f`,
 * `ff to 0637f8f`, `main at 0637f8f`, `-> 0637f8f`), in parentheses (`work done (3064178)`) or on a branch (`5901849 on
 * feat/x`). A sha cited in passing ("found in ed7b242", "before e5342ec") and a `sid:` do not match. A digit is required,
 * so a word that happens to be hex is not one, and all-digit shas count.
 */
const SHA_RES = [
  new RegExp(
    `(?:\\b(?:shas?|commits?|committed|amended|rebased|restacked|fix|ff|live|(?:main|master) at)\\b(?:\\s+\\S+){0,2}?|->|→|@)\\s*:?\\s*${SHA}`,
    'i',
  ),
  // a branch's new tip (`stack/5 now 4fc94ff`)
  new RegExp(`\\S+/\\S*\\s+(?:now\\s+)?${SHA}`, 'i'),
  new RegExp(`^\\W*${SHA}(?=\\s*(?::|\\(|\\blive\\b|\\bon\\b|$))`, 'i'),
  new RegExp(`\\(\\s*${SHA}\\s*[,)]`, 'i'),
  new RegExp(`${SHA}\\s+(?:live\\s+)?on\\s+${BRANCHY}`, 'i'),
];
/**
 * Something it did: committed (or left uncommitted), pushed, deployed, built, published, staged or went live (`live`,
 * or `live on <branch>`, not "12 built" or "live bridge"), tests green, a branch named with a `-` or `/`, a worktrees path.
 */
const DID_RE = new RegExp(
  [
    String.raw`\b(?:committed|uncommitted|pushed|deployed|published|staged)\b`,
    String.raw`(?<!\d\s)\bbuilt\b`,
    String.raw`\bff['’]?d\b`,
    String.raw`\blive\b(?!\s+(?!on\s+\D)\w)`,
    String.raw`\b(?:tests?|checks?)\s+(?:all\s+)?(?:green|pass\w*)\b`,
    String.raw`\ball\s+green\b`,
    String.raw`\bbranch(?:es)?\s+\x60?${BRANCHY}`,
    String.raw`-worktrees/`,
  ].join('|'),
  'i',
);
/** A card id it added: with an added/created/filed/at-top word in the same clause. */
const CARD_ADDED_RES = [
  /\b(?:added|created|filed|new cards?)\b[^.;]*(?<![\w-])bl_[a-z0-9]{6,24}(?![\w-])/i,
  /(?<![\w-])bl_[a-z0-9]{6,24}(?![\w-])[^.;]*\b(?:added|created|filed|at (?:the )?top)\b/i,
  /\bat (?:the )?top\b[^.;]*(?<![\w-])bl_[a-z0-9]{6,24}(?![\w-])/i,
];
const DID_WORDS = String.raw`(?:committed|pushed|deployed|built|published|staged|branch\w*|worktrees?|code|commits?|sha)`;
/** Said as not done: a negator before the word ("nothing was committed or pushed"), or "no"/"none" after it ("committed? no"). */
const NEGATED_RES = [
  new RegExp(
    String.raw`(?<![\w-])(?:no|not|nothing|never|without|none)(?![\w-])[^.;]*\b${DID_WORDS}\b`,
    'i',
  ),
  new RegExp(String.raw`\b${DID_WORDS}\b\W{0,3}(?:no|none|n/a|nope)(?![\w-])`, 'i'),
];

/** The result's clauses (split at a full stop, a comma, a semicolon or a dash) that do not say they did nothing. */
const clausesOf = (outcome: string): string[] =>
  outcome
    .split(/[.;,\n]|\s[—–-]\s/)
    .filter((clause) => !NEGATED_RES.some((pattern) => pattern.test(clause)));

/**
 * Whether a finished agent made something you can point at, and so is Done, not Waiting. Research is the one thing that
 * waits: it left a finding to read and nothing else. Made something is any of: a reviewer (its findings are in the story
 * and the review file, so off the board once it is finished); a result that names a sha it produced, or says it
 * committed, pushed, deployed, built, published, staged or went live, or names a branch, a worktrees path or a card it
 * added; or, for an agent that finished (done), a task that names a worktrees folder. A stopped agent has to show its output in its result. Clauses that say they did nothing do not count, and a commit or PR only quoted in a finding does not either.
 */
export function madeSomething(
  agent: Pick<LedgerAgent, 'name' | 'task' | 'outcome'> & { state?: LedgerAgent['state'] },
): boolean {
  if (/^review-/i.test(agent.name)) {
    return true;
  }
  const task = agent.task ?? '';
  if (agent.state !== 'stopped' && /-worktrees\//.test(task)) {
    return true;
  }
  const outcome = agent.outcome ?? '';
  return (
    SHA_RES.some((pattern) => pattern.test(outcome)) ||
    clausesOf(outcome).some(
      (clause) => DID_RE.test(clause) || CARD_ADDED_RES.some((pattern) => pattern.test(clause)),
    )
  );
}
