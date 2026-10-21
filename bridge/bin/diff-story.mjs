#!/usr/bin/env node
/**
 * diff-story: the Diff Story Mode bridge and its helpers. `diff-story` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../cli/index.mjs';

main(process.argv.slice(2));
