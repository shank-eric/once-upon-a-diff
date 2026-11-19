/*
 * `once-upon usage report`: merges the stored coverage, route counts, UI action counts and the CLI command log into one
 * view per feature area. It works on partial data and says how much it has (the window, each source's last flush, a banner
 * under a week), takes a window (`since`), and says what changed since the last report from a small counts-only snapshot
 * (last-report.json). Reads the checkout's files to size them; writes only that snapshot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ACTIONS, AREAS, type Area } from '@once-upon-a-diff/terms/usage-actions';
import { readUsageJson, readUsageText, writeUsageJson } from './adapters/usage-file.ts';
import {
  COMMAND_AREAS,
  POLLED_ROUTES,
  ROUTE_AREAS,
  UNCOUNTED_ROUTES,
  areaOfPath,
  type AreaOrNone,
} from './areas.ts';
import { CLI_LOG } from './cli-log.ts';
import { coverageFileOf } from './capture.ts';
import type { ActionsFile } from './counters.ts';
import { etClock, etDay, spanText } from './days.ts';
import { andBits, countBits, fromBase64, nonBlankLines, shaOf } from './lines.ts';
import { asCoverage, type CoverageEntry, type CoverageFile } from './merge.ts';

const PARTIAL_UNDER_MS = 7 * 86400000;
const LAST_REPORT = 'last-report.json';
/** The code the bridge process can load: coverage can say a file here never ran. The rest (browser code) has action counts only. */
const NODE_SCOPE = [
  'packages/server-libs/adapters/src/',
  'packages/server-libs/foundation/src/',
  'packages/server-libs/stories/src/',
  'packages/server-libs/usage/src/',
  'packages/server-libs/state/src/',
  'packages/server-libs/core/src/',
  'packages/server-libs/board/src/',
  'packages/server/server/src/',
  'packages/server/cli/src/',
  'packages/domain/contracts/src/',
  'skills/',
];
const SKIP_DIR = new Set(['node_modules', 'vendor', 'test', 'build', '.output', 'dist']);

interface FileUse {
  path: string;
  area: AreaOrNone;
  /** lines with code, from the file on disk */
  codeLines: number;
  /** lines no take ever ran, for the version on disk; null when the file was never loaded */
  uncovered: number | null;
  /** coverage was taken on an older version of the file than the one on disk */
  stale: boolean;
  mode: 'function' | 'lines' | null;
}

interface AreaUse {
  area: Area | 'Unassigned';
  files: number;
  codeLines: number;
  uncoveredLines: number;
  neverLoaded: string[];
  routesTotal: number;
  routeCalls: number;
  routesZero: string[];
  commandsTotal: number;
  commandRuns: number;
  commandsZero: string[];
  actionsTotal: number;
  actionCounts: number;
  actionsZero: string[];
}

export interface Report {
  generatedAt: string;
  /** the window the counts cover */
  from: string;
  to: string;
  /** the window was narrowed by `since` (coverage stays "since start") */
  narrowed: boolean;
  partial: boolean;
  sources: {
    bridge: {
      since: string | null;
      lastFlush: string | null;
      starts: number;
      ageMs: number | null;
    };
    cli: { since: string | null; lastFlush: string | null };
    actions: { since: string | null; lastFlush: string | null };
  };
  cliRuns: number;
  areas: AreaUse[];
  files: FileUse[];
  routes: Record<string, number>;
  ui: Record<string, number>;
  commands: Record<string, number>;
  unmatched: number;
  unknownDropped: number;
  growth: { day: string; uncovered: number }[];
  since_last: SinceLast | null;
}

interface SinceLast {
  at: string;
  newlyCoveredLines: Record<string, number>;
  firstHits: string[];
  movers: { name: string; delta: number }[];
  newRestarts: number;
}

interface Snapshot {
  at: string;
  uncoveredByArea: Record<string, number>;
  counts: Record<string, number>;
  zero: string[];
  starts: number;
}

