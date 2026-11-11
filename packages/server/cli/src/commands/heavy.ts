/*
 * `once-upon heavy NAME COMMAND...`: runs a heavy command (a full test suite, a browser run, a whole-repo typecheck or lint,
 * deploy gates) only when no other heavy run on this machine holds the lock, so parallel agents, in any repo, take turns.
 * The command's exit code is this command's. Run through `fnm exec --using=24`, pass the shell's own PATH so the command
 * keeps its Node: `ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy NAME COMMAND...`.
 *
 * `once-upon deploy NAME COMMAND...` is the same run for a repo's deploy command, kept quiet: the output goes to a log
 * (`<home>/logs/deploy-NAME-<time>.log`) and the one line printed is `ok LOG` or `failed LOG`, with the command's exit code
 * (127 when it can't start); the wait for the lock and a command that can't start are noted in the log, never on the terminal,
 * and NAME must be a plain agent name (it is part of the log's path). `COMMAND` is a program and its arguments, not shell syntax. The editor runs it itself in the background, so a deploy costs a line, not an agent.
 */
import path from 'node:path';
import { AGENT_NAME_RE } from '@once-upon-a-diff/terms/patterns';
import { runHeavy } from '@once-upon-a-diff/core/features/heavy/heavy';
import type { CliOpts, Command } from '../types.ts';

/** The name and command words of `heavy NAME COMMAND...` or `deploy NAME COMMAND...` (`NAME -- COMMAND...` also works). */
function words(opts: CliOpts, usage: string): { name: string; command: string[] } {
  const [name, ...rest] = opts._ || [];
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  if (!name || command.length === 0) {
    throw new Error(usage);
  }
  return { name, command };
}

async function heavy(_home: string, _cfg: unknown, opts: CliOpts) {
  const { name, command } = words(opts, 'usage: once-upon heavy NAME COMMAND...');
  process.exitCode = await runHeavy(name, command, (line) => process.stderr.write(line + '\n'));
}

async function deploy(home: string, _cfg: unknown, opts: CliOpts) {
  const { name, command } = words(opts, 'usage: once-upon deploy NAME COMMAND...');
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `usage: once-upon deploy NAME COMMAND...: NAME is a plain agent name (letters, digits, . _ -), not "${name}"`,
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(home, 'logs', `deploy-${name}-${stamp}.log`);
  const code = await runHeavy(name, command, () => {}, process.env, log);
  process.stdout.write(`${code === 0 ? 'ok' : 'failed'} ${log}\n`);
  process.exitCode = code;
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
  {
    name: 'deploy',
    usage: [
      "  once-upon deploy NAME COMMAND...                                                 a repo's deploy command through the heavy lock, its output in <home>/logs/deploy-NAME-<time>.log; prints one line, `ok LOG` or `failed LOG`; its exit code is ours",
    ],
    run: deploy,
  },
];
