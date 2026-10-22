#!/usr/bin/env node
/**
 * pr-story: the PR Story bridge and its helpers. `pr-story` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../cli/index.mjs';

main(process.argv.slice(2));
