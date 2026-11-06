import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { moveQuestions } from '@once-upon-a-diff/state/queues/requests/conversation';
import { readReads, retireReads } from '@once-upon-a-diff/stories/reads';
import {
  firstRetold,
  questionMoves,
  readsToRetire,
  rebuildNote,
  type RebuildAskFields,
} from '@once-upon-a-diff/stories/rebuild';
import type { Plan } from '@once-upon-a-diff/stories/chapters';

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
