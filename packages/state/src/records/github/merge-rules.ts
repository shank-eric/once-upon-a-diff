/** What stands between a PR and its merge button, and how many approvals the base branch's rulesets require. */
import { branchKey } from '@once-upon-a-diff/domain/ids';
import { runGh } from '@once-upon-a-diff/foundation/gh';
import type { PrInfo } from '@once-upon-a-diff/contracts/types';
import { plural } from '@once-upon-a-diff/domain/text';

/**
 * What stands between a PR and its merge button, in one plain line. GraphQL's `mergeable` only says there are no
 * conflicts, so this reads `mergeStateStatus` (CLEAN: the button works; BLOCKED: required reviews or checks are
 * missing; BEHIND, UNSTABLE, DIRTY, DRAFT) and, for BLOCKED, says which of approvals, changes requested, checks or open
 * threads is the reason. null while GitHub is still working it out.
 */
export function mergeSummary(input: {
  status: string | null | undefined;
  approvals: number;
  required: number | null;
  review: PrInfo['review'];
  checks: PrInfo['checks'];
  unresolved: number;
}): PrInfo['merge'] {
  const { status, approvals, required, review, checks, unresolved } = input;
  switch (status) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { ready: true, text: 'ready to merge', tone: 'ok' };
    case 'UNSTABLE':
      return { ready: true, text: 'ready to merge (optional checks failing)', tone: 'ok' };
    case 'DRAFT':
      return { ready: false, text: 'draft', tone: 'warn' };
    case 'DIRTY':
      return { ready: false, text: 'conflicts', tone: 'bad' };
    case 'BEHIND':
      return { ready: false, text: 'behind base', tone: 'warn' };
    case 'BLOCKED': {
      const short = required !== null ? required - approvals : 0;
      let text = 'blocked';
      let tone: 'warn' | 'bad' = 'warn';
      if (short > 0) {
        text = `needs ${plural(short, 'more approval')}`;
      } else if (review === 'changes_requested') {
        text = 'changes requested';
        tone = 'bad';
      } else if (checks === 'failure') {
        text = 'checks failing';
        tone = 'bad';
      } else if (checks === 'pending') {
        text = 'checks running';
      } else if (unresolved > 0) {
        text = 'open threads to resolve';
      } else if (review === 'review_required' || approvals === 0) {
        text = 'needs approval';
      }
      return { ready: false, text, tone };
    }
    default:
      return null;
  }
}

/**
 * The base branch's required approving reviews as its rulesets say (`gh api repos/<repo>/rules/branches/<base>`, up to
 * 100 rules, which is as many as a page holds), kept 30 minutes.
 */
const rulesKept = new Map<string, { at: number; required: number | null }>();
const RULES_MS = 30 * 60 * 1000;
export async function rulesRequired(repo: string, base: string): Promise<number | null> {
  const key = branchKey(repo, base);
  const kept = rulesKept.get(key);
  if (kept && Date.now() - kept.at < RULES_MS) {
    return kept.required;
  }
  let required: number | null = null;
  try {
    const rules: unknown = JSON.parse(
      await runGh(
        ['api', `repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=100`],
        { timeout: 20000 },
      ),
    );
    const counts = (Array.isArray(rules) ? rules : [])
      .filter((rule) => rule?.type === 'pull_request')
      .map((rule) => Number(rule.parameters?.required_approving_review_count))
      .filter((count) => Number.isFinite(count));
    required = counts.length ? Math.max(...counts) : null;
  } catch {
    // not readable with this login, or no rulesets: protection rules are all there is
    required = null;
  }
  rulesKept.set(key, { at: Date.now(), required });
  return required;
}
