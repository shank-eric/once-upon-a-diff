/* The CLI's parsed command line and the shape of one command. Types only. */
import type { Config } from '@once-upon-a-diff/core/foundation/settings';

/** The parsed command line: a value per flag (true for a bare flag), and the bare words in `_`. */
export interface CliOpts {
  _?: string[];
  [flag: string]: string | true | string[] | undefined;
}

/** One of the CLI's commands: its help lines and what it does. */
export interface Command {
  name: string;
  usage: string[];
  /** the verbs this command takes as its first word (`agent start`), the only first words the usage log may name */
  subs?: readonly string[];
  run(home: string, cfg: Config, opts: CliOpts): unknown;
}
