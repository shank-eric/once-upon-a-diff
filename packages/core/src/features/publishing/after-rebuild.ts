import { Inbox } from '../../queues/requests/inbox.ts';
import { moveQuestions } from '../../queues/requests/conversation.ts';
import { readReads, retireReads } from '../../records/stories/reads.ts';
import {
  firstRetold,
  questionMoves,
  readsToRetire,
  rebuildNote,
  type RebuildAskFields,
} from '../../records/stories/rebuild.ts';
import type { Plan } from '../../records/stories/chapters.ts';

/**
 * Once a rebuild is published: moves the questions asked on re-told chapters and sets aside the reads of chapters
 * re-told over other files. `stateKey` is where the story's read.json lives (stateKeyOf). Returns rebuildNote's line.
 */
export function afterRebuild(
  home: string,
  {
    id,
    stateKey,
    build,
    before,
    after,
    counts,
  }: {
    id: string;
    stateKey: string;
    build: RebuildAskFields;
    before: Plan;
    after: Plan;
    counts: { carried: number; unmapped: number };
  },
): string {
  const from = firstRetold(build);
  const moves = questionMoves(new Inbox(home).questions(id), before, after, from);
  moveQuestions(home, id, moves);
  const retired = retireReads(
    home,
    stateKey,
    readsToRetire(readReads(home, stateKey), before, after),
  );
  return rebuildNote(build, { ...counts, moved: Object.keys(moves).length, retired });
}
