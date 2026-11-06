# <repo directory name>

Copy this file to `~/.once-upon/editor/<repo directory name>.md` (or `$ONCE_UPON_HOME/editor/`) and fill it in. The editor reads that file first, then `repos/<repo directory name>.md` in this folder. Delete the lines that don't apply.

- Checkout: `<absolute path of the live checkout>`, GitHub `<owner>/<name>`. Worktrees go in `<repo's parent>/<repo>-worktrees/<branch>`. Briefs say to read `<checkout>/AGENTS.md` first.
- Claim: `once-upon backlog claim <id> --agent <name> --branch <b> --sid <your sid8> --repo <owner>/<name>`
- Agent command (start, state, finish, list): `once-upon agent`
- Stories: does a branch get a story for the reader before it ships? (yes: add storytellers; no: critics only)
- Heavy for `heavy.sh`: the commands that take turns, for example the full test suite, a browser run, a whole-repo typecheck or lint, deploy gates. A single-file test is light.
- Deploy (a deploy agent, never the author): `<the command>`, and what it must never do (push, restart something live).
- Card order: where the cards come from (`once-upon backlog list`) and any parked line or dependencies.
- Reviews: the folder for critic reports, used when your user file names none (else `~/.once-upon/reviews`).
- Memory or notes to read: any extra files the editor should read at start.
