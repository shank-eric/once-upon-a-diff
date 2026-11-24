/**
 * A re-told story's older storyteller is finished when the story is bound to the new one. A story is bound to the
 * agent that told it (`publish --agent`, `local --agent`), so the binding it had before names the storyteller that
 * told it last: when that run is still parked (a story review or a question) it has been replaced, and an open run
 * left behind would block its card (phase row 1b). A storyteller of another story, one still running and one that
 * is not the previous binding's are left alone. The binding records the session that owns its agent, so a run of the
 * same name in another session (a name reused on another story) is left alone too.
 */
import { runRegistry } from './registry.ts';

/**
 * Finishes the previous binding's parked storyteller runs as done, "superseded by <newAgent>". `previous` is the
 * agent the story was bound to before this telling (null: none) and the session that owned it (null: not recorded,
 * so the name alone decides), `newAgent` the one it is bound to now.
 */
export function supersedeStoryteller(
  home: string,
  previous: { agent: string; session: string | null } | null,
  newAgent: string,
  warn: (line: string) => void,
): void {
  if (!previous || previous.agent === newAgent) {
    return;
  }
  const registry = runRegistry(home);
  // a run's sid is the front of the full session id the binding records
  const isOfSession = (sid: string, session: string | null): boolean =>
    !session || session.startsWith(sid);
  const isParkedPrevious = (old: ReturnType<typeof registry.agents>[number]): boolean =>
    old.name === previous.agent &&
    isOfSession(old.sid, previous.session) &&
    old.state === 'waiting' &&
    (old.role === 'storyteller' || old.kind === 'storyteller');
  for (const old of registry.agents().filter(isParkedPrevious)) {
    try {
      registry.finish(
        old.name,
        {
          sid: old.sid,
          run: old.run,
          state: 'done',
          outcome: `superseded by ${newAgent}`,
          by: newAgent.slice(0, 40),
        },
        warn,
      );
    } catch (error) {
      // another writer ended it first (no open run left): it is over either way; anything else is heard
      const why = error instanceof Error ? error.message : String(error);
      if (!why.startsWith('no open run of')) {
        warn(`once-upon: could not supersede ${old.name}: ${why}`);
      }
    }
  }
}
