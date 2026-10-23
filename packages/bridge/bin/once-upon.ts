#!/usr/bin/env node
// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- typed in the next commit
// @ts-nocheck
/**
 * once-upon: the Once Upon a Diff bridge and its helpers. `once-upon` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../src/cli/index.ts';

main(process.argv.slice(2));
