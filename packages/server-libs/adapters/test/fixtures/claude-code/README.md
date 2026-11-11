# Claude Code file shapes

Fixtures for the files Claude Code writes that the board reads without being told they changed
(`packages/server-libs/adapters/src/claude-sessions/`). Every key is the one a real file has; every value is made up. No
real session id, path, name, prompt or token is in here.

- `sessions/<pid>.json`: the session registry (`~/.claude/sessions`), recorded from files written by Claude Code 2.1.319 to
  2.1.322 (`claude --version` said 2.1.322 on 11/11/2026). Three states: busy, idle and shell.
- `cleared-transcript.jsonl`: the transcript lines of a session just after `/clear`, as `blank-sessions.ts` expects them (it
  is built from that reader's own description, not copied from a real transcript).

When Claude Code changes these files, a test here fails: re-record the keys from a real file with made-up values, and
change the version above.
