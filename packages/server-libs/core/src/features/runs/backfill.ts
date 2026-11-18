/*
 * `once-upon card backfill`: stores the cards the registry's runs made before ADR-29 (ADR-27's `ic_` ids, read from the runs until a card
 * of that id is stored) and, with `cardless`, gives the runs that still name no card one each. Both are safe to repeat: a card that is
 * stored is skipped, and the runs not yet moved are the ones left to move.
 *
 *   plain       every `ic_` id on a run with no stored card gets one `add` (source agent, `at` its first run's start). Stored cards of
 *               agents are not listed (isListed), so no board changes.
 *   cardless    the runs with no card (no standing helper, no editor) that are open or ended within `days` are grouped by agent (`sid:name`);
 *               each group gets one card, with an id made of the agent's key (so a half-done run finds its card again), and its
 *               runs are moved onto it (`setCard`, one `card` event a run). This moves runs on the live board (ADR-27: they "keep the
 *               placement they had until the flip"), so it is opt-in and meant for the moment before the flip. Older cardless runs stay.
 *
 * A card is found and made under the backlog file's lock (`store.add` throws on a stored id, so the check and the add are one step).
 * Dry run: the same counts, nothing written.
 */
import { createHash } from 'node:crypto';
import { withLock } from '@once-upon-a-diff/adapters/stores/fs/lock';
import { REPO_RE } from '@once-upon-a-diff/foundation/repos';
import { DEFAULT_BRANCHES } from '@once-upon-a-diff/foundation/settings';
import { BACKLOG_ID_RE, CARD_BRANCH_RE, SESSION_RE } from '@once-upon-a-diff/terms/patterns';
import { BACKLOG_NOTE_MAX } from '@once-upon-a-diff/terms/text';
import { BacklogStore } from '@once-upon-a-diff/state/queues/backlog/backlog';
import type { AddInput } from '@once-upon-a-diff/state/queues/backlog/backlog';
import { agentKey } from '@once-upon-a-diff/state/queues/backlog/claims';
import { runIsOpen } from '@once-upon-a-diff/state/records/agents/events';
import { implicitCards, implicitTitle } from '@once-upon-a-diff/state/records/agents/implicit';
import type { LedgerAgent } from '@once-upon-a-diff/state/records/agents/ledger';
import { readAgents } from '@once-upon-a-diff/state/records/agents/read';
import { runRegistry } from './registry.ts';

export const BACKFILL_DAYS = 7;

export interface BackfillCounts {
  /** cards stored (or, in a dry run, that would be) */
  added: number;
  /** runs moved onto a card (`cardless`) */
  moved: number;
  /** runs with no run id: they cannot be moved, and are left */
  unmovable: number;
  /** ids already stored, or not a card id at all */
  skipped: number;
}

const DAY = 24 * 3600 * 1000;

const startedAt = (run: LedgerAgent): number => run.started?.getTime() ?? 0;

/** The card's `add` as its first run tells it: title and note from the task, repo and branch only where the store would take them. */
function addFor(id: string, runs: LedgerAgent[]): AddInput {
  const first = runs[0];
  const task = runs.find((run) => run.task)?.task?.trim() ?? '';
  const title = implicitTitle(task) || first.name;
  const repo = runs.find((run) => run.repo && REPO_RE.test(run.repo))?.repo ?? null;
  const branch =
    [...runs]
      .reverse()
      .find(
        (run) => run.branch && CARD_BRANCH_RE.test(run.branch) && !DEFAULT_BRANCHES.has(run.branch),
      )?.branch ?? null;
  const session = first.session && SESSION_RE.test(first.session) ? first.session : null;
  return {
    id,
    title,
    note: task && task !== title ? task.slice(0, BACKLOG_NOTE_MAX) : null,
    repo,
    branch,
    session,
    source: 'agent',
    by: first.name.slice(0, 40),
    ...(first.started && first.started.getTime() <= Date.now()
      ? { at: first.started.toISOString() }
      : {}),
  };
}

/** The id a cardless agent's card gets: `ic_bf` and 10 hex digits of its key, so the same agent always finds the same card. */
export const backfillCardId = (key: string): string =>
  `ic_bf${createHash('sha1').update(key).digest('hex').slice(0, 10)}`;

/** The runs with no card that `cardless` takes: not a standing helper, and open or ended (else started) within `days`. */
const inScope = (run: LedgerAgent, nowMs: number, days: number): boolean =>
  !run.card &&
  !run.standing &&
  (runIsOpen(run) || nowMs - (run.ended ?? run.started ?? new Date(0)).getTime() <= days * DAY);

export function backfillCards(
  home: string,
  {
    dryRun = false,
    cardless = false,
    days = BACKFILL_DAYS,
    now = new Date(),
  }: { dryRun?: boolean; cardless?: boolean; days?: number; now?: Date } = {},
): BackfillCounts {
  const store = new BacklogStore(home);
  const counts: BackfillCounts = { added: 0, moved: 0, unmovable: 0, skipped: 0 };
  const stored = new Set(store.items().map((one) => one.id));
  /** one `add`, unless the id is stored (a dry run reads and takes no lock) */
  const storeCard = (input: AddInput, count = true): void => {
    const add = () => {
      if (stored.has(input.id as string) || store.items().some((one) => one.id === input.id)) {
        counts.skipped += count ? 1 : 0;
        return;
      }
      counts.added++;
      store.add(input);
    };
    if (dryRun) {
      if (stored.has(input.id as string)) {
        counts.skipped += count ? 1 : 0;
      } else {
        counts.added++;
        stored.add(input.id as string);
      }
      return;
    }
    withLock(store.file, add);
  };
  const { agents } = readAgents(home);
  const runsOf = (agent: LedgerAgent) => [...(agent.earlier ?? []), agent];

  for (const card of implicitCards(agents)) {
    if (!BACKLOG_ID_RE.test(card.id) || stored.has(card.id)) {
      counts.skipped++;
      continue;
    }
    storeCard(addFor(card.id, card.runs));
  }

  if (cardless) {
    const groups = new Map<string, LedgerAgent[]>();
    for (const run of agents.flatMap(runsOf)) {
      if (inScope(run, now.getTime(), days)) {
        groups.set(agentKey(run), [...(groups.get(agentKey(run)) ?? []), run]);
      }
    }
    const registry = dryRun ? null : runRegistry(home, 'none');
    for (const [key, found] of groups) {
      const movable = found
        .filter((run) => run.run)
        .sort((first, second) => startedAt(first) - startedAt(second));
      counts.unmovable += found.length - movable.length;
      if (!movable.length) {
        continue;
      }
      const id = backfillCardId(key);
      storeCard(addFor(id, movable), false);
      for (const run of movable) {
        counts.moved++;
        registry?.setCard(run, id, { by: 'backfill' });
      }
    }
  }
  return counts;
}

/** The line `card backfill` prints. */
export const backfillLine = (counts: BackfillCounts, dryRun: boolean): string =>
  `${dryRun ? 'would add' : 'added'} ${counts.added} cards, ${dryRun ? 'move' : 'moved'} ${counts.moved} runs (${counts.unmovable} unmovable), skipped ${counts.skipped} stored`;
