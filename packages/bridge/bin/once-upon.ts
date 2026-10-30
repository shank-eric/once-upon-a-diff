/**
 * once-upon: the Once Upon a Diff bridge and its helpers. `once-upon` with
 * no command prints every command's usage. The commands are in ../cli/.
 */
import { main } from '../src/cli/index.ts';
import { createBridge } from '../src/server/index.ts';
import { setBridgeFactory } from '../src/services/bridge/bridge.ts';

// what the CLI and the bridge write (~/.once-upon, a checkout's .once-upon) is the user's alone: 0600 files, 0700 folders
process.umask(0o077);
// the CLI starts the HTTP app (`serve`, and `local` when no bridge is up) without importing it: this is the one place that knows both
setBridgeFactory(createBridge);
main(process.argv.slice(2));
