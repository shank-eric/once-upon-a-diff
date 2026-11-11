/**
 * The git version the adapters need: every outside ref reaches git after `--end-of-options` (adapters/src/git.ts), and
 * `git rev-parse` only learned that in 2.30. doctor reports it; nothing runs git on every call to check.
 */
export const MIN_GIT = { major: 2, minor: 30 };

/**
 * Why this git is too old, in one line, or null when it is fine (or its version can't be read, which is not a reason to fail).
 * @param text `git --version` output ("git version 2.49.0", "git version 2.39.5 (Apple Git-154)") or the bare version
 */
export function gitVersionProblem(text: string | null | undefined): string | null {
  const found = /(\d+)\.(\d+)/.exec(String(text ?? ''));
  if (!found) {
    return null;
  }
  const [major, minor] = [Number(found[1]), Number(found[2])];
  if (major > MIN_GIT.major || (major === MIN_GIT.major && minor >= MIN_GIT.minor)) {
    return null;
  }
  return `needs git ${MIN_GIT.major}.${MIN_GIT.minor} or newer (found ${major}.${minor}): rev-parse takes --end-of-options from 2.30`;
}
