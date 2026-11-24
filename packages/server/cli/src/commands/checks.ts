/*
 * `once-upon doctor`: is everything connected?
 */
import { doctor } from '@once-upon-a-diff/core/orchestration/bridge/doctor';
import {
  compactLogs,
  liveSessionIds,
} from '@once-upon-a-diff/core/orchestration/bridge/compact-logs';
import { out } from '../output.ts';
import type { Config } from '@once-upon-a-diff/foundation/settings';
import type { CliOpts, Command } from '../types.ts';

async function runDoctor(home: string, cfg: Config, opts: CliOpts) {
  const days = opts['keep-days'];
  if (days !== undefined && !(Number(days) >= 0)) {
    throw new Error('--keep-days takes a number of days, 0 or more');
  }
  const ok = await doctor(home, cfg, {
    port: opts.port as string | undefined,
    wait: Number(opts.wait) || 0,
    fix: opts.fix === true,
    ...(opts['keep-days'] === undefined ? {} : { keepDays: Number(opts['keep-days']) }),
    out,
  });
  if (!ok) {
    process.exitCode = 1;
  }
}

/** A number of days (0 or more) from a flag, or undefined when it is not given. */
function daysFlag(opts: CliOpts, flag: string): number | undefined {
  const days = opts[flag];
  if (days === undefined) {
    return undefined;
  }
  if (!(Number(days) >= 0)) {
    throw new Error(`--${flag} takes a number of days, 0 or more`);
  }
  return Number(days);
}

async function runCompact(home: string, _cfg: Config, opts: CliOpts) {
  const keepDays = daysFlag(opts, 'keep-days');
  const archiveDays = daysFlag(opts, 'archive-days');
  const report = compactLogs(home, {
    ...(keepDays === undefined ? {} : { keepDays }),
    ...(archiveDays === undefined ? {} : { archiveDays }),
    dryRun: opts['dry-run'] === true,
    // a session still running keeps its card; with a registry that cannot be trusted, every session card stays
    liveSessions: await liveSessionIds(home),
  });
  out(
    report.length
      ? report.join('\n')
      : 'nothing in agents.jsonl, backlog.jsonl or inbox.jsonl to drop',
  );
}

export const checkCommands: Command[] = [
  {
    name: 'doctor',
    usage: [
      '  once-upon doctor  [--port N] [--wait S]                       is everything connected? a pass/fail list with fixes',
      '                    (--wait: give a bridge that was just started up to S seconds to answer)',
      "  once-upon doctor --fix [--keep-days N]                        compact the logs like `once-upon compact` (runs over N days old, 30, go) and fold a story's old reviewed.json and approved.json into review.json",
    ],
    run: runDoctor,
  },
  {
    name: 'compact',
    usage: [
      '  once-upon compact [--dry-run] [--keep-days N] [--archive-days N]  shrink agents.jsonl, backlog.jsonl and inbox.jsonl: runs over --archive-days (30) old on a done or dropped card,',
      '                    and the idle stored cards no run names, move to <home>/archive/<store>-YYYY-MM.jsonl (the board never reads it, `card status` does);',
      '                    every run keeps its last beat (a finished run newer than --keep-days, 0, keeps all of them); the chapter reads, positions and build lines go;',
      '                    the latest old log is kept as <file>.<yyyymmdd>.bak. --dry-run writes nothing and prints what would change',
    ],
    run: runCompact,
  },
];
