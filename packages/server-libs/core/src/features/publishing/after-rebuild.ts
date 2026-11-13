import { Inbox } from '@once-upon-a-diff/state/queues/requests/inbox';
import { moveQuestions, readQaMarks } from '@once-upon-a-diff/state/queues/requests/conversation';
import { chapterKeyOf } from '@once-upon-a-diff/terms/chapters';
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
  // a question an earlier rebuild moved is on the chapter that move named, not the one it was asked on
  const marks = readQaMarks(home, id);
  const questions = new Inbox(home).questions(id).map((question) =>
    question.id in marks.moved
      ? {
          ...question,
          step: marks.moved[question.id],
          chapter_key: marks.moved_key?.[question.id] || null,
        }
      : question,
  );
  const moves = questionMoves(questions, before, after, from);
  const keys = Object.fromEntries(
    Object.entries(moves)
      .filter(([, step]) => step > 0)
      .map(([question, step]) => [question, chapterKeyOf((after.chapters || [])[step - 1])]),
  );
  moveQuestions(home, id, moves, keys);
  const retired = retireReads(
    home,
    stateKey,
    readsToRetire(readReads(home, stateKey), before, after),
  );
  return rebuildNote(build, { ...counts, moved: Object.keys(moves).length, retired });
}
