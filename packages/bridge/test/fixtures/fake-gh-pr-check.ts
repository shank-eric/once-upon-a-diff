#!/usr/bin/env node
// A stand-in for `gh api graphql` as auto-review.ts asks it: prints the canned answer in $FAKE_GH_PR_JSON.
// `gh api repos/...` (the rulesets lookup) prints $FAKE_GH_RULES_JSON, or fails when that isn't set.
import { readFileSync } from 'node:fs';

if (process.argv[3]?.startsWith('repos/')) {
  if (!process.env.FAKE_GH_RULES_JSON) {
    process.stderr.write('HTTP 404\n');
    process.exit(1);
  }
  process.stdout.write(readFileSync(process.env.FAKE_GH_RULES_JSON, 'utf8'));
} else {
  process.stdout.write(readFileSync(process.env.FAKE_GH_PR_JSON as string, 'utf8'));
}
