/*
 * The cards `once-upon compact` moved out of backlog.jsonl (`<home>/archive/backlog-YYYY-MM.jsonl`), folded like the log. The board never
 * reads them; `card status` does, for a card that has gone from the log.
 */
import { readArchive } from '@once-upon-a-diff/adapters/stores/fs/archive';
import { jsonLines } from '@once-upon-a-diff/adapters/stores/fs/jsonl';
import { readBacklogEvent } from '@once-upon-a-diff/contracts/files/schemas';
import { foldBacklogEvents } from './backlog.ts';
import type { BacklogItem } from './types.ts';

/** The archived cards (none when nothing was archived). */
export function archivedCards(home: string): BacklogItem[] {
  return foldBacklogEvents(
    jsonLines(readArchive(home, 'backlog')).flatMap((value) => readBacklogEvent(value) ?? []),
  );
}
