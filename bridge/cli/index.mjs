/*
 * The pr-story CLI: one table of commands, each with its usage lines, so
 * the help text and the commands can't drift apart. bin/pr-story.mjs runs
 * main().
 */
import { homeDir, loadConfig, moveLegacyHome } from '../config/settings.mjs';
import { parseArgs } from './args.mjs';
import { moveLegacyStoryFolders } from '../stories/placement.mjs';
import { bridgeCommands } from './commands/bridge.mjs';
import { storyCommands } from './commands/stories.mjs';
import { inboxCommands } from './commands/inbox.mjs';
import { draftCommands } from './commands/drafts.mjs';
import { buildCommands } from './commands/builds.mjs';
import { checkCommands } from './commands/checks.mjs';

const COMMANDS = new Map(
  [
    ...bridgeCommands,
    ...storyCommands,
    ...inboxCommands,
    ...draftCommands,
    ...buildCommands,
    ...checkCommands,
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
];

/** Every command the table has, and the help's order, so a test can check they match. */
export const commandNames = () => ({ table: [...COMMANDS.keys()], help: [...HELP_ORDER] });

/** The help text: every command's usage, then where the settings live. */
export function usageText() {
  const lines = HELP_ORDER.flatMap((name) => COMMANDS.get(name).usage);
  return [
    'pr-story: the PR Story bridge and its helpers.',
    '',
    ...lines,
    '',
    'PR_STORY_HOME moves ~/.pr-story. Personal settings (display name, time zone, checkout folders,',
    'opener, gh token handling) are optional keys in its config.json: see readSettings in config/settings.mjs.',
    ' ',
  ].join('\n');
}

export function main(argv) {
  const { command, opts } = parseArgs(argv);
  const entry = COMMANDS.get(command);
  if (!entry) {
    process.stderr.write(usageText() + '\n');
    process.exitCode = 1;
    return;
  }
  const moved = moveLegacyHome();
  if (moved) {
    process.stderr.write(`pr-story: ${moved}\n`);
  }
  const home = homeDir();
  for (const line of moveLegacyStoryFolders(home)) {
    process.stderr.write(`pr-story: ${line}\n`);
  }
  Promise.resolve()
    .then(() => entry.run(home, loadConfig(home), opts))
    .catch((err) => {
      process.stderr.write(`pr-story: ${err.message}\n`);
      process.exitCode = 1;
    });
}
