#!/usr/bin/env node
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. `once-upon` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../src/cli/index.ts';

// what the CLI and the bridge write (~/.once-upon, a checkout's .once-upon) is the user's alone: 0600 files, 0700 folders
process.umask(0o077);
main(process.argv.slice(2));
