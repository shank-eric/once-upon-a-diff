/*
 * The once-upon CLI: one table of commands, each with its usage lines, so
 * the help text and the commands can't drift apart. bin/once-upon.ts runs
 * main().
 */
import { homeDir, loadConfig, readConfig } from '@once-upon-a-diff/foundation/settings';
import { parseArgs } from './args.ts';
import { resolveLongText } from './options.ts';
import { bridgeCommands } from './commands/bridge.ts';
import { storyCommands } from './commands/stories.ts';
import { inboxCommands } from './commands/inbox.ts';
import { draftCommands } from './commands/drafts.ts';
import { buildCommands } from './commands/builds.ts';
import { checkCommands } from './commands/checks.ts';
import { fixCommands } from './commands/fixes.ts';
import { pullRequestCommands } from './commands/pull-request.ts';
import { backlogCommands } from './commands/backlog.ts';
import { agentCommands } from './commands/agent.ts';
import { beatCommands } from './commands/beat.ts';
import { heavyCommands } from './commands/heavy.ts';
import { editorCommands } from './commands/editor.ts';
import { approveCommands } from './commands/approve.ts';
import { reviewedCommands } from './commands/reviewed.ts';
import { usageCommands } from './commands/usage.ts';
import { commandLabel, noteCommand } from '@once-upon-a-diff/usage/cli-log';
import type { Command } from './types.ts';

const COMMANDS = new Map<string, Command>(
  [
    ...bridgeCommands,
    ...storyCommands,
    ...inboxCommands,
    ...draftCommands,
    ...buildCommands,
    ...checkCommands,
    ...fixCommands,
    ...pullRequestCommands,
    ...backlogCommands,
    ...agentCommands,
    ...beatCommands,
    ...heavyCommands,
    ...editorCommands,
    ...reviewedCommands,
    ...approveCommands,
    ...usageCommands,
  ].map((command) => [command.name, command]),
);

/** The order the help lists them in. */
const HELP_ORDER = [
  'serve',
  'setup',
  'token',
  'list',
  'local',
  'bind',
  'page',
  'backlog',
  'agent',
  'beat',
  'heavy',
  'editor',
  'reviewed',
  'approve',
  'publish',
  'pr-draft',
  'inbox',
  'wait',
  'comment',
  'drafts',
  'doctor',
  'builds',
  'done',
  'ask',
  'asking',
  'answer',
  'notes',
  'working',
  'fixed',
  'usage',
];

/** Every command the table has, and the help's order, so a test can check they match. */
export const commandNames = () => ({ table: [...COMMANDS.keys()], help: [...HELP_ORDER] });

/** The help text: every command's usage, then where the settings live. */
export function usageText() {
  const lines = HELP_ORDER.flatMap((name) => (COMMANDS.get(name) as Command).usage);
  return [
    'once-upon: the Once Upon a Diff bridge and its helpers.',
    '',
    ...lines,
    '',
    'Long text (--note, --outcome, --task, --title, --text) goes in a file or on stdin, never in one long argument:',
    '--note-file PATH reads a file, --note - reads stdin (the same for the other four). Short values stay inline.',
    '',
    'ONCE_UPON_HOME moves ~/.once-upon. Personal settings (display name, time zone, checkout folders,',
    'opener, gh token handling) are optional keys in its config.json: see readSettings in foundation/src/settings.ts.',
    ' ',
  ].join('\n');
}

export function main(argv: string[]): void {
  const { command, opts } = parseArgs(argv);
  const entry = COMMANDS.get(command as string);
  // the usage log names a command only when the table has it (else `unknown`), and a verb only when the command lists it
  noteCommand(homeDir(), commandLabel(command, new Set(COMMANDS.keys()), entry?.subs, opts._?.[0]));
  if (!entry) {
    process.stderr.write(usageText() + '\n');
    process.exitCode = 1;
    return;
  }
  const home = homeDir();
  Promise.resolve()
    .then(() =>
      entry.run(
        home,
        entry.needsConfig ? loadConfig(home) : readConfig(home),
        resolveLongText(opts),
      ),
    )
    .catch((err: Error) => {
      process.stderr.write(`once-upon: ${err.message}\n`);
      process.exitCode = 1;
    });
}
