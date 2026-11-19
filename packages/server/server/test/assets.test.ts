import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { moduleFileFor } from '../src/assets.ts';

test('moduleFileFor: each module route names a file under its own package folder, and any other path names none', () => {
  const where = (route: string) => moduleFileFor(route);
  assert.ok(where('/assets/panel/shell/overlay.ts')?.endsWith(path.join('shell', 'overlay.ts')));
  assert.ok(
    where('/assets/board/agents/card.css')?.endsWith(path.join('board', 'agents', 'card.css')),
  );
  assert.ok(where('/assets/bridge-client/poll.ts')?.endsWith(path.join('poll.ts')));
  assert.ok(where('/assets/contracts/routes.ts')?.endsWith('routes.ts'));
  assert.ok(where('/assets/terms/time.ts')?.endsWith('time.ts'));
  assert.ok(where('/assets/local/page.css')?.endsWith(path.join('local', 'page.css')));
  assert.equal(where('/assets/bridge-client/other.ts'), null);
  assert.equal(where('/assets/panel/../secret.ts'), null);
  assert.equal(where('/story/1'), null);
});
