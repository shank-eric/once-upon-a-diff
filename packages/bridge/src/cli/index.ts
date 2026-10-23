/*
 * The once-upon CLI: one table of commands, each with its usage lines, so
 * the help text and the commands can't drift apart. bin/once-upon.ts runs
 * main().
 */
import { homeDir, loadConfig } from '../config/settings.ts';
import { parseArgs } from './args.ts';
import { bridgeCommands } from './commands/bridge.ts';
import { storyCommands } from './commands/stories.ts';
import { inboxCommands } from './commands/inbox.ts';
import { draftCommands } from './commands/drafts.ts';
import { buildCommands } from './commands/builds.ts';
import { checkCommands } from './commands/checks.ts';
import { fixCommands } from './commands/fixes.ts';
import type { Command } from '../types.ts';

const COMMANDS = new Map<string, Command>(
  [
    ...bridgeCommands,
    ...storyCommands,
    ...inboxCommands,
    ...draftCommands,
    ...buildCommands,
    ...checkCommands,
    ...fixCommands,
  ].map((command) => [command.name, command]),
);

/** The order the help lists them in. */
const HELP_ORDER = [
  'serve',
  'setup',
  'token',
  'list',
  'local',
  'publish',
  'inbox',
  'wait',
  'comment',
  'drafts',
  'doctor',
  'builds',
  'done',
  'answer',
  'notes',
  'working',
  'fixed',
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
    'ONCE_UPON_HOME moves ~/.once-upon. Personal settings (display name, time zone, checkout folders,',
    'opener, gh token handling) are optional keys in its config.json: see readSettings in config/settings.ts.',
    ' ',
  ].join('\n');
}

export function main(argv: string[]): void {
  const { command, opts } = parseArgs(argv);
  const entry = COMMANDS.get(command as string);
  if (!entry) {
    process.stderr.write(usageText() + '\n');
    process.exitCode = 1;
    return;
  }
  const home = homeDir();
  Promise.resolve()
    .then(() => entry.run(home, loadConfig(home), opts))
    .catch((err: Error) => {
      process.stderr.write(`once-upon: ${err.message}\n`);
      process.exitCode = 1;
    });
}
