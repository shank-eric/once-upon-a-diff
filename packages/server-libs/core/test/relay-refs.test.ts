import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '@once-upon-a-diff/test-kit/env';
import { tmp } from '@once-upon-a-diff/test-kit/files';
import { rebuildRelayMessage } from '../src/features/listeners/relay.ts';

// the rebuild message is a command line an author runs in its shell: a story's base, head or repo_path must not run anything there
test('a rebuild message built from a base or head with shell syntax runs nothing', () => {
  const made = path.join(tmp('relay'), 'made');
  const payload = `$(touch ${made})`;
  const message = rebuildRelayMessage(
    {
      type: 'build_request',
      id: 'b1',
      story: 'local-x-y',
      kind: 'local',
      local: { repo_path: `/tmp/${payload}`, base: payload, head: `\`touch ${made}\`` },
    },
    'agent-a',
    'echo',
  );
  const command = /`(echo local .*? --no-open)`/.exec(message)?.[1];
  assert.ok(command, message);
  assert.ok(!message.includes('touch'), 'the payload is not printed');
  spawnSync('sh', ['-c', command], { encoding: 'utf8' }); // the placeholders are for the author, so the shell may complain
  assert.equal(existsSync(made), false);
  // an ordinary ref is printed as it is
  const fine = rebuildRelayMessage(
    {
      type: 'build_request',
      id: 'b1',
      story: 'local-x-y',
      kind: 'local',
      local: { repo_path: '/work/repo', base: 'main', head: 'feature/x' },
    },
    'agent-a',
    'echo',
  );
  assert.match(fine, /--repo "\/work\/repo" --base "main" --head "feature\/x"/);
});
