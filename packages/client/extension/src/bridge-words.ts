/*
 * What to tell the user when the service worker's call to the bridge was refused before the token went out (bridge-call.ts).
 * One home, so the toast, the panel's listen notice and the options page say the same thing.
 */

/**
 * The listener's proof failed: a stale or mistyped token and a program squatting on the port look the same from here, so the
 * words cover both.
 */
export const NOT_THE_BRIDGE =
  "the listener on this port doesn't know this token: copy it again from once-upon setup, or something else holds the port";

/** The bridge has no handshake route: it is older than the extension. */
export const BRIDGE_TOO_OLD =
  'the bridge is older than this extension, so restart it (once-upon serve)';

const sentence = (clause: string) => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

/**
 * Why there's no story to show, for the toolbar button's toast. `status` is the bridge answer's error (or `ready`, `none`...)
 * and `problem` the code `bridgeProblem` read from its failure. '' when the answer says nothing more than "no story".
 */
export function noStoryWhy(status: string, problem?: string): string {
  if (status === 'not-configured') {
    return 'Set the bridge port and token in the extension options first.';
  }
  if (status === 'unreachable') {
    return "The bridge isn't running. Start it with: once-upon serve";
  }
  if (status === 'not-the-bridge') {
    return sentence(NOT_THE_BRIDGE);
  }
  if (status === 'bridge-too-old') {
    return sentence(BRIDGE_TOO_OLD);
  }
  if (problem === 'token') {
    return 'The bridge rejected the token. Copy it again from: once-upon setup';
  }
  return 'The bridge has no story for this PR.';
}
