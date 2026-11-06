/*
 * `once-upon heavy NAME COMMAND...`: runs a heavy command (a full test suite, a browser run, a whole-repo typecheck or lint,
 * deploy gates) only when no other heavy run on this machine holds the lock, so parallel agents, in any repo, take turns.
 * The command's exit code is this command's. Run through `fnm exec --using=24`, pass the shell's own PATH so the command
 * keeps its Node: `ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy NAME COMMAND...`.
 */
import { runHeavy } from '@once-upon-a-diff/core/features/heavy/heavy';
import type { CliOpts, Command } from '../types.ts';

const USAGE = 'usage: once-upon heavy NAME COMMAND...';

async function heavy(_home: string, _cfg: unknown, opts: CliOpts) {
  const [name, ...rest] = opts._ || [];
  const command = rest[0] === '--' ? rest.slice(1) : rest; // `heavy NAME -- COMMAND...` also works
  if (!name || command.length === 0) {
    throw new Error(USAGE);
  }
  process.exitCode = await runHeavy(name, command, (line) => process.stderr.write(line + '\n'));
}

export const heavyCommands: Command[] = [
  {
    name: 'heavy',
    usage: [
      '  once-upon heavy NAME COMMAND...                                                  run a heavy command when no other one holds the machine-wide lock (~/.cache/heavy-run.lock); its exit code is ours',
      '                                                                                   ONCE_UPON_PATH, when set, is the PATH the command gets (pass "$PATH" under fnm exec so it keeps its own Node)',
    ],
    run: heavy,
  },
];
