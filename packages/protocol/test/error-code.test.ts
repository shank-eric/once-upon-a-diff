import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_CODES, codeOfStatus, hasCode, replyCode } from '../src/domain/error-code.ts';

test('every status the bridge answers with maps to a code, and every code but no_route is some status’s', () => {
  const table: [number, string][] = [
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'method_not_allowed'],
    [409, 'conflict'],
    [413, 'bad_request'],
    [415, 'bad_request'],
    [421, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'internal'],
    [502, 'bad_gateway'],
    [503, 'internal'],
  ];
  for (const [status, code] of table) {
    assert.equal(codeOfStatus(status), code, String(status));
  }
  const reached = new Set(table.map(([, code]) => code));
  assert.deepEqual(
    ERROR_CODES.filter((code) => !reached.has(code)),
    ['no_route'],
    'no_route is the one the bridge names itself: a 404 for a path it has no route for',
  );
});

test('a reply’s code is the bridge’s own when it is one we know, else the status’s', () => {
  assert.equal(replyCode({ status: 404, body: { error: 'x', code: 'no_route' } }), 'no_route');
  assert.equal(replyCode({ status: 404, body: { error: 'x' } }), 'not_found', 'an older bridge');
  assert.equal(replyCode({ status: 401, body: { error: 'zzz' } }), 'unauthorized');
  assert.equal(replyCode({ status: 409, body: { error: 'x', code: 'made-up' } }), 'conflict');
  assert.equal(replyCode({ status: 409, body: null }), 'conflict');
  assert.equal(replyCode({ status: 403 }), 'forbidden');
  assert.ok(hasCode({ body: { code: 'forbidden' } }));
  assert.ok(!hasCode({ body: { code: 'made-up' } }));
  assert.ok(!hasCode({ body: undefined }));
});
