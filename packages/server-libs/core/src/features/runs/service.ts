/*
 * Runs, in one place. Starting a run on a card, moving a card's branch and finishing a run each carry the ADR-25 rules (the
 * card exists and is open, the role table, one author per card, a carded critic's findings count). The CLI, the HTTP app and
 * the board import this file and nothing else of runs (configs/.dependency-cruiser.mjs, `runs-through-service`), so no caller
 * builds a registry without the card lookup and skips them.
 *
 * What sits behind it:
 *   roles.ts        the role table: which kind a role runs as, and what a session's own (`--self`) run takes.
 *   live-sids.ts    the live sessions the sweep may trust, to end a gone session's self run.
 *   registry.ts     the registry built with the card lookup, and which logs it mirrors to.
 *   start-run.ts    a start: refusals, the PR's head branch, the card's stamp, the run, then the card.
 *   move-branch.ts  a card's branch change: the card first, then its open runs.
 *   finish-run.ts   an end, with the findings check.
 */
export { startRun } from './start-run.ts';
export type { RunStartInput, RunIo, StartedRun } from './start-run.ts';
export { moveBranch } from './move-branch.ts';
export type { BranchMove } from './move-branch.ts';
export { finishRun } from './finish-run.ts';
export { runRegistry } from './registry.ts';
export { trustedLiveSids } from './live-sids.ts';
export type { Mirror } from './registry.ts';
export { ROLE_KIND, openSelfRun } from './roles.ts';
