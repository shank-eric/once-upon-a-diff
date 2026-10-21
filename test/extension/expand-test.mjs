#!/usr/bin/env node
/**
 * Loads the unpacked extension into a throwaway Chromium (as load-test.mjs
 * does) and checks that a file or line link in the panel opens what it points
 * at on a public PR's /files and /changes pages, logged out:
 *
 *   - a line above the first hunk, in a short gap, in a long gap and past the
 *     last hunk, on the new side and the old side, is expanded into the page,
 *     scrolled to and highlighted
 *   - a file link, and a line link, into a collapsed file expands it first
 *   - nothing expands on a step change, ?w=1 stays, and no Viewed toggle changes
 *
 *   node test/extension/expand-test.mjs [--headed] [--shots DIR]
 */
/* global document */ // used inside page.evaluate
import { chromium } from 'playwright-core';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, writeJson, TOKEN, startBridge } from '../helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'src');
const args = process.argv.slice(2);
/** --name's value, true for a bare --name, or the fallback when it isn't given. */
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    return fallback;
  }
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const SHOTS = arg('shots', null);
if (SHOTS) {
  mkdirSync(SHOTS, { recursive: true });
}

let failures = 0;
const check = (ok, what) => {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
  if (!ok) {
    failures++;
  }
};

// refined-github#10298: repo-age.tsx has hunks at new lines 64-89, 96-104, 113-140 and 162-167,
// so 1-63 is a gap above, 90-95 a short gap, 141-161 a long one; the .gql file is drawn to line 6 of 18
const [owner, repo, number] = ['refined-github', 'refined-github', 10298];
const TSX = 'source/features/repo-age.tsx';
const GQL = 'source/features/repo-age-first-commit.gql';
const home = tmp('expand-home');
const id = `${owner}-${repo}-${number}`;
writeJson(path.join(home, id, 'meta.json'), {
  kind: 'github',
  repo: `${owner}/${repo}`,
  number,
  head_oid: 'a'.repeat(40),
});
writeJson(path.join(home, id, 'chapters.json'), {
  title: 'Expand test',
  overview: '### Overview\n\nA test story.',
  chapters: [
    {
      title: 'Chapter 1: Links',
      files: [TSX, GQL],
      narrative: `### Chapter 1: Links\n\nAbove: \`${TSX}:10\`. Short gap: \`${TSX}:92\`. Long gap: \`${TSX}:150-151\`. Old side: \`${TSX}:L20\`. Past the end: \`${GQL}:15\`. The file: \`${GQL}\`.`,
    },
  ],
});
process.env.DIFF_STORY_GH = path.join(ROOT, 'test', 'fixtures', 'fake-gh.mjs');
const bridge = await startBridge({ home });
const port = bridge.server.address().port;

