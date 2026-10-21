/*
 * `diff-story doctor` and `diff-story backstory`: is everything connected,
 * and the Claude Code sessions behind a commit range.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { doctor } from '../doctor.mjs';
import { findBackstory, briefOf } from '../../backstory/index.mjs';
import { out } from '../output.mjs';

async function runDoctor(home, cfg, opts) {
  const ok = await doctor(home, cfg, { port: opts.port, out });
  if (!ok) {
    process.exitCode = 1;
  }
}

function summaryOf(backstory, file) {
  if (!backstory.found) {
    return `No backstory: ${backstory.reason || 'no Claude Code session made these changes'}\n`;
  }
  const total = Object.keys(backstory.files).length;
  const made = backstory.commits.filter((commit) => commit.made_in).length;
  return (
    `Backstory: ${backstory.moments.length} moments in ${backstory.sessions.length} session(s); ${total - backstory.unmatched.length} of ${total} files matched, ` +
    `${made} of ${backstory.commits.length} commits${file ? ` (${file})` : ''}\n`
  );
}

function backstory(home, cfg, opts) {
  if (!opts.repo || !opts.base) {
    throw new Error(
      'usage: diff-story backstory --repo DIR --base REF [--head REF] [-o FILE] [--brief]',
    );
  }
  const found = findBackstory({
    repo: path.resolve(opts.repo),
    base: opts.base,
    head: opts.head || 'HEAD',
    since: opts.since,
    until: opts.until,
    excludeAgents: opts.excludeAgents,
    work: opts.work,
    log: (line) => process.stderr.write(line + '\n'),
  });
  const file = opts.o || opts.out;
  if (file) {
    writeFileSync(path.resolve(file), JSON.stringify(found, null, 2));
  }
  process.stderr.write(summaryOf(found, file));
  if (opts.brief || !file) {
    out(JSON.stringify(opts.brief ? briefOf(found) : found, null, 2));
  }
}

export const checkCommands = [
  {
    name: 'doctor',
    usage: [
      '  diff-story doctor  [--port N]                                  is everything connected? a pass/fail list with fixes',
    ],
    run: runDoctor,
  },
  {
    name: 'backstory',
    usage: [
      '  diff-story backstory --repo DIR --base REF [--head REF] [-o FILE] [--brief] [--since ISO] [--until ISO] [--exclude-agent ID]...',
      "                                                                 find the Claude Code sessions that made these commits (session-story's",
      '                                                                 extractor) and write the evidence for a story\'s "How it got here" notes',
    ],
    run: backstory,
  },
];
