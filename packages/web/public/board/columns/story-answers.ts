/** What a board card says and offers for its story's unread answers, apart from the markup (bridge/public/board.ts). */
import type { BoardCard } from '@once-upon-a-diff/protocol/types';

export interface AnswerBits {
  /** unread answers to the reviewer's questions in the card's story */
  answers: number;
  /** the chip's text, or null with none */
  chip: string | null;
  /** the line saying what happened, or null */
  note: string | null;
  /** the card offers Open story: it is in Ready or Ready to ship, or has an answer to read */
  openable: boolean;
  /** the card offers Mark reviewed: a local story in Ready that isn't marked, or was rebuilt after it was */
  markable: boolean;
  /** appended to a PR story's link, so the panel opens with the Ask dock open */
  hash: string;
}

export function answerBits(card: Pick<BoardCard, 'column' | 'story'>): AnswerBits {
  const story = card.story;
  const answers = story?.unread_answers ?? 0;
  const approved = !!story?.approved_at && card.column === 'ship';
  const plural = answers === 1;
  return {
    answers,
    chip: answers > 0 ? `${answers} unread ${plural ? 'answer' : 'answers'}` : null,
    note:
      answers > 0
        ? `Claude answered ${plural ? 'a question' : `${answers} questions`} you asked in the story. Open the story to read ${plural ? 'it' : 'them'}.`
        : null,
    openable: card.column === 'ready' || approved || answers > 0,
    markable:
      card.column === 'ready' && story?.kind === 'local' && (!story.reviewed || story.unread),
    hash: answers > 0 ? '#ou-ask' : '',
  };
}