/** The files of the checkout the coverage could speak about, relative to it. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIR.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name));
        }
      } else if (/\.(ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const start of ['packages', 'skills']) {
    try {
      walk(start);
    } catch {
      /* no such folder in this checkout */
    }
  }
  return out.filter(
    (file) =>
      file.includes('/src/') ||
      file.startsWith('skills/') ||
      file.includes('/bin/') ||
      file.includes('/public/'),
  );
}

/** Run before the counting starts (UNMEASURED in usage/src/adapters/session.ts), so never reported: it sat in bridge/bin, outside the scope, before the split. */
const NOT_REPORTED = ['packages/server-libs/foundation/src/node-version.mjs'];
const inNodeScope = (file: string) =>
  NODE_SCOPE.some((prefix) => file.startsWith(prefix)) && !NOT_REPORTED.includes(file);

/** The windows' start as a day, from `--since YYYY-MM-DD` or `--last 24h|3d`. */
export function sinceDay(
  since: string | undefined,
  last: string | undefined,
  now: Date,
): string | null {
  if (since) {
    return /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : null;
  }
  const match = last ? /^(\d+)([hd])$/.exec(last) : null;
  if (!match) {
    return null;
  }
  const millis = Number(match[1]) * (match[2] === 'h' ? 3600000 : 86400000);
  return etDay(now.getTime() - millis);
}

/** A name and how many times it was counted. */
type Counts = Record<string, number>;

/** The route, UI action and unmatched counts of the days in the window. */
function windowCounts(
  actions: ActionsFile | null,
  inWindow: (day: string) => boolean,
): { routes: Counts; uiCounts: Counts; unmatched: number; unknownDropped: number } {
  const routes: Counts = {};
  const uiCounts: Counts = {};
  let unmatched = 0;
  let unknownDropped = 0;
  for (const [day, counts] of Object.entries(actions?.days ?? {})) {
    if (!inWindow(day)) {
      continue;
    }
    for (const table of Object.values(counts.routes ?? {})) {
      for (const [key, total] of Object.entries(table)) {
        if (key === 'unmatched') {
          unmatched += total;
        } else {
          routes[key] = (routes[key] ?? 0) + total;
        }
      }
    }
    for (const table of Object.values(counts.ui ?? {})) {
      for (const [key, total] of Object.entries(table)) {
        uiCounts[key] = (uiCounts[key] ?? 0) + total;
      }
    }
    unknownDropped += counts.unknownDropped ?? 0;
  }
  return { routes, uiCounts, unmatched, unknownDropped };
}

/** The CLI log's runs per command label in the window, and how many runs there were. */
function commandCounts(
  log: string,
  inWindow: (day: string) => boolean,
): { commands: Counts; cliRuns: number } {
  const commands: Counts = {};
  let cliRuns = 0;
  for (const line of log.split('\n')) {
    const [day, label] = line.split(' ');
    if (day && label && inWindow(day)) {
      commands[label] = (commands[label] ?? 0) + 1;
      cliRuns++;
    }
  }
  return { commands, cliRuns };
}

/** Whether a logged command label is the command or one of its subcommands (`backlog.add` is a `backlog`). */
const isCommandLabel = (label: string, name: string) =>
  label === name || label.startsWith(`${name}.`);

/** Whether a route is one a person's use of the feature would hit, and nothing hit it: a poll or an uncounted route says nothing. */
const isRouteZero = (key: string, routes: Counts) =>
  !routes[key] && !POLLED_ROUTES.has(key) && !UNCOUNTED_ROUTES.has(key);

