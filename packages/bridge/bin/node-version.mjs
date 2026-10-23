/**
 * The Node version check every entry runs before it loads TypeScript. It's
 * plain JavaScript so an older Node can run it: Node 20 can't load a .ts file
 * at all and dies with ERR_UNKNOWN_FILE_EXTENSION, which says nothing about
 * the version. Run on its own (`node node-version.mjs`), as the package
 * scripts do, it exits 1 with the same message when Node is too old.
 *
 * The minimum is 24: what .nvmrc, `engines` and @types/node say, and the only
 * version the tests run on. Node 22.18 and 23.6 strip types too, but print an
 * ExperimentalWarning on every run, and nothing checks the code stays within
 * their APIs.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_NODE_MAJOR = 24;

/**
 * Why this Node can't run Once Upon a Diff, in one line, or null when it can.
 * @param {string} [version] a `process.versions.node`, like "20.19.0"
 * @param {string} [execPath] the node binary, named in the message so it's clear which one ran
 * @returns {string | null}
 */
export function nodeVersionProblem(version = process.versions.node, execPath = process.execPath) {
  const major = Number.parseInt(String(version).replace(/^v/, ''));
  if (major >= MIN_NODE_MAJOR) {
    return null;
  }
  return (
    `Once Upon a Diff needs Node ${MIN_NODE_MAJOR} or newer (found v${String(version).replace(/^v/, '')} at ${execPath}). ` +
    `Run \`fnm use\` or \`nvm use\` in the once-upon-a-diff repo (its .nvmrc says ${MIN_NODE_MAJOR}), ` +
    `or put \`fnm exec --using=${MIN_NODE_MAJOR}\` in front of the command.`
  );
}

/** Prints the problem and exits 1 when this Node is too old. */
export function requireNode() {
  const problem = nodeVersionProblem();
  if (problem) {
    process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
}

const self = fileURLToPath(import.meta.url);
let main = '';
try {
  main = process.argv[1] ? realpathSync(process.argv[1]) : '';
} catch {
  // not a file (node -e, a REPL): not run on its own
}
if (main === self) {
  requireNode();
}
