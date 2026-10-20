#!/usr/bin/env node
/**
 * Loads the unpacked extension into a throwaway Chromium (Playwright's, in a
 * temp profile; never your own Chrome) and checks it end to end against a
 * bridge on a random port with a temp home:
 *
 *   1. the options page saves the port and token and reaches the bridge
 *   2. on a public GitHub PR's /files and /changes pages (logged out) the
 *      panel docks, filters to a chapter, survives a reload on the same step,
 *      sends a question to the inbox, and hides and comes back on toggle
 *   3. the bridge's local page draws a local diff with the same panel,
 *      filters by chapter, and keeps Viewed and a fix-before-push note
 *
 *   node test/extension/load-test.mjs [--pr owner/repo#N] [--headed] [--shots DIR]
 *
 * PLAYWRIGHT_BROWSERS_PATH picks where Playwright's Chromium lives
 * (node node_modules/playwright-core/cli.js install chromium).
 */
/* global location, document */ // used inside page.evaluate
import { chromium } from 'playwright-core';
import path from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, writeJson, TOKEN, startBridge, localRepo } from '../helpers.mjs';
import { createLocalStory } from '../../bridge/lib/local.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'src');
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i < 0 ? dflt : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };
const PR = arg('pr', 'refined-github/refined-github#10280');
const SHOTS = arg('shots', null);
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const check = (ok, what) => { process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${what}\n`); if (!ok) failures++; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };

// ---------- a story for a public PR, made from its real file list
const [, owner, repo, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(PR);
const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, { headers: { Accept: 'application/vnd.github+json' } });
if (!res.ok) throw new Error(`GitHub API ${res.status} for ${PR}`);
const rels = (await res.json()).map(f => f.filename);
if (rels.length < 2) throw new Error(`${PR} has ${rels.length} files; pick a PR with at least 2`);
const half = Math.ceil(rels.length / 2);
const home = tmp('ext-home');
const id = `${owner}-${repo}-${number}`;
writeJson(path.join(home, id, 'meta.json'), { kind: 'github', repo: `${owner}/${repo}`, number: +number });
writeJson(path.join(home, id, 'chapters.json'), {
  title: `Test story for ${PR}`, overview: `### Overview\n\nA test story with ${rels.length} files.`,
  chapters: [
    { title: 'Chapter 1: First half', narrative: `### Chapter 1: First half\n\nStarts with \`${rels[0]}\`.`, files: rels.slice(0, half) },
    { title: 'Chapter 2: Second half', narrative: '### Chapter 2: Second half', files: rels.slice(half) },
  ],
});
// a local story too
const { repo: lrepo, base } = localRepo();
const lchapters = path.join(tmp('lch'), 'chapters.json');
writeJson(lchapters, { title: 'Local test', chapters: [{ title: 'Chapter 1: One', files: ['one.txt'], comments: [{ path: 'one.txt', line: 2, body: 'Fix B' }] }, { title: 'Chapter 2: The rest', files: ['lib/two.js', 'gone.txt'] }] });
const local = createLocalStory({ home, repo: lrepo, base, head: 'HEAD', chapters: lchapters });

const bridge = await startBridge({ home });
const port = bridge.server.address().port;

