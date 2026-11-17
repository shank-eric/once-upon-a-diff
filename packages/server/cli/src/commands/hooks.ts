/** `once-upon install-hooks`: the settings.json block that wires the listen hook. It prints and never edits Claude Code's settings. */
import { installHooksText } from '@once-upon-a-diff/core/features/sessions/hook-setup';
import { out } from '../output.ts';
import type { Command } from '../types.ts';

export const hookCommands: Command[] = [
  {
    name: 'install-hooks',
    usage: [
      '  once-upon install-hooks                                       print the settings.json "hooks" block for extras/hooks/listen-pending.sh (Start listening from any terminal)',
    ],
    run() {
      for (const line of installHooksText()) {
        out(line);
      }
    },
  },
];
