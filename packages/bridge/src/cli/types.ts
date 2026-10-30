/* The CLI's parsed command line and the shape of one command. Types only. */
import type { Config } from '../services/config/settings.ts';

/** The parsed command line: a value per flag (true for a bare flag), and the bare words in `_`. */
export interface CliOpts {
  _?: string[];
  [flag: string]: string | true | string[] | undefined;
}

/** One of the CLI's commands: its help lines and what it does. */
export interface Command {
  name: string;
  usage: string[];
  run(home: string, cfg: Config, opts: CliOpts): unknown;
}
