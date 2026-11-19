/*
 * `once-upon heavy NAME COMMAND...`: runs a heavy command (a full test suite, a browser run, a whole-repo typecheck or lint,
 * deploy gates) only when no other heavy run on this machine holds the lock, so parallel agents, in any repo, take turns.
 * The command's exit code is this command's. Run through `fnm exec --using=24`, pass the shell's own PATH so the command
 * keeps its Node: `ONCE_UPON_PATH="$PATH" fnm exec --using=24 once-upon heavy NAME COMMAND...`.
 *
 * `once-upon heavy --lane browser NAME COMMAND...` takes the browser lane's own lock instead, for a single-spec browser run, so it
 * does not wait behind the main lock (one lane run at a time; `--lane` leads, before NAME). A deploy never takes a lane.
 *
 * `once-upon deploy NAME COMMAND...` is the same run for a repo's deploy command, kept quiet: the output goes to a log
 * (`<home>/logs/deploy-NAME-<time>.log`) and the one line printed is `ok LOG` or `failed LOG`, with the command's exit code
 * (127 when it can't start); the wait for the lock and a command that can't start are noted in the log, never on the terminal,
 * and NAME must be a plain agent name (it is part of the log's path). `COMMAND` is a program and its arguments, not shell syntax. The editor runs it itself in the background, so a deploy costs a line, not an agent.
 */
import path from 'node:path';
import { AGENT_NAME_RE } from '@once-upon-a-diff/terms/patterns';
import {
  HEAVY_LANES,
  runHeavy,
  type HeavyLane,
  type Waited,
} from '@once-upon-a-diff/core/features/heavy/heavy';
import { readSettings } from '@once-upon-a-diff/foundation/settings';
import { AgentRegistry } from '@once-upon-a-diff/state/records/agents/registry';
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

/** A leading `--lane X` or `--lane=X` (and the words after it), only before NAME. */
function lanePrefix(opts: CliOpts, usage: string): { lane?: HeavyLane; opts: CliOpts } {
  const [first, ...rest] = opts._ || [];
  if (first !== '--lane' && !first?.startsWith('--lane=')) {
    return { opts };
  }
  const value = first === '--lane' ? rest.shift() : first.slice('--lane='.length);
  const lane = HEAVY_LANES.find((one) => one === value);
  if (!lane) {
    throw new Error(usage);
  }
  return { lane, opts: { ...opts, _: rest } };
}

/**
 * The one `heavy` progress line a heavy command leaves in the progress file (`- 3:40 PM NAME 4/6 heavy: ran "yarn test" after waiting
 * 312 s (position 3, behind X)`), so the runs that took the lock, and for what, can be read off the file. It is no beat: the run's
 * step and sign of life stay as they were. A failure to write it is swallowed.
 */
function noteHeavy(home: string, name: string, command: string[], lane?: HeavyLane) {
  return ({ waitedMs, position, holder }: Waited) => {
    try {
      const program = command.join(' ').slice(0, 60);
      const waited =
        position > 0
          ? `after waiting ${Math.round(waitedMs / 1000)} s (position ${position}, behind ${holder})`
          : 'with no wait';
      new AgentRegistry(home, {
        ledger: null,
        progress: readSettings(home).board.progressFile,
      }).progressNote(
        name,
        'heavy',
        `ran "${program}"${lane ? ` on the ${lane} lane` : ''} ${waited}`,
      );
    } catch {
      // the note is a log line, never a reason for the command to fail
    }
  };
}

async function heavy(home: string, _cfg: unknown, opts: CliOpts) {
  const usage = 'usage: once-upon heavy [--lane browser] NAME COMMAND...';
  const { lane, opts: rest } = lanePrefix(opts, usage);
  const { name, command } = words(rest, usage);
  process.exitCode = await runHeavy(
    name,
    command,
    (line) => process.stderr.write(line + '\n'),
    process.env,
    undefined,
    lane,
    { onWaited: noteHeavy(home, name, command, lane) },
  );
}

async function deploy(home: string, _cfg: unknown, opts: CliOpts) {
  const usage = 'usage: once-upon deploy NAME COMMAND...';
  if (opts._?.[0]?.startsWith('--lane')) {
    throw new Error(`${usage}: a deploy takes no lane (it runs on the main lock)`);
  }
  const { name, command } = words(opts, usage);
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `usage: once-upon deploy NAME COMMAND...: NAME is a plain agent name (letters, digits, . _ -), not "${name}"`,
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.join(home, 'logs', `deploy-${name}-${stamp}.log`);
  const code = await runHeavy(name, command, () => {}, process.env, log, undefined, {
    priority: 'deploy',
    onWaited: noteHeavy(home, name, command),
  });
  process.stdout.write(`${code === 0 ? 'ok' : 'failed'} ${log}\n`);
  process.exitCode = code;
}

export const heavyCommands: Command[] = [
  {
    name: 'heavy',
    usage: [
      '  once-upon heavy NAME COMMAND...                                                  run a heavy command when no other one holds the machine-wide lock (~/.cache/heavy-run.lock); its exit code is ours',
      '                                                                                   ONCE_UPON_PATH, when set, is the PATH the command gets (pass "$PATH" under fnm exec so it keeps its own Node)',
      '  once-upon heavy --lane browser NAME COMMAND...                                   a single-spec browser command on its own lock (~/.cache/heavy-run-browser.lock), not behind the main one; everything else stays on the main lock',
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
