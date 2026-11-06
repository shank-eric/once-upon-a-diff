/*
 * `once-upon usage`: the usage capture's report and switches. What it keeps, and why, is in core/src/records/usage/.
 */
import {
  CHECKOUT,
  clearUsage,
  isLinkedWorktree,
  readMode,
  readUsageJson,
  usageFileSize,
  writeMode,
  type UsageMode,
} from '@once-upon-a-diff/core/records/usage/control';
import { buildReport, renderReport, sinceDay } from '@once-upon-a-diff/core/records/usage/report';
import { coverageFileOf } from '@once-upon-a-diff/core/records/usage/capture';
import { etClock } from '@once-upon-a-diff/core/records/usage/days';
import type { CoverageFile } from '@once-upon-a-diff/core/records/usage/merge';
import type { ActionsFile } from '@once-upon-a-diff/core/records/usage/counters';
import { out } from '../output.ts';
import type { CliOpts, Command } from '../types.ts';

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** What to say about the bridge's data: how old it is, when it has a time. */
function bridgeNote(age: number | null): string | undefined {
  return age === null
    ? undefined
    : `The bridge flushes its data every 5 minutes: what it holds is ${Math.round(age / 60000)} min old.`;
}

function report(home: string, opts: CliOpts) {
  const now = new Date();
  const since = sinceDay(text(opts.since), text(opts.last), now);
  if ((opts.since || opts.last) && !since) {
    throw new Error('--since takes a day like 2026-11-04, --last takes 24h or 3d');
  }
  // the report reads the files as the bridge last flushed them: the CLI never calls or signals the bridge
  const data = buildReport({ home, root: CHECKOUT, now, since, save: !opts['no-save'] });
  const age = data.sources.bridge.ageMs;
  out(
    opts.json
      ? JSON.stringify(data, null, 2)
      : renderReport(data, { md: !!opts.md, bridgeNote: bridgeNote(age) }),
  );
}

function status(home: string) {
  const mode = readMode(home);
  const bridge = readUsageJson<CoverageFile>(home, coverageFileOf('bridge'));
  const cli = readUsageJson<CoverageFile>(home, coverageFileOf('cli'));
  const actions = readUsageJson<ActionsFile>(home, 'actions.json');
  const when = (iso: string | undefined) => (iso ? etClock(iso) : 'no data');
  out(
    `Usage capture: ${mode === 'off' ? 'off' : `on (${mode === 'lines' ? 'line level, costs CPU' : 'function level'})`}`,
  );
  out(
    `This checkout ${isLinkedWorktree() ? 'is a linked worktree: runs here are not captured' : 'is captured'}.`,
  );
  out(`Bridge: last flush ${when(bridge?.lastFlush)}, ${bridge?.starts ?? 0} start(s)`);
  out(
    `CLI coverage: last new data ${when(cli?.lastFlush)}. Counts: last flush ${when(actions?.lastFlush)}`,
  );
  out(
    `Files: coverage-bridge ${usageFileSize(home, 'coverage-bridge.json')} B, coverage-cli ${usageFileSize(home, 'coverage-cli.json')} B, actions ${usageFileSize(home, 'actions.json')} B, cli-runs ${usageFileSize(home, 'cli-runs.log')} B`,
  );
}

function setMode(home: string, mode: UsageMode) {
  writeMode(home, mode);
  out(
    mode === 'off'
      ? 'Usage capture is off: every process stops counting at its next flush (the bridge within 5 minutes, a CLI run at once). `usage clear` removes what was kept.'
      : `Usage capture is on at ${mode} level. A bridge that started while it was off begins counting at its next restart.`,
  );
}

export const usageCommands: Command[] = [
  {
    name: 'usage',
    subs: ['report', 'status', 'on', 'off', 'clear'],
    usage: [
      '  once-upon usage report [--since YYYY-MM-DD|--last 24h|3d] [--json] [--md] [--no-save]   what has been used, per feature area, from the capture (partial data is fine)',
      '  once-upon usage status | on [--lines] | off | clear                                      the capture: where it stands, switch it, or remove what it kept',
    ],
    async run(home, _cfg, opts) {
      const [verb] = opts._ || [];
      if (verb === 'report') {
        return report(home, opts);
      }
      if (verb === 'status') {
        return status(home);
      }
      if (verb === 'on') {
        return setMode(home, opts.lines ? 'lines' : 'function');
      }
      if (verb === 'off') {
        return setMode(home, 'off');
      }
      if (verb === 'clear') {
        clearUsage(home);
        out('Removed everything the usage capture kept.');
        return;
      }
      throw new Error('usage: once-upon usage report|status|on [--lines]|off|clear');
    },
  },
];
