/**
 * Where a registered agent goes on the board, decided only by the fields it registered (`once-upon agent start`:
 * repo, branch, PR, card, and the branch and PR its finish event reports), never by its task, name or outcome. An
 * agent with a home is nested inside that card; every other agent, including one read from the old ledger text, which
 * has none of those fields, is a card of its own (stages/agents.ts). An agent that claimed a backlog card is neither:
 * it is shown on that card (claims.ts).
 */
import type { BoardCard } from '@once-upon-a-diff/protocol/types';
import { sameRepo } from '../config/repos.ts';
import type { BacklogItem } from '../backlog/backlog.ts';
import { cardOnBranch } from '../backlog/backlog.ts';
import { isReviewer, type LedgerAgent } from '../ledger/ledger.ts';

/**
 * The card an agent works on, or null: the one card that its registered fields point to. Three ways to point, each exact
 * (no text, no loose compare), and the agent has a home only when they all name the same card:
 *
 *   branch   its repo and branch (the finish event's branch when it has one): the branch's work card, else a session on it
 *   PR       its repo and PR number (the finish event's PR when it has one): that work card
 *   card     its backlog card (`--card`): the work or session card on that item's repo and branch, if the item has a branch.
 *            This needs no repo of the agent's own: the item supplies it
 *
 * Two different cards named, or none, is no home.
 */
export function homeOf(
  agent: Pick<LedgerAgent, 'repo' | 'branch' | 'pr' | 'card' | 'result'>,
  cards: BoardCard[],
  items: Pick<BacklogItem, 'id' | 'repo' | 'branch'>[],
): BoardCard | null {
  const repo = agent.repo ?? null;
  const branch = agent.result?.branch ?? agent.branch ?? null;
  const pr = agent.result?.pr ?? agent.pr ?? null;
  const found = new Set<BoardCard>();
  const add = (card: BoardCard | undefined) => {
    if (card) {
      found.add(card);
    }
  };
  if (repo && branch) {
    add(cardOnBranch({ repo, branch }, cards));
  }
  if (repo && pr) {
    add(
      cards.find(
        (card) => card.kind === 'work' && sameRepo(card.repo, repo) && card.pr?.number === pr,
      ),
    );
  }
  const item = agent.card ? items.find((one) => one.id === agent.card) : undefined;
  if (item?.branch) {
    add(cardOnBranch(item, cards));
  }
  return found.size === 1 ? [...found][0] : null;
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
 * or `live on <branch>`, not "12 built" or "live bridge"), tests green, or a branch named with a `-` or `/`.
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
 * committed, pushed, deployed, built, published, staged or went live, or names a branch or a card it
 * added. Clauses that say they did nothing do not count, and a commit or PR only quoted in a finding does not either.
 */
export function madeSomething(
  agent: Pick<LedgerAgent, 'name' | 'task' | 'outcome'> &
    Partial<Pick<LedgerAgent, 'state' | 'source' | 'kind' | 'result'>>,
): boolean {
  if (isReviewer(agent)) {
    return true;
  }
  if (agent.source === 'events') {
    // a registered agent says what it made: a result with a commit, PR, branch or card. Research that made none is Waiting
    if (agent.result && Object.keys(agent.result).length) {
      return true;
    }
    if (agent.kind === 'research') {
      return false;
    }
  }
  const outcome = agent.outcome ?? '';
  return (
    SHA_RES.some((pattern) => pattern.test(outcome)) ||
    clausesOf(outcome).some(
      (clause) => DID_RE.test(clause) || CARD_ADDED_RES.some((pattern) => pattern.test(clause)),
    )
  );
}
