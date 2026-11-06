/*
 * `once-upon beat NAME N/M STEP [NOTE...]`: an agent's progress beat. It appends `- 3:40 PM NAME N/M STEP: NOTE` to the
 * file `board_progress_file` names (no setting, no file) and records the beat on the agent's open run, which is the
 * agent's sign of life. The same as `agent beat`, except that a beat for an agent that was never registered still
 * reaches the progress file, with a warning, so a beat is never lost for a missing registration. A bare N means N/6, the
 * default steps (1 read, 2 plan, 3 code, 4 tests, 5 green, 6 done); the last beat of a plan is M/M. It reads no
 * folder-based settings, so where it runs from changes nothing. A note that starts with -- goes after a bare `--`.
 */
import { ownSession } from '@once-upon-a-diff/core/features/listeners/service';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
import type { CliOpts, Command } from '../types.ts';

const USAGE = 'usage: once-upon beat NAME N/M STEP [NOTE...] [--sid SID8] [--run ID]';

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function beat(home: string, _cfg: unknown, opts: CliOpts) {
  const [name, rawStep, label, ...note] = opts._ || [];
  if (!name || !rawStep || !label) {
    throw new Error(USAGE);
  }
  const step = /^\d+$/.test(rawStep) ? `${rawStep}/6` : rawStep;
  const [done, total] = step.split('/');
  if (!/^[1-9]\d?\/[1-9]\d?$/.test(step) || Number(done) > Number(total)) {
    throw new Error(`the step must be N/M with 1 <= N <= M <= 99, got '${rawStep}'`);
  }
  const registry = new AgentRegistry(home, {
    ledger: null,
    progress: readSettings(home).board.progressFile,
  });
  registry.beatOrLog(
    name,
    {
      n: done,
      of: total,
      step: label,
      note: note.join(' '),
      sid: text(opts.sid),
      run: text(opts.run),
      prefer: ownSession()?.slice(0, 8) ?? null,
    },
    (line) => process.stderr.write(line + '\n'),
  );
}

export const beatCommands: Command[] = [
  {
    name: 'beat',
    usage: [
      "  once-upon beat NAME N/M STEP [NOTE...]                                           an agent's progress beat: a line in board_progress_file and a sign of life on its run",
      '                                                                                   N/M is where the agent is in its own plan (bare N means N/6), the last beat is M/M; STEP is one word',
    ],
    run: beat,
  },
];