const profile = tmp('ext-profile');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !arg('headed', false),
  viewport: { width: 1500, height: 1000 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  check(/^[a-p]{32}$/.test(extId), `extension loaded (${extId})`);

  // 1. options page
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/html/options.html`);
  await opt.fill('#port', String(port));
  await opt.fill('#token', TOKEN);
  await opt.click('button[type=submit]');
  await opt.waitForSelector('#status.ok >> text=Connected', { timeout: 5000 }).catch(() => {});
  check(/Connected to the bridge/.test(await opt.textContent('#status')), `options page saves settings and reaches the bridge: "${await opt.textContent('#status')}"`);
  await opt.close();

  // 2. GitHub
  const page = await context.newPage();
  const pageBridgeCalls = [];
  page.on('request', r => { if (r.url().startsWith('http://127.0.0.1')) pageBridgeCalls.push(r.url()); });
  for (const view of ['files', 'changes']) {
    const url = `https://github.com/${owner}/${repo}/pull/${number}/${view}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const landed = new URL(page.url()).pathname;
    const host = await page.waitForSelector('#diff-story-panel', { timeout: 15000, state: 'attached' }).catch(() => null);
    check(!!host, `/${view}: panel docks (landed on ${landed})`);
    if (!host) { await shot(page, `github-${view}-nopanel`); continue; }
    await page.waitForTimeout(2500); // lazy-loaded diffs
    const note = () => page.locator('#dsm-panel .prs-count-note').textContent();
    check(/Overview/.test(await note()), `/${view}: starts at the Overview: "${await note()}"`);
    await page.locator('#dsm-panel .prs-next').click();
    await page.waitForTimeout(800);
    const n1 = await note();
    const hidden = await page.locator('[data-dsm-hidden]').count();
    check(/chapter 1/.test(n1), `/${view}: Next goes to chapter 1: "${n1.trim()}"`);
    check(hidden > 0, `/${view}: other chapter's files and tree rows are hidden (${hidden} elements)`);
    check((await page.locator('[hidden][data-dsm-hid]').count()) > 0, `/${view}: hidden files also carry the hidden attribute (for Refined GitHub's alt-click mark-viewed)`);
    // what Refined GitHub's j/k does: set the hash to the next file in page order, hidden or not
    const jumped = await page.evaluate(async ([inCh, outCh, chapterOne]) => {
      const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      location.replace('#diff-' + (await sha(inCh)));
      await new Promise((r) => setTimeout(r, 100));
      location.replace('#diff-' + (await sha(outCh)));
      await new Promise((r) => setTimeout(r, 300));
      const ch1 = await Promise.all(chapterOne.map(sha));
      const msg = document.querySelector('#diff-story-panel').shadowRoot.querySelector('.prs-msg').textContent;
      return { inChapter: ch1.includes(location.hash.slice(6, 70)), msg };
    }, [rels[0], rels[half], rels.slice(0, half)]);
    check(jumped.inChapter || /isn't in this chapter/.test(jumped.msg), `/${view}: a hash jump onto a hidden file moves on to a chapter file, or says why not (${jumped.inChapter ? 'moved' : jumped.msg})`);
    await shot(page, `github-${view}-chapter1`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#diff-story-panel', { timeout: 15000, state: 'attached' });
    await page.waitForTimeout(1500);
    check(/chapter 1/.test(await note()), `/${view}: a reload comes back on chapter 1: "${(await note()).trim()}"`);
    // go back to the Overview for the next view
    await page.locator('#dsm-panel ol.prs-map li[data-n="0"]').click();
    await page.waitForTimeout(300);
  }

  // question, from the GitHub page
  await page.locator('#dsm-panel .prs-ask textarea').fill('Why two halves?');
  await page.locator('#dsm-panel .prs-ask button').click();
  await page.waitForTimeout(800);
  const inbox = existsSync(path.join(home, 'inbox.jsonl')) ? readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const q = inbox.find(e => e.type === 'question' && e.text === 'Why two halves?');
  check(!!q && q.story === id, 'a question from the panel lands in the inbox');
  check(inbox.some(e => e.type === 'position' && e.story === id), 'the position lands in the inbox');
  if (q) {
    await bridge.call('POST', '/api/answers', { question: q.id, text: 'Because **two** chapters.' });
    await page.waitForTimeout(4500);
    check(/Because two chapters/.test(await page.locator('#dsm-panel .prs-questions').textContent()), 'the answer shows in the panel');
  }

  // hide with the x, reload, still hidden, toggle brings it back
  await page.locator('#dsm-panel .prs-close').click();
  await page.waitForTimeout(300);
  check((await page.locator('#diff-story-panel').count()) === 0 && (await page.locator('[data-dsm-hidden]').count()) === 0, 'x removes the panel and every filter');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  check((await page.locator('#diff-story-panel').count()) === 0, 'a hidden panel stays hidden after a reload');
  await page.bringToFront();
  await sw.evaluate(async () => {
    // what a toolbar click does: send 'toggle' to the active tab
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  });
  await page.waitForTimeout(1500);
  check((await page.locator('#diff-story-panel').count()) === 1, 'the toolbar toggle brings it back');
  check(pageBridgeCalls.length === 0, `the GitHub page itself makes no calls to the bridge (${pageBridgeCalls.length}); the service worker does`);

  // 3. local page
  const lp = await context.newPage();
  const errors = [];
  lp.on('pageerror', e => errors.push(e.message));
  await lp.goto(`http://127.0.0.1:${port}/local/${local.id}/`);
  await lp.waitForSelector('#diff-story-panel', { state: 'attached', timeout: 5000 });
  check((await lp.locator('[role=region][id^="diff-"]').count()) === 3, 'local page draws 3 file regions');
  await lp.locator('#dsm-panel .prs-next').click();
  await lp.waitForTimeout(400);
  const ln = await lp.locator('#dsm-panel .prs-count-note').textContent();
  check(/Showing 1 of 3/.test(ln), `local page filters to chapter 1: "${ln.trim()}"`);
  check(/Fix before push/.test(await lp.locator('#dsm-panel .prs-body').textContent()), 'local page labels drafted comments "Fix before push"');
  await lp.locator('#dsm-panel code[data-start]').first().click().catch(() => {});
  await lp.locator('.ds-file-wrap:not([data-dsm-hidden]) .ds-viewed').first().click();
  await lp.waitForTimeout(400);
  const viewed = JSON.parse(readFileSync(path.join(home, 'state', local.id, 'viewed.json'), 'utf8'));
  check(!!viewed['one.txt'], 'clicking Viewed on the local page is kept by the bridge');
  check(/✓ viewed/.test(await lp.locator('#dsm-panel .prs-files').textContent()), 'the panel sees the local Viewed toggle');
  await lp.locator('.ds-viewed[aria-pressed=true]').click(); // unfold again to reach a line
  await lp.locator('td.ds-num[data-line-anchor$="R2"]').first().click();
  await lp.locator('.ds-note-form textarea').fill('Lower-case B');
  await lp.locator('.ds-note-form button[type=submit]').click();
  await lp.waitForTimeout(400);
  const notes = JSON.parse(readFileSync(path.join(home, 'state', local.id, 'notes.json'), 'utf8'));
  check(notes.length === 1 && notes[0].line === 2, 'a fix-before-push note is kept by the bridge');
  await shot(lp, 'local-chapter1');
  await lp.reload();
  await lp.waitForSelector('#diff-story-panel', { state: 'attached', timeout: 5000 });
  await lp.waitForTimeout(300);
  check(/chapter 1/.test(await lp.locator('#dsm-panel .prs-count-note').textContent()), 'local page comes back on chapter 1 after a reload');
  check((await lp.locator('.ds-note-row').count()) === 1, 'the note is still on the line after a reload');
  check(errors.length === 0, `no page errors on the local page${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await context.close();
  await bridge.close();
}
process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exitCode = failures ? 1 : 0;
