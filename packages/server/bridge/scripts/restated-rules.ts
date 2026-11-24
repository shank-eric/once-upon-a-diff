/*
 * Restated rules: a condition written out in the diff that an exported predicate already names (`(item.source ?? 'backlog') ===
 * 'backlog'` where `isListed` exists). Advice for the author hand-back gate and the critic, never a failure: it always exits 0.
 *
 *   git diff -U0 main...HEAD | yarn dup:rules [--json]     only the conditions on added lines
 *   yarn dup:rules --all [--json]                           every condition in the repo, for a count
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLines } from './lib/diff.ts';
import { findHits, type Hit } from './lib/candidates.ts';
import { indexSource, type Index } from './lib/predicates.ts';

const SKIPPED_FOLDERS = new Set([
  'node_modules',
  'vendor',
  'test',
  'tests',
  '.wxt',
  '.output',
  'dist',
  'build',
  'coverage',
]);

/** Every source `.ts` under packages/ (tests, declarations, vendored and built folders left out), repo-relative. */
function sourceFiles(root: string, dir = 'packages'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const here = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) {
      out.push(...sourceFiles(root, here));
    } else if (/\.ts$/.test(entry.name) && !/\.(d|test)\.ts$/.test(entry.name)) {
      out.push(here);
    }
  }
  return out.sort();
}

export interface Result {
  /** whether the input was a diff (it names a file): false for no input or text that is not one */
  read: boolean;
  hits: Hit[];
  notes: Hit[];
}

/** The restatements under `root`: all of them, or only those on the lines a diff added. */
export function restatedRules(root: string, diff: string | null): Result {
  const index: Index = new Map();
  const files = sourceFiles(root);
  const texts = new Map(files.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]));
  for (const [file, text] of texts) {
    indexSource(file, text, index);
  }
  const added = diff === null ? null : addedLines(diff);
  const all: Hit[] = [];
  for (const [file, text] of texts) {
    const ranges = added === null ? null : (added.get(file) ?? []);
    if (ranges === null || ranges.length > 0) {
      all.push(...findHits(file, text, index, ranges));
    }
  }
  all.sort((one, two) => one.file.localeCompare(two.file) || one.line - two.line);
  return {
    read: diff === null || /^\+\+\+ /m.test(diff),
    hits: all.filter((hit) => !hit.note),
    notes: all.filter((hit) => hit.note),
  };
}

const describe = (hit: Hit): string => {
  const call = `${hit.negated ? '!' : ''}${hit.predicate}(...)`;
  return `${hit.file}:${hit.line}  "${hit.text}" restates ${hit.predicate} (${hit.definedAt}): call ${call}`;
};

export function report({ read, hits, notes }: Result): string {
  return [
    ...(read
      ? []
      : ['no diff read (pipe `git diff -U0 <base>...HEAD`): 0 here means nothing was looked at']),
    ...hits.map(describe),
    ...notes.map((note) => `note ${describe(note)}`),
    `restated rules: ${hits.length}`,
    `notes (a single comparison, often a different rule): ${notes.length}`,
  ].join('\n');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  if (!all && process.stdin.isTTY) {
    console.log(
      'usage: git diff -U0 <base>...HEAD | yarn dup:rules [--json]   or   yarn dup:rules --all [--json]',
    );
    return;
  }
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const result = restatedRules(root, all ? null : await readStdin());
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : report(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
