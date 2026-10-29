/**
 * What a session that owns the story's agent sends it for a question (`wait` prints it, and `--json` carries it as
 * `relay.message`). The session forwards the message with SendMessage and starts its wait again. The agent, resumed with
 * its context, answers with `once-upon answer` itself, so the panel shows its answer under the question.
 */
import { cliCommand } from '../listeners/listeners.ts';
import type { QuestionEntry } from './inbox.ts';

/** The message for `agent` about this question. `cli` is how to run once-upon from a shell. */
export function relayMessage(
  question: Pick<QuestionEntry, 'id' | 'story' | 'step' | 'chapter' | 'file' | 'text' | 'channel'>,
  agent: string,
  cli: string = cliCommand(),
): string {
  const where = [
    question.chapter || (question.step != null ? `step ${question.step}` : ''),
    question.file,
  ]
    .filter(Boolean)
    .join(', ');
  const voice = question.channel === 'voice';
  return [
    `A question came in on the Once Upon story you built (${question.story}). You have the context, so it's yours to answer.`,
    `Question ${question.id}${where ? ` (${where})` : ''}${voice ? ', asked by voice' : ''}, in the reviewer's words:`,
    '---',
    question.text,
    '---',
    '1. First thing, before anything else, so the panel shows you have it: ' +
      `${cli} asking --question ${question.id} --consumer ${agent} --note "<few words>". ` +
      'If it says the question is already answered or was dismissed, stop there: it was asked again and someone else has it.',
    '2. Answer it from what you know of the build and the code, in a few plain sentences, and the panel shows it under the question: ' +
      `${cli} answer --question ${question.id} --consumer ${agent} --file <scratchpad>/answer-${question.id}.md (or --text "…")`,
    voice
      ? '3. It was asked by voice: after you answer, SendMessage the main session the answer in two short spoken sentences.'
      : '3. Reply in chat with one line only.',
  ].join('\n');
}
