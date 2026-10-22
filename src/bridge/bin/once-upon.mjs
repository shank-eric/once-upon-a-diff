#!/usr/bin/env node
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. `once-upon` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../cli/index.mjs';

main(process.argv.slice(2));
