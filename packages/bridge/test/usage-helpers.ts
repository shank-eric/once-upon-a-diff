/* Shared by the usage capture's tests: what a stored file may contain, checked key by key. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ACTIONS } from '@once-upon-a-diff/domain/usage-actions';
import { ROUTES } from '@once-upon-a-diff/contracts/routes';
import { commandNames } from '../src/cli/index.ts';
import { COMMAND_AREAS } from '../src/services/usage/areas.ts';

const SURFACES = new Set(['board', 'local', 'local-view', 'extension', 'token']);
const ROUTE_KEYS = new Set([...Object.keys(ROUTES), 'unmatched']);
const COMMANDS = new Set([...commandNames().table, 'unknown']);
const ACTION_NAMES = new Set(Object.keys(ACTIONS));

/** Every file under <home>/usage, parsed: only names from the closed lists, repo-relative source paths, counts and times. */
export function assertPrivate(home: string, sentinels: string[] = []): string[] {
  const dir = path.join(home, 'usage');
  const seen: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) {
      continue;
    }
    seen.push(name);
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const sentinel of [...sentinels, '/Users/', home]) {
      assert.ok(!text.includes(sentinel), `${name} must not contain ${sentinel}`);
    }
    if (name === 'cli-runs.log') {
      for (const line of text.split('\n').filter(Boolean)) {
        const match = /^\d{4}-\d{2}-\d{2} ([a-z-]+)(?:\.([a-z]+))?$/.exec(line);
        assert.ok(match, `cli-runs.log line is not day and command: ${line}`);
        assert.ok(COMMANDS.has(match[1]), `unknown command name ${match[1]}`);
      }
    } else if (name === 'actions.json') {
      const file = JSON.parse(text) as {
        days: Record<
          string,
          {
            routes: Record<string, Record<string, number>>;
            ui: Record<string, Record<string, number>>;
            unknownDropped?: number;
          }
        >;
      };
      for (const day of Object.values(file.days)) {
        for (const [surface, table] of Object.entries(day.routes)) {
          assert.ok(SURFACES.has(surface), `surface ${surface}`);
          for (const [key, total] of Object.entries(table)) {
            assert.ok(ROUTE_KEYS.has(key), `route key ${key}`);
            assert.ok(Number.isInteger(total) && total > 0);
          }
        }
        for (const [surface, table] of Object.entries(day.ui)) {
          assert.ok(SURFACES.has(surface), `surface ${surface}`);
          for (const [key, total] of Object.entries(table)) {
            assert.ok(ACTION_NAMES.has(key), `action name ${key}`);
            assert.ok(Number.isInteger(total) && total > 0);
          }
        }
      }
    } else if (name.startsWith('coverage-')) {
      const file = JSON.parse(text) as { files: Record<string, { sha: string }[]> };
      for (const [rel, entries] of Object.entries(file.files)) {
        assert.match(rel, /^(packages|skills)\/[A-Za-z0-9_./-]+$/, `coverage path ${rel}`);
        for (const entry of entries) {
          assert.match(entry.sha, /^[0-9a-f]{8}$/);
        }
      }
    }
  }
  return seen;
}

/** The commands the area table names (the CLI's own table is the other side of the check). */
export const AREA_COMMANDS = Object.keys(COMMAND_AREAS);