/** One source file joined with the stored coverage of its versions, or null when it cannot be read. */
function fileUse(
  root: string,
  rel: string,
  bridge: CoverageFile,
  cli: CoverageFile,
): FileUse | null {
  let text = '';
  try {
    text = readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
  const sha = shaOf(text);
  const versions = [...(bridge.files[rel] ?? []), ...(cli.files[rel] ?? [])];
  const exact = versions.filter((entry) => entry.sha === sha);
  const pool = exact.length ? exact : versions.slice(0, 1);
  let bits: Uint8Array | null = null;
  let mode: FileUse['mode'] = null;
  for (const entry of pool) {
    bits = bits ? andBits(bits, fromBase64(entry.uncovered)) : fromBase64(entry.uncovered);
    mode = mode === 'function' || entry.mode === 'function' ? 'function' : 'lines';
  }
  return {
    path: rel,
    area: areaOfPath(rel),
    codeLines: nonBlankLines(text),
    uncovered: bits ? countBits(bits) : null,
    stale: !exact.length && versions.length > 0,
    mode,
  };
}

/** A feature area with nothing counted yet. */
const emptyAreaUse = (area: AreaOrNone): AreaUse => ({
  area,
  files: 0,
  codeLines: 0,
  uncoveredLines: 0,
  neverLoaded: [],
  routesTotal: 0,
  routeCalls: 0,
  routesZero: [],
  commandsTotal: 0,
  commandRuns: 0,
  commandsZero: [],
  actionsTotal: 0,
  actionCounts: 0,
  actionsZero: [],
});

/** Adds the files the bridge can load to their areas: lines, and the files never loaded. */
function addFiles(areaOf: (name: AreaOrNone) => AreaUse, files: FileUse[]): void {
  for (const file of files.filter((one) => inNodeScope(one.path))) {
    const row = areaOf(file.area);
    row.files++;
    row.codeLines += file.codeLines;
    if (file.uncovered === null) {
      row.neverLoaded.push(file.path);
      row.uncoveredLines += file.codeLines;
    } else {
      row.uncoveredLines += file.uncovered;
    }
  }
}

/** Adds each route to its area: how many there are, their calls (a poll's are not use) and the ones nothing hit. */
function addRoutes(areaOf: (name: AreaOrNone) => AreaUse, routes: Counts): void {
  for (const [key, area] of Object.entries(ROUTE_AREAS)) {
    const row = areaOf(area);
    row.routesTotal++;
    row.routeCalls += POLLED_ROUTES.has(key) ? 0 : (routes[key] ?? 0);
    if (isRouteZero(key, routes)) {
      row.routesZero.push(key);
    }
  }
}

/** Adds each command to its area: how many there are, their runs and the ones never run. */
function addCommands(areaOf: (name: AreaOrNone) => AreaUse, commands: Counts): void {
  for (const [name, area] of Object.entries(COMMAND_AREAS)) {
    const row = areaOf(area);
    row.commandsTotal++;
    const runs = Object.entries(commands)
      .filter(([label]) => isCommandLabel(label, name))
      .reduce((sum, [, total]) => sum + total, 0);
    row.commandRuns += runs;
    // `usage` is never logged (a report must not count itself), so its zero says nothing
    if (!runs && name !== 'usage') {
      row.commandsZero.push(name);
    }
  }
}

/** Adds each UI action to its area: how many there are, their counts and the ones never taken. */
function addActions(areaOf: (name: AreaOrNone) => AreaUse, uiCounts: Counts): void {
  for (const [name, { area }] of Object.entries(ACTIONS)) {
    const row = areaOf(area);
    row.actionsTotal++;
    row.actionCounts += uiCounts[name] ?? 0;
    if (!uiCounts[name]) {
      row.actionsZero.push(name);
    }
  }
}

/** The per-area rows, every area present even when nothing was counted for it. */
function areaRows(files: FileUse[], routes: Counts, commands: Counts, uiCounts: Counts): AreaUse[] {
  const areas = new Map<string, AreaUse>();
  const areaOf = (name: AreaOrNone): AreaUse => {
    let row = areas.get(name);
    if (!row) {
      row = emptyAreaUse(name);
      areas.set(name, row);
    }
    return row;
  };
  for (const name of AREAS) {
    areaOf(name);
  }
  addFiles(areaOf, files);
  addRoutes(areaOf, routes);
  addCommands(areaOf, commands);
  addActions(areaOf, uiCounts);
  return [...areas.values()];
}

/** Coverage growth by day: the current versions' uncovered counts, carried forward. */
function coverageGrowth(
  bridge: CoverageFile,
  cli: CoverageFile,
  inWindow: (day: string) => boolean,
): Report['growth'] {
  const days = new Set<string>();
  const perFile: { day: string; value: number; path: string }[] = [];
  for (const [rel, entries] of [...Object.entries(bridge.files), ...Object.entries(cli.files)]) {
    const entry: CoverageEntry | undefined = entries[0];
    for (const [day, value] of Object.entries(entry?.dayUncovered ?? {})) {
      days.add(day);
      perFile.push({ day, value, path: rel });
    }
  }
  return [...days]
    .sort()
    .filter(inWindow)
    .map((day) => {
      const latest = new Map<string, number>();
      for (const item of perFile
        .filter((one) => one.day <= day)
        .sort((left, right) => left.day.localeCompare(right.day))) {
        latest.set(item.path, Math.min(item.value, latest.get(item.path) ?? Infinity));
      }
      return { day, uncovered: [...latest.values()].reduce((sum, total) => sum + total, 0) };
    });
}

/** What each source (bridge, CLI, actions) says about when it started and last flushed. */
function sourcesOf(
  stored: { bridge: CoverageFile | null; cli: CoverageFile | null; actions: ActionsFile | null },
  bridgeStarts: number,
  now: Date,
): Report['sources'] {
  const bridgeFlush = stored.bridge?.lastFlush ?? null;
  return {
    bridge: {
      since: stored.bridge?.since ?? null,
      lastFlush: bridgeFlush,
      starts: bridgeStarts,
      ageMs: bridgeFlush ? now.getTime() - new Date(bridgeFlush).getTime() : null,
    },
    cli: { since: stored.cli?.since ?? null, lastFlush: stored.cli?.lastFlush ?? null },
    actions: { since: stored.actions?.since ?? null, lastFlush: stored.actions?.lastFlush ?? null },
  };
}

/** Every counted thing under its kind (`route x`, `action x`, `command x`), for the snapshot's movers. */
function snapshotCounts(routes: Counts, uiCounts: Counts, commands: Counts): Counts {
  const counts: Counts = {};
  for (const [kind, table] of [
    ['route', routes],
    ['action', uiCounts],
    ['command', commands],
  ] as const) {
    for (const [key, total] of Object.entries(table)) {
      counts[`${kind} ${key}`] = total;
    }
  }
  return counts;
}

/** The routes, actions and commands nothing used, each under its kind, for the snapshot's first hits. */
function zeroUses(routes: Counts, uiCounts: Counts, commands: Counts): string[] {
  return [
    ...Object.keys(ROUTE_AREAS)
      .filter((key) => isRouteZero(key, routes))
      .map((key) => `route ${key}`),
    ...Object.keys(ACTIONS)
      .filter((key) => !uiCounts[key])
      .map((key) => `action ${key}`),
    ...Object.keys(COMMAND_AREAS)
      .filter(
        (name) =>
          name !== 'usage' && !Object.keys(commands).some((label) => isCommandLabel(label, name)),
      )
      .map((name) => `command ${name}`),
  ];
}

/** What changed since the last report's snapshot. */
function sinceLastReport(
  last: Snapshot,
  areas: AreaUse[],
  counts: Counts,
  zero: string[],
  bridgeStarts: number,
): SinceLast {
  const zeroBefore = new Set(last.zero ?? []);
  return {
    at: last.at,
    newlyCoveredLines: Object.fromEntries(
      areas
        .map(
          (row) =>
            [
              row.area,
              (last.uncoveredByArea?.[row.area] ?? row.uncoveredLines) - row.uncoveredLines,
            ] as const,
        )
        .filter(([, delta]) => delta > 0),
    ),
    firstHits: [...zeroBefore].filter((item) => !zero.includes(item)),
    movers: Object.entries(counts)
      .map(([name, total]) => ({ name, delta: total - (last.counts?.[name] ?? 0) }))
      .filter((item) => item.delta > 0)
      .sort((left, right) => right.delta - left.delta)
      .slice(0, 8),
    newRestarts: Math.max(0, bridgeStarts - (last.starts ?? 0)),
  };
}

/** The report for a window, from the stored coverage, route and action counts and the CLI log; `save` moves the baseline. */
export function buildReport(input: {
  home: string;
  root: string;
  now?: Date;
  since?: string | null;
  save?: boolean;
}): Report {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const bridge = asCoverage(readUsageJson(input.home, coverageFileOf('bridge')), stamp);
  const cli = asCoverage(readUsageJson(input.home, coverageFileOf('cli')), stamp);
  const bridgeStored = readUsageJson<CoverageFile>(input.home, coverageFileOf('bridge'));
  const cliStored = readUsageJson<CoverageFile>(input.home, coverageFileOf('cli'));
  const actions = readUsageJson<ActionsFile>(input.home, 'actions.json');
  const sinceKey = input.since ?? null;
  const inWindow = (day: string) => !sinceKey || day >= sinceKey;

  const { routes, uiCounts, unmatched, unknownDropped } = windowCounts(actions, inWindow);
  const { commands, cliRuns } = commandCounts(readUsageText(input.home, CLI_LOG), inWindow);
  // files: the sources on disk, joined with the stored coverage
  const files = sourceFiles(input.root)
    .map((rel) => fileUse(input.root, rel, bridge, cli))
    .filter((file): file is FileUse => file !== null);

  const stored = { bridge: bridgeStored, cli: cliStored, actions };
  const starts = [bridgeStored?.since, cliStored?.since, actions?.since].filter(
    (value): value is string => !!value,
  );
  const ends = [bridgeStored?.lastFlush, cliStored?.lastFlush, actions?.lastFlush].filter(
    (value): value is string => !!value,
  );
  const from = starts.length ? starts.sort()[0] : stamp;
  const until = ends.length ? ends.sort().at(-1)! : stamp;

  const report: Report = {
    generatedAt: stamp,
    from,
    to: until,
    narrowed: !!sinceKey,
    partial: now.getTime() - new Date(from).getTime() < PARTIAL_UNDER_MS,
    sources: sourcesOf(stored, bridge.starts, now),
    cliRuns,
    areas: areaRows(files, routes, commands, uiCounts),
    files,
    routes,
    ui: uiCounts,
    commands,
    unmatched,
    unknownDropped,
    growth: coverageGrowth(bridge, cli, inWindow),
    since_last: null,
  };

  // what changed since the last report
  const last = readUsageJson<Snapshot>(input.home, LAST_REPORT);
  const counts = snapshotCounts(routes, uiCounts, commands);
  const zero = zeroUses(routes, uiCounts, commands);
  if (last && typeof last.at === 'string') {
    report.since_last = sinceLastReport(last, report.areas, counts, zero, bridge.starts);
  }
  // only a full report moves the baseline: windowed counts saved as it would make the next full one all "movers"
  if (input.save && !sinceKey) {
    writeUsageJson(input.home, LAST_REPORT, {
      at: stamp,
      uncoveredByArea: Object.fromEntries(
        report.areas.map((row) => [row.area, row.uncoveredLines]),
      ),
      counts,
      zero,
      starts: bridge.starts,
    } satisfies Snapshot);
  }
  return report;
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '-');

/** The report as text (or markdown tables with `md`). */
export function renderReport(
  report: Report,
  opts: { md?: boolean; bridgeNote?: string } = {},
): string {
  const lines: string[] = [];
  const span = spanText(new Date(report.to).getTime() - new Date(report.from).getTime());
  lines.push(`Usage report, ${etClock(report.generatedAt)}`);
  lines.push(
    `Window: ${etClock(report.from)} to ${etClock(report.to)} (${span} of data${report.narrowed ? ', counts narrowed by --since, coverage is still since the start' : ''}).`,
  );
  const { bridge, cli, actions } = report.sources;
  lines.push(
    `Sources: bridge ${bridge.lastFlush ? `flushed ${etClock(bridge.lastFlush)}, ${bridge.starts} start(s)` : 'no data'}; CLI coverage ${cli.lastFlush ? `last new data ${etClock(cli.lastFlush)}` : 'no data'}, ${report.cliRuns} runs logged; counts ${actions.lastFlush ? `flushed ${etClock(actions.lastFlush)}` : 'no data'}.`,
  );
  if (opts.bridgeNote) {
    lines.push(opts.bridgeNote);
  }
  if (report.partial) {
    lines.push(
      `PARTIAL: under a week of data. A zero is weak evidence; a hit is solid. Coverage is function level unless \`usage on --lines\` was set.`,
    );
  }
  if (report.unmatched || report.unknownDropped) {
    lines.push(
      `Not counted by name: ${report.unmatched} unmatched call(s), ${report.unknownDropped} unknown action name(s) dropped.`,
    );
  }
  lines.push('');
  const sep = opts.md ? ' | ' : '  ';
  const row = (cells: (string | number)[]) =>
    opts.md
      ? `| ${cells.join(sep)} |`
      : cells
          .map((cell, i) => (i === 0 ? String(cell).padEnd(36) : String(cell).padStart(14)))
          .join('');
  lines.push(
    row([
      'Area',
      'code lines',
      'never ran',
      'files unseen',
      'route calls',
      'cmd runs',
      'UI counts',
    ]),
  );
  if (opts.md) {
    lines.push('|---|---|---|---|---|---|---|');
  }
  for (const area of report.areas) {
    lines.push(
      row([
        area.area,
        area.codeLines || '-',
        area.codeLines
          ? `${area.uncoveredLines} (${pct(area.uncoveredLines, area.codeLines)})`
          : '-',
        area.files ? `${area.neverLoaded.length}/${area.files}` : '-',
        area.routeCalls,
        area.commandRuns,
        area.actionCounts,
      ]),
    );
  }
  const section = (title: string, items: string[]) => {
    if (items.length) {
      lines.push('', `${title} (${items.length}):`, ...items.map((item) => `  ${item}`));
    }
  };
  const evidence = `0 in ${span}`;
  section(
    `Routes with no calls, ${evidence} (polled routes left out)`,
    report.areas.flatMap((left) => left.routesZero.map((key) => `${key}  [${left.area}]`)),
  );
  section(
    `CLI commands with no runs, ${evidence}`,
    report.areas.flatMap((left) => left.commandsZero.map((name) => `${name}  [${left.area}]`)),
  );
  section(
    `UI actions with no counts, ${evidence}`,
    report.areas.flatMap((left) => left.actionsZero.map((name) => `${name}  [${left.area}]`)),
  );
  section(
    'Files never loaded (node side)',
    report.areas.flatMap((left) => left.neverLoaded.map((file) => `${file}  [${left.area}]`)),
  );
  const biggest = report.files
    .filter((file) => file.uncovered !== null && file.uncovered > 0)
    .sort((left, right) => (right.uncovered ?? 0) - (left.uncovered ?? 0))
    .slice(0, 15)
    .map(
      (file) =>
        `${file.path}: ${file.uncovered}/${file.codeLines} lines never ran${file.stale ? ' (older version of the file)' : ''}`,
    );
  section('Most code that never ran in loaded files', biggest);
  if (report.growth.length) {
    lines.push(
      '',
      `Never-ran lines by day: ${report.growth.map((point) => `${point.day} ${point.uncovered}`).join(', ')}`,
    );
  }
  const top = (table: Record<string, number>) =>
    Object.entries(table)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([name, total]) => `${name} ${total}`)
      .join(', ');
  lines.push(
    '',
    `Top routes: ${top(report.routes) || 'none yet'}`,
    `Top UI actions: ${top(report.ui) || 'none yet'}`,
    `Top commands: ${top(report.commands) || 'none yet'}`,
  );
  if (report.since_last) {
    const last = report.since_last;
    lines.push('', `Since the last report (${etClock(last.at)}):`);
    lines.push(
      `  newly covered lines: ${
        Object.entries(last.newlyCoveredLines)
          .map(([area, total]) => `${area} ${total}`)
          .join(', ') || 'none'
      }`,
    );
    lines.push(`  first hits on things that had none: ${last.firstHits.join(', ') || 'none'}`);
    lines.push(
      `  biggest movers: ${last.movers.map((mover) => `${mover.name} +${mover.delta}`).join(', ') || 'none'}`,
    );
    lines.push(`  bridge restarts: ${last.newRestarts}`);
  } else {
    lines.push(
      '',
      report.narrowed
        ? 'No earlier report to compare with (a report narrowed by --since is not saved).'
        : 'No earlier report to compare with (this one is saved for the next).',
    );
  }
  return lines.join('\n');
}
