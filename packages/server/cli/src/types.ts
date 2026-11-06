/* The CLI's parsed command line and the shape of one command. Types only. */
import type { Config } from '@once-upon-a-diff/foundation/settings';

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
  /** the command hands out or uses the bridge's token, so it makes config.json (and the home) when there is none; the rest only read it (readConfig) */
  needsConfig?: true;
  run(home: string, cfg: Config, opts: CliOpts): unknown;
}
