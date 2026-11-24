/** `once-upon install-hooks`: the settings.json blocks that wire the listen hook, and the optional agent hooks (require-beats, auto-finish). It prints and never edits Claude Code's settings. */
import {
  agentHooksText,
  installHooksText,
} from '@once-upon-a-diff/core/features/sessions/hook-setup';
import { out } from '../output.ts';
import type { Command } from '../types.ts';

export const hookCommands: Command[] = [
  {
    name: 'install-hooks',
    usage: [
      '  once-upon install-hooks                                       print the settings.json "hooks" blocks for extras/hooks/listen-pending.sh (Start listening from any terminal), require-beats.sh and auto-finish-run.sh',
    ],
    run() {
      for (const line of [...installHooksText(), ...agentHooksText()]) {
        out(line);
      }
    },
  },
];
