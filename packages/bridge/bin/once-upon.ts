/**
 * once-upon: the Once Upon a Diff bridge and its helpers. `once-upon` with
 * no command prints every command's usage. The commands are in the cli package.
 */
import { main } from '@once-upon-a-diff/cli/index';
import { createBridge } from '@once-upon-a-diff/server/index';
import { setBridgeFactory } from '@once-upon-a-diff/core/orchestration/bridge/bridge';

// what the CLI and the bridge write (~/.once-upon, a checkout's .once-upon) is the user's alone: 0600 files, 0700 folders
process.umask(0o077);
// the CLI starts the HTTP app (`serve`, and `local` when no bridge is up) without importing it: this is the one place that knows both
setBridgeFactory(createBridge);
main(process.argv.slice(2));
