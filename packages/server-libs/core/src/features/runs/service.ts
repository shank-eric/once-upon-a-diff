/*
 * Runs, in one place. Starting a run on a card, moving a card's branch and finishing a run each carry the ADR-25 rules (the
 * card exists and is open, the role table, one author per card, a carded critic's findings count). The CLI, the HTTP app and
 * the board import this file and nothing else of runs (configs/.dependency-cruiser.mjs, `runs-through-service`), so no caller
 * builds a registry without the card lookup and skips them.
 *
 * What sits behind it:
 *   roles.ts        the role table: which kind a role runs as, and what a session's own (`--self`) run takes.
 *   live-sids.ts    the live sessions the sweep may trust, to end a gone session's self run.
 *   live-writes.ts  the transcript writes of open author and critic runs, for the sweep's 30-minute rule.
 *   registry.ts     the registry built with the card lookup, and which logs it mirrors to.
 *   start-run.ts    a start: refusals, the PR's head branch, the card's stamp, the run, then the card.
 *   move-branch.ts  a card's branch change: the card first, then its open runs.
 *   finish-run.ts   an end, with the findings check.
 *   record-fix.ts   a fix made outside any run, recorded as a done fixer run on the branch's card (`once-upon fixed --sha`, the board's Record as fix).
 *   round.ts        a card's later review round (new commits on a pushed branch): its base, derived from origin/<branch>, and the line that says so.
 *   dispatch.ts     launching an agent for a card: start and the brief (`once-upon dispatch`); briefs.ts the brief's text, checkout.ts the paths.
 *   handback.ts     an agent's hand-back (`once-upon handback`): the run's commit, branch and card recorded, or its state moved.
 *   backfill.ts     `once-upon card backfill`: stores the `ic_` cards of runs made before ADR-29, and with `cardless` a card for each recent cardless run.
 *   supersede.ts    a re-told story's previous storyteller, finished when the story is bound to the new one.
 *   auto-finish.ts  an end for a subagent that stopped with its run open (the SubagentStop hook).
 */
export { startRun } from './start-run.ts';
export type { RunStartInput, RunIo, StartedRun } from './start-run.ts';
export { roundNote } from './round.ts';
export type { RoundBase } from './round.ts';
export { recordFix } from './record-fix.ts';
export type { RecordFixInput, RecordedFix } from './record-fix.ts';
export { moveBranch } from './move-branch.ts';
export type { BranchMove } from './move-branch.ts';
export { finishRun } from './finish-run.ts';
export { runRegistry } from './registry.ts';
export { trustedLiveSids } from './live-sids.ts';
export { liveWrites } from './live-writes.ts';
export type { Mirror } from './registry.ts';
export { ROLE_KIND, openSelfRun } from './roles.ts';
export { dispatchRun, callLine, DISPATCH_ROLES } from './dispatch.ts';
export type { DispatchInput, DispatchRole, Dispatched } from './dispatch.ts';
export { backfillCards, backfillLine, BACKFILL_DAYS } from './backfill.ts';
export type { BackfillCounts } from './backfill.ts';
export { handbackRun } from './handback.ts';
export type { HandbackInput, HandedBack } from './handback.ts';
export { autoFinishRun } from './auto-finish.ts';
export { supersedeStoryteller } from './supersede.ts';
