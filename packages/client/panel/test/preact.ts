/** Import first in a test whose code names the vendored Preact (/assets/preact.mjs, which the bridge serves): see the kit's registerPreact. */
import { fileURLToPath } from 'node:url';
import { registerPreact } from '@once-upon-a-diff/test-kit/preact';

registerPreact(fileURLToPath(import.meta.resolve('@once-upon-a-diff/ui-kit/vendor/preact.mjs')));
