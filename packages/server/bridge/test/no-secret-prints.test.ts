/**
 * No instruction, skill, agent, doc or script in the repo prints the bridge token, the whole of config.json or a real-looking
 * page key: sessions are copied to a backup, and what they print stays valid until the token is rotated. A line that says
 * "never ..." is the rule itself and is left alone. `#key=…` and `#key=<page key>` (a placeholder) are fine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const SCAN = ['skills', 'agents', 'docs', 'extras', 'scripts', 'README.md', 'AGENTS.md'];
const TEXT = /\.(md|sh|py|json|ya?ml|txt|mjs|ts)$/;

function* files(entry: string): Generator<string> {
  const full = path.join(ROOT, entry);
  let stat;
  try {
    stat = statSync(full);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    yield entry;
    return;
  }
  for (const name of readdirSync(full)) {
    if (name !== 'node_modules' && !name.startsWith('.')) {
      yield* files(path.join(entry, name));
    }
  }
}

// a command that shows a file's whole text
const SHOW = String.raw`\b(?:cat|less|more|head|tail|bat|pbcopy|xxd)\b`;
const WHOLE_CONFIG = [
  new RegExp(`${SHOW}[^|;\\n]*config\\.json`),
  /\bjq\s+(?:-[a-zA-Z]+\s+)*['"]?\.?['"]?\s+[^|;\n]*config\.json/,
  /\bpython3?\b[^\n]*json\.load[^\n]*config\.json/,
  /\bnode\s+-p\b[^\n]*config\.json/,
];
const TOKEN_FILE = [
  new RegExp(`${SHOW}[^|;\\n]*once-upon/token\\b`),
  /\becho\b[^\n]*once-upon\/token\b/,
  /\$\([^)\n]*once-upon\/token\b/,
];
const REAL_KEY = /#key=page\.[A-Za-z0-9_-]{20,}/;

function findings(lines: string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, i) => {
    if (/never/i.test(line)) {
      return;
    }
    if (WHOLE_CONFIG.some((pattern) => pattern.test(line))) {
      found.push(`${i + 1}: prints the whole config.json: ${line.trim().slice(0, 80)}`);
    }
    if (TOKEN_FILE.some((pattern) => pattern.test(line))) {
      found.push(`${i + 1}: prints the token file: ${line.trim().slice(0, 80)}`);
    }
    if (REAL_KEY.test(line)) {
      found.push(`${i + 1}: a real-looking page key`);
    }
  });
  return found;
}

test('the check itself finds what it should and leaves named-key reads alone', () => {
  const bad = [
    'cat ~/.once-upon/config.json',
    'jq . ~/.once-upon/config.json',
    "jq '.' ~/.once-upon/config.json",
    'python3 -c "import json;print(json.load(open(\'config.json\')))" config.json',
    'cat ~/.once-upon/token',
    'echo "$(cat ~/.once-upon/token)"',
    'open http://127.0.0.1:4823/local/x/#key=page.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  ];
  for (const line of bad) {
    assert.equal(findings([line]).length > 0, true, line);
  }
  const fine = [
    "jq -r '.house_rules' ~/.once-upon/config.json",
    'jq -r .repo_dir ~/.once-upon/config.json',
    'Never `cat ~/.once-upon/config.json`',
    'https://once-upon.test/board/#key=…',
    'http://127.0.0.1:<port>/local/<id>/#key=<page key>',
    'tok="$(tr -d "[:space:]" <"$home/token")"',
  ];
  for (const line of fine) {
    assert.deepEqual(findings([line]), [], line);
  }
});

test('nothing in the skills, agents, docs, extras or scripts prints the token, a whole config.json or a page key', () => {
  const problems: string[] = [];
  for (const entry of SCAN) {
    for (const file of files(entry)) {
      if (TEXT.test(file)) {
        const lines = readFileSync(path.join(ROOT, file), 'utf8').split('\n');
        problems.push(...findings(lines).map((one) => `${file}:${one}`));
      }
    }
  }
  assert.deepEqual(problems, []);
});