const context = await chromium.launchPersistentContext(tmp('expand-profile'), {
  channel: 'chromium',
  headless: !arg('headed', false),
  viewport: { width: 1500, height: 1000 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  const extId = new URL(worker.url()).host;
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/html/options.html`);
  await opt.fill('#port', String(port));
  await opt.fill('#token', TOKEN);
  await opt.click('button[type=submit]');
  await opt.waitForSelector('#status.ok >> text=Connected', { timeout: 5000 }).catch(() => {});
  await opt.close();

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const view of ['files', 'changes']) {
    await page.goto(`https://github.com/${owner}/${repo}/pull/${number}/${view}?w=1`, {
      waitUntil: 'domcontentloaded',
    });
    const host = await page
      .waitForSelector('#diff-story-panel', { timeout: 15000, state: 'attached' })
      .catch(() => null);
    const landed = new URL(page.url()).pathname; // logged out, /changes goes to /files
    check(!!host, `/${view}: panel docks (landed on ${landed})`);
    if (!host) {
      continue;
    }
    await page.waitForTimeout(2500);
    const rowsOf = (rel) =>
      page.evaluate(async (rel) => {
        const sha = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rel))),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        return document.querySelectorAll(`[data-line-anchor^="diff-${sha}"], td[id^="diff-${sha}"]`)
          .length;
      }, rel);
    const viewedNow = () =>
      page.evaluate(
        () =>
          [
            ...document.querySelectorAll(
              'button[aria-pressed="true"], input.js-reviewed-checkbox:checked',
            ),
          ].filter((button) =>
            /viewed/i.test(
              button.textContent + (button.getAttribute('aria-label') || '') + button.className,
            ),
          ).length,
      );
    const viewed0 = await viewedNow();
    const before = await rowsOf(TSX);
    await page.locator('#dsm-panel .prs-next').click();
    await page.waitForTimeout(1500);
    check(
      (await rowsOf(TSX)) === before,
      `/${view}: a step change expands nothing (${before} line cells)`,
    );

    // the row the panel highlights holds the line it was asked for
    const flashed = (side, line) =>
      page.evaluate(
        ([side, k]) =>
          [...document.querySelectorAll('tr[data-dsm-flash]')].some((row) => {
            if (
              [...row.querySelectorAll('[data-line-anchor], td[id^="diff-"]')].some((cell) =>
                new RegExp(`^diff-[0-9a-f]{64}${side}${k}$`).test(
                  cell.getAttribute('data-line-anchor') || cell.id,
                ),
              )
            ) {
              return true;
            }
            return (
              side === 'L' &&
              [...row.querySelectorAll('[data-diff-line-key]')].some((cell) =>
                cell.getAttribute('data-diff-line-key').includes(`-l:${k}-`),
              )
            );
          }),
        [side, line],
      );
    const click = async (sel, side, line, what) => {
      await page.locator(`#dsm-panel .prs-body ${sel}`).first().click();
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        await page.waitForTimeout(500);
        ok = await flashed(side, line);
      }
      const msg = (await page.locator('#dsm-panel .prs-msg').textContent()).trim();
      check(ok, `/${view}: ${what} is opened and highlighted${msg ? ` ("${msg}")` : ''}`);
      if (SHOTS && !ok) {
        await page.screenshot({ path: path.join(SHOTS, `expand-${view}-${line}.png`) });
      }
    };
    await click('code[data-start="10"]', 'R', 10, 'a line above the first hunk (TSX:10)');
    await click('code[data-start="92"]', 'R', 92, 'a line in a short gap (TSX:92)');
    await click('code[data-start="150"]', 'R', 150, 'a line in a long gap (TSX:150-151)');
    check(await flashed('R', 151), `/${view}: the whole range is highlighted`);
    await click('code[data-start="20"][data-side="L"]', 'L', 20, 'an old-side line (TSX:L20)');
    await click('code[data-start="15"]', 'R', 15, 'a line past the last hunk (GQL:15)');

    // collapse the .tsx with its own toggle (as Viewed would), then a line link opens it again
    const collapse = async (rel) =>
      page.evaluate(async (rel) => {
        const sha = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rel))),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        const block = document.getElementById(`diff-${sha}`);
        const label = (button) =>
          (
            button.getAttribute('aria-label') ||
            (button.getAttribute('aria-labelledby') || '')
              .split(' ')
              .map((id) => document.getElementById(id)?.textContent || '')
              .join(' ')
          ).trim();
        const toggle = [...block.querySelectorAll('button')].find(
          (button) =>
            /^collapse file$/i.test(label(button)) ||
            (/toggle diff contents/i.test(label(button)) &&
              button.getAttribute('aria-expanded') === 'true'),
        );
        if (!toggle) {
          return false;
        }
        toggle.click();
        await new Promise((res) => setTimeout(res, 800));
        return [...block.querySelectorAll('tr')].every((row) => !row.getClientRects().length);
      }, rel);
    check(await collapse(TSX), `/${view}: the test collapses ${TSX} with GitHub's toggle`);
    await click('code[data-start="150"]', 'R', 150, 'a line in a collapsed file');
    check(await collapse(GQL), `/${view}: the test collapses ${GQL} with GitHub's toggle`);
    await page
      .locator(`#dsm-panel .prs-body code[data-rel="${GQL}"]:not([data-start])`)
      .first()
      .click();
    const flashedOpen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-dsm-flash]')].some((el) =>
          [...el.querySelectorAll('tr')].some((row) => row.getClientRects().length),
        ),
      );
    let open = false;
    for (let i = 0; i < 20 && !open; i++) {
      await page.waitForTimeout(300);
      open = (await rowsOf(GQL)) > 0 && (await flashedOpen());
    }
    check(open, `/${view}: a file link into a collapsed file expands it`);

    check(
      new URL(page.url()).searchParams.get('w') === '1' && new URL(page.url()).pathname === landed,
      `/${view}: still on the same page with ?w=1 (${new URL(page.url()).pathname}${new URL(page.url()).search})`,
    );
    check((await viewedNow()) === viewed0, `/${view}: no Viewed toggle changed`);
    await page
      .locator('#dsm-panel ol.prs-map li[data-n="0"]')
      .click()
      .catch(() => {});
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await context.close();
  await bridge.close();
}
process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exitCode = failures ? 1 : 0;
