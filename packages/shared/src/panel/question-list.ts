/*
 * The pure parts of the questions dock's list. The list is the whole story's:
 * every question asked on any step is in it, each labelled with the step it
 * was asked on, and the ones from the step on screen are marked.
 */
import type { Question } from '../types.ts';

/** A chapter's number and title are all the label needs. */
type Titled = { title: string };

/** Where a question was asked: "Overview" for step 0, else "Chapter N: title" (just "Chapter N" when the story has no such chapter). */
export function questionStepLabel(question: Pick<Question, 'step'>, chapters: Titled[]): string {
  const step = Number(question.step);
  if (!Number.isInteger(step) || step <= 0) {
    return 'Overview';
  }
  const title = chapters[step - 1]?.title;
  return title ? `Chapter ${step}: ${title}` : `Chapter ${step}`;
}

/** Is this question from the step on screen? The Overview (0) is a step too. */
export const askedOnStep = (question: Pick<Question, 'step'>, step: number): boolean =>
  Number(question.step) === step;

/** What the dock's header and tools count: every question in the story, those still open, and those waiting for an answer. */
export function questionTotals(list: Question[]) {
  const open = list.filter((question) => !question.dismissed);
  return {
    open: open.length,
    waiting: open.filter((question) => !(question.answers || []).length).length,
    dismissed: list.length - open.length,
  };
}

/** A typed but unsent question kept across a remount of the panel (a story redraw), by story. */
const drafts = new Map<string, string>();

export const askDrafts = {
  keep(storyId: string, text: string) {
    if (text.trim()) {
      drafts.set(storyId, text);
    } else {
      drafts.delete(storyId);
    }
  },
  take(storyId: string): string {
    return drafts.get(storyId) || '';
  },
  forget(storyId: string) {
    drafts.delete(storyId);
  },
};
