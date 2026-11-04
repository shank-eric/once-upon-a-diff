#!/usr/bin/env node
// A stand-in for `gh api graphql` as github-checks.ts asks it: prints the canned answer in $FAKE_GH_PR_JSON.
// `gh api repos/...` (the rulesets lookup) prints $FAKE_GH_RULES_JSON, or fails when that isn't set.
import { appendFileSync, readFileSync } from 'node:fs';

// $FAKE_GH_LOG, when set, gets each call's arguments as a JSON line
if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(process.argv.slice(2))}\n`);
}

if (process.argv[3]?.startsWith('repos/')) {
  if (!process.env.FAKE_GH_RULES_JSON) {
    process.stderr.write('HTTP 404\n');
    process.exit(1);
  }
  process.stdout.write(readFileSync(process.env.FAKE_GH_RULES_JSON, 'utf8'));
} else {
  process.stdout.write(readFileSync(process.env.FAKE_GH_PR_JSON as string, 'utf8'));
}
