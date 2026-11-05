/*
 * The CLI's command log, <home>/usage/cli-runs.log: one line per run, `YYYY-MM-DD command` or `YYYY-MM-DD command.verb`.
 * Only a command in the CLI's table is written by name (anything else is `unknown`), and a verb only when the command
 * lists its verbs; a free-text argument, a flag or an id can never reach the file. Capped at 1 MB.
 */
import { appendUsageLine } from '../../adapters/stores/usage-file.ts';
import { isRunning } from '../../adapters/usage/session.ts';
import { etDay } from './days.ts';

export const CLI_LOG = 'cli-runs.log';
const CAP_BYTES = 1024 * 1024;

/** The log's name for a run: the command when the table has it (else `unknown`), plus the first word when it is one of `subs`. */
export function commandLabel(
  command: string | undefined,
  known: ReadonlySet<string>,
  subs: readonly string[] | undefined,
  firstWord: string | undefined,
): string {
  const name = command && known.has(command) ? command : 'unknown';
  return name !== 'unknown' && firstWord && subs?.includes(firstWord)
    ? `${name}.${firstWord}`
    : name;
}

/** Records one run, when the capture is on in this process. Never throws. */
export function noteCommand(home: string, label: string, now = new Date()): void {
  if (!isRunning()) {
    return;
  }
  try {
    appendUsageLine(home, CLI_LOG, `${etDay(now)} ${label}`, CAP_BYTES);
  } catch {
    /* the log is a convenience */
  }
}
