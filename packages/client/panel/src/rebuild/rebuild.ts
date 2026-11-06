/*
 * Rebuild, without a DOM or Preact (rebuild-part.ts draws it): the request for a rebuild, whether one is still to be
 * done, and the line that says how it stands: queued, rebuilding, then rebuilt (with what the rebuild kept) or failed.
 *
 * Node tests use these.
 */
import { clockTime } from '@once-upon-a-diff/terms/time';
import type { RebuildAsk, RebuildView } from '@once-upon-a-diff/contracts/types';

/** How long the panel says a rebuild finished, after it did. */
export const DONE_SHOWN_MS = 30 * 60 * 1000;

/** The request for a rebuild asked on `step` (0, the Overview, or 1: the whole story). */
export function rebuildAsk(step: number, guidance = ''): RebuildAsk {
  const note = String(guidance || '').trim();
  const from = Number(step) > 1 ? Number(step) : 1;
  return {
    mode: from > 1 ? 'rebuild_from' : 'rebuild',
    ...(from > 1 ? { from_step: from } : {}),
    ...(note ? { guidance: note } : {}),
    requested_at: new Date().toISOString(),
  };
}

/** Is the rebuild still to be done? */
export const rebuildPending = (rebuild: RebuildView | null): boolean =>
  !!rebuild && (rebuild.state === 'queued' || rebuild.state === 'building');

/** The status line for the story's rebuild ('' when there's nothing to say). */
export function rebuildLine(rebuild: Partial<RebuildView> | null, now = Date.now()): string {
  if (!rebuild) {
    return '';
  }
  const from = rebuild.from_step ? `from chapter ${rebuild.from_step}` : '';
  const asked = clockTime(rebuild.requested_at);
  if (rebuild.state === 'queued') {
    return `Rebuild ${from || 'of the whole story'} queued${asked ? ` at ${asked}` : ''}. No Claude session has taken it yet.`;
  }
  if (rebuild.state === 'building') {
    const details = [rebuild.claimed_by || '', asked ? `asked at ${asked}` : ''].filter(Boolean);
    return `Rebuilding ${from || 'the whole story'}…${details.length ? ` (${details.join(', ')})` : ''}`;
  }
  const finished = Date.parse(rebuild.done_at || '');
  if (!Number.isFinite(finished) || now - finished > DONE_SHOWN_MS) {
    return '';
  }
  const finishedAt = clockTime(rebuild.done_at);
  const when = finishedAt ? ` at ${finishedAt}` : '';
  if (rebuild.state === 'failed') {
    return `The rebuild ${from || 'of the whole story'} failed${when}${rebuild.note ? `: ${rebuild.note}` : '.'}`;
  }
  return `Rebuilt ${from || 'the whole story'}${when}.${rebuild.note ? ` ${rebuild.note}` : ''}`;
}
