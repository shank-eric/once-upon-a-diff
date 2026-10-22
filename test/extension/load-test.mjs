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
 *      filters by chapter, keeps Viewed and a fix-before-push note, and its
 *      Q&A says who answers and keeps collapse, Dismiss and Clear conversation
 *
 *   node test/extension/load-test.mjs [--pr owner/repo#N] [--headed] [--shots DIR]
 *
 * PLAYWRIGHT_BROWSERS_PATH picks where Playwright's Chromium lives
 * (node node_modules/playwright-core/cli.js install chromium).
 */
/* global chrome */ // the service worker's, inside worker.evaluate
import { chromium } from 'playwright-core';
import path from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmp, writeJson, TOKEN, startBridge, localRepo, runCli } from '../helpers.mjs';
import { createLocalStory } from '../../src/bridge/stories/local-story.mjs';
import { beat } from '../../src/bridge/listeners/listeners.mjs';
import { Builds } from '../../src/bridge/inbox/builds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT = path.join(ROOT, 'src/extension');
const args = process.argv.slice(2);
/** --name's value, true for a bare --name, or the fallback when it isn't given. */
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    return fallback;
  }
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const PR_REF = arg('pr', 'refined-github/refined-github#10280');
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
const shot = async (page, name) => {
  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  }
};

// ---------- a story for a public PR, made from its real file list
const [, owner, repo, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(PR_REF);
const res = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
  { headers: { Accept: 'application/vnd.github+json' } },
);
if (!res.ok) {
  throw new Error(`GitHub API ${res.status} for ${PR_REF}`);
}
const rels = (await res.json()).map((file) => file.filename);
if (rels.length < 2) {
  throw new Error(`${PR_REF} has ${rels.length} files; pick a PR with at least 2`);
}
const half = Math.ceil(rels.length / 2);
const home = tmp('ext-home');
const buildRequests = () =>
  existsSync(path.join(home, 'builds.json'))
    ? Object.values(JSON.parse(readFileSync(path.join(home, 'builds.json'), 'utf8')))
    : [];
const id = `${owner}-${repo}-${number}`;
// the story was told from an older head ('a' x 40); the fake gh says the PR is now at 'b' x 40, with one file changed
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
writeJson(path.join(home, id, 'meta.json'), {
  kind: 'github',
  repo: `${owner}/${repo}`,
  number: +number,
  head_oid: OLD,
});
const extra = path.join(home, 'fake-gh-extra.json');
writeJson(extra, {
  [`repos/${owner}/${repo}/pulls/${number}`]: { head: { sha: NEW } },
  [`repos/${owner}/${repo}/compare/${OLD}...${NEW}`]: {
    status: 'ahead',
    ahead_by: 2,
    files: [{ filename: rels[rels.length - 1] }],
  },
});
process.env.ONCE_UPON_FAKE_GH_EXTRA = extra;
writeJson(path.join(home, id, 'chapters.json'), {
  title: `Test story for ${PR_REF}`,
  overview: `### Overview\n\nA test story with ${rels.length} files.`,
  chapters: [
    {
      title: 'Chapter 1: First half',
      narrative: `### Chapter 1: First half\n\nStarts with \`${rels[0]}\`.`,
      files: rels.slice(0, half),
    },
    // rels[0] is listed plainly in both chapters, with no partial flag: it's marked viewed in chapter 2, the last one
    {
      title: 'Chapter 2: Second half',
      narrative: '### Chapter 2: Second half',
      files: [...rels.slice(half), rels[0]],
    },
  ],
});
// a local story too
const { repo: lrepo, base } = localRepo();
const lchapters = path.join(tmp('lch'), 'chapters.json');
writeJson(lchapters, {
  title: 'Local test',
  chapters: [
    {
      title: 'Chapter 1: One',
      narrative:
        '### Chapter 1: One\n\nStarts with `one.txt`.\n\n1. Then `one.txt:2` and `:3`.\n\n**Files to mark viewed:** `one.txt`.',
      files: ['one.txt', { rel: 'lib/two.js', partial: true, note: 'the export' }],
      comments: [{ path: 'one.txt', line: 2, body: 'Fix B' }],
    },
    { title: 'Chapter 2: The rest', files: ['lib/two.js', 'gone.txt'] },
  ],
});
const local = createLocalStory({ home, repo: lrepo, base, head: 'HEAD', chapters: lchapters });

process.env.ONCE_UPON_GH = path.join(ROOT, 'test', 'fixtures', 'fake-gh.mjs'); // no real GitHub calls from the test bridge
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
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  const extId = new URL(worker.url()).host;
  check(/^[a-p]{32}$/.test(extId), `extension loaded (${extId})`);

  // 0. a PR tab opened before the extension is set up
  const early = await context.newPage();
  await early.goto(`https://github.com/${owner}/${repo}/pull/${number}/files`, {
    waitUntil: 'domcontentloaded',
  });
  await early.waitForTimeout(2000);
  check(
    (await early.locator('#once-upon-panel').count()) === 0,
    'no panel before the port and token are set',
  );

  // 1. options page
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/html/options.html`);
  await opt.fill('#port', String(port));
  await opt.fill('#token', TOKEN);
  await opt.click('#test');
  await opt.waitForSelector('#status.ok >> text=Connected', { timeout: 5000 }).catch(() => {});
  check(
    /^Connected to the bridge/.test(await opt.textContent('#status')),
    `Test connection uses the unsaved form values: "${await opt.textContent('#status')}"`,
  );
  await opt.click('button[type=submit]');
  await opt.waitForSelector('#status.ok >> text=Connected', { timeout: 5000 }).catch(() => {});
  check(
    /Connected to the bridge/.test(await opt.textContent('#status')),
    `options page saves settings and reaches the bridge: "${await opt.textContent('#status')}"`,
  );
  await opt.close();
  const late = await early
    .waitForSelector('#once-upon-panel', { state: 'attached', timeout: 5000 })
    .catch(() => null);
  check(
    !!late,
    'a tab opened before setup shows the panel once the settings are saved, without a reload',
  );
  await early.close();

  // 2. GitHub
  const page = await context.newPage();
  const pageBridgeCalls = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http://127.0.0.1')) {
      pageBridgeCalls.push(request.url());
    }
  });
  for (const view of ['files', 'changes']) {
    const url = `https://github.com/${owner}/${repo}/pull/${number}/${view}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const landed = new URL(page.url()).pathname;
    const host = await page
      .waitForSelector('#once-upon-panel', { timeout: 15000, state: 'attached' })
      .catch(() => null);
    check(!!host, `/${view}: panel docks (landed on ${landed})`);
    if (!host) {
      await shot(page, `github-${view}-nopanel`);
      continue;
    }
    await page.waitForTimeout(2500); // lazy-loaded diffs
    const look = await page.evaluate(() => {
      const panelHost = document.getElementById('once-upon-panel');
      return {
        position: getComputedStyle(panelHost.shadowRoot.getElementById('ou-panel')).position,
        visibility: getComputedStyle(panelHost).visibility,
        margin: getComputedStyle(document.body).marginRight,
      };
    });
    check(
      look.position === 'fixed' && look.visibility === 'visible' && look.margin !== '0px',
      `/${view}: panel.css and page.css apply on GitHub (${JSON.stringify(look)})`,
    );
    const note = () => page.locator('#ou-panel .ou-count-note').textContent();
    check(/Overview/.test(await note()), `/${view}: starts at the Overview: "${await note()}"`);
    await page.waitForTimeout(800);
    const freshText = await page.locator('#ou-panel .ou-fresh').textContent();
    check(
      /Story is for aaaaaaa; the PR has 2 newer commits \(1 file changed, in chapter 2\)/.test(
        freshText,
      ),
      `/${view}: an out-of-date story says so: "${freshText}"`,
    );
    check(
      (await page
        .locator('#ou-panel ol.ou-map li[data-n="2"] .ou-chg[data-why="story"]')
        .count()) === 1,
      `/${view}: the chapter touched since is marked in the Steps list`,
    );
    await page.waitForTimeout(500);
    check(
      (await page.locator('#ou-panel .ou-light[data-level="warn"]').count()) === 1,
      `/${view}: the status light is amber with no Claude listening: "${((await page.locator('#ou-panel .ou-light').getAttribute('title')) || '').split('\n')[0]}"`,
    );
    check(
      /No Claude session is listening/.test(
        await page.locator('#ou-panel .ou-askhint').textContent(),
      ),
      `/${view}: the Ask box says questions will wait`,
    );
    await page.locator('#ou-panel .ou-next').click();
    await page.waitForTimeout(800);
    const chapterOneNote = await note();
    const hidden = await page.locator('[data-ou-hidden]').count();
    check(
      /chapter 1/.test(chapterOneNote),
      `/${view}: Next goes to chapter 1: "${chapterOneNote.trim()}"`,
    );
    check(
      hidden > 0,
      `/${view}: other chapter's files and tree rows are hidden (${hidden} elements)`,
    );
    if (view === 'files') {
      const row = await page.locator(`#ou-panel li[data-file="${rels[0]}"]`).textContent();
      check(
        !/comes back|Leave unviewed|Mark viewed/i.test(row) &&
          (await page.locator(`#ou-panel li[data-file="${rels[0]}"] [data-mark-for]`).count()) ===
            0,
        `/${view}: a file listed in two chapters has no tag in the first: "${row}"`,
      );
    }
    // logged out there's no Viewed checkbox: Mark viewed says so and clicks nothing
    const markTry = await page.evaluate(async (rel) => {
      const root = document.getElementById('once-upon-panel').shadowRoot;
      const btn = root.querySelector(`li[data-file="${CSS.escape(rel)}"] button[data-mark-for]`);
      if (!btn) {
        return null;
      }
      btn.click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { label: btn.textContent, msg: root.querySelector('.ou-msg').textContent };
    }, rels[1]);
    check(
      !!markTry &&
        markTry.label === 'Mark viewed' &&
        /no Viewed checkbox|isn't loaded/.test(markTry.msg),
      `/${view}: Mark viewed is a button, and logged out it says there's nothing to tick: ${JSON.stringify(markTry)}`,
    );
    // with a Viewed toggle in the file's header (GitHub's shape when logged in), Mark viewed clicks that one toggle, and Viewed ✓ unclicks it
    const markLive = await page.evaluate(
      async ([rel, view]) => {
        const root = document.getElementById('once-upon-panel').shadowRoot;
        const btn = root.querySelector(`li[data-file="${CSS.escape(rel)}"] button[data-mark-for]`);
        const sha = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rel))),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        const block =
          view === 'files'
            ? document.querySelector(
                `copilot-diff-entry[data-file-path="${CSS.escape(rel)}"], .file[data-tagsearch-path="${CSS.escape(rel)}"]`,
              )
            : document.getElementById(`diff-${sha}`);
        if (!btn || !block) {
          return { btn: !!btn, block: !!block };
        }
        let clicks = 0;
        let toggle;
        if (view === 'files') {
          toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.className = 'js-reviewed-checkbox';
        } else {
          toggle = document.createElement('button');
          toggle.textContent = 'Viewed';
          toggle.setAttribute('aria-pressed', 'false');
          toggle.addEventListener('click', () =>
            toggle.setAttribute(
              'aria-pressed',
              String(toggle.getAttribute('aria-pressed') !== 'true'),
            ),
          );
        }
        toggle.addEventListener('click', () => {
          clicks++;
        });
        block.prepend(toggle);
        const listening = () =>
          toggle.matches('input') ? toggle.checked : toggle.getAttribute('aria-pressed') === 'true';
        const wait = () => new Promise((resolve) => setTimeout(resolve, 500));
        await wait();
        const before = { label: btn.textContent, on: listening(), clicks };
        btn.click();
        await wait();
        const ticked = { label: btn.textContent, on: listening(), clicks };
        btn.click();
        await wait();
        const unticked = { label: btn.textContent, on: listening(), clicks };
        toggle.remove();
        return { before, ticked, unticked };
      },
      [rels[1], view],
    );
    check(
      !!markLive.before &&
        !markLive.before.on &&
        markLive.before.clicks === 0 &&
        markLive.before.label === 'Mark viewed',
      `/${view}: nothing ticks the toggle before a click: ${JSON.stringify(markLive.before || markLive)}`,
    );
    check(
      !!markLive.ticked &&
        markLive.ticked.on &&
        markLive.ticked.clicks === 1 &&
        markLive.ticked.label === 'Viewed ✓',
      `/${view}: Mark viewed clicks that file's Viewed toggle once and says Viewed ✓: ${JSON.stringify(markLive.ticked)}`,
    );
    check(
      !!markLive.unticked &&
        !markLive.unticked.on &&
        markLive.unticked.clicks === 2 &&
        markLive.unticked.label === 'Mark viewed',
      `/${view}: Viewed ✓ unticks it: ${JSON.stringify(markLive.unticked)}`,
    );
    check(
      (await page.locator('[hidden][data-ou-hid]').count()) > 0,
      `/${view}: hidden files also carry the hidden attribute (for Refined GitHub's alt-click mark-viewed)`,
    );
    // what Refined GitHub's j/k does: set the hash to the next file in page order, hidden or not
    const jumped = await page.evaluate(
      async ([inCh, outCh, chapterOne]) => {
        const sha = async (text) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        location.replace('#diff-' + (await sha(inCh)));
        await new Promise((resolve) => setTimeout(resolve, 100));
        location.replace('#diff-' + (await sha(outCh)));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const ch1 = await Promise.all(chapterOne.map(sha));
        const msg = document
          .querySelector('#once-upon-panel')
          .shadowRoot.querySelector('.ou-msg').textContent;
        return { inChapter: ch1.includes(location.hash.slice(6, 70)), msg };
      },
      [rels[0], rels[half], rels.slice(0, half)],
    );
    check(
      jumped.inChapter || /isn't in this chapter/.test(jumped.msg),
      `/${view}: a hash jump onto a hidden file moves on to a chapter file, or says why not (${jumped.inChapter ? 'moved' : jumped.msg})`,
    );
    await shot(page, `github-${view}-chapter1`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#once-upon-panel', { timeout: 15000, state: 'attached' });
    await page.waitForTimeout(1500);
    check(
      /chapter 1/.test(await note()),
      `/${view}: a reload comes back on chapter 1: "${(await note()).trim()}"`,
    );
    // go back to the Overview for the next view
    await page.locator('#ou-panel ol.ou-map li[data-n="0"]').click();
    await page.waitForTimeout(300);
  }

  // Update (new commits) sends a build request with mode 'update', the story's head, and where his reading stopped (nothing read: the story's head)
  await page.locator('#ou-panel .ou-update[data-retell="0"]').click();
  await page.waitForTimeout(600);
  const upd = buildRequests().find((build) => build.mode === 'update');
  check(
    !!upd && upd.base_sha === OLD && upd.number === +number && upd.since_sha === OLD && !upd.retell,
    'Update (new commits) asks for a "Since you read it" chapter from the story\'s head',
  );

  // question, from the GitHub page
  await page.locator('#ou-panel .ou-ask textarea').fill('Why two halves?');
  await page.locator('#ou-panel .ou-ask button').click();
  await page.waitForTimeout(800);
  const inbox = existsSync(path.join(home, 'inbox.jsonl'))
    ? readFileSync(path.join(home, 'inbox.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  const question = inbox.find((e) => e.type === 'question' && e.text === 'Why two halves?');
  check(!!question && question.story === id, 'a question from the panel lands in the inbox');
  const positionFile = path.join(home, 'state', id, 'position.json');
  check(
    existsSync(positionFile) &&
      Number.isInteger(JSON.parse(readFileSync(positionFile, 'utf8')).step),
    'the position lands in position.json',
  );
  check(!inbox.some((e) => e.type === 'position'), 'and not in the inbox');
  if (question) {
    await runCli(home, [
      'answer',
      '--question',
      question.id,
      '--text',
      'Because **two** chapters.',
    ]);
    const answered = await page
      .locator('#ou-panel .ou-questions', { hasText: 'Because two chapters' })
      .waitFor({ timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    check(answered, 'the answer shows in the panel within a tick (5s)');
  }

  // hide with the x, reload, still hidden, toggle brings it back
  await page.locator('#ou-panel .ou-close').click();
  await page.waitForTimeout(300);
  check(
    (await page.locator('#once-upon-panel').count()) === 0 &&
      (await page.locator('[data-ou-hidden]').count()) === 0,
    'x removes the panel and every filter',
  );
  const filesTag = (tab) =>
    tab
      .locator('[data-ou-files]')
      .evaluate((host) => host.shadowRoot.textContent.trim())
      .catch(() => '');
  await page.waitForTimeout(300);
  check(
    /Update queued|Updating/.test(await filesTag(page)),
    `with the panel hidden, the story tag by the title says what the lists say: "${await filesTag(page)}"`,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  check(
    (await page.locator('#once-upon-panel').count()) === 0,
    'a hidden panel stays hidden after a reload',
  );
  await page.bringToFront();
  await worker.evaluate(async () => {
    // what a toolbar click does: send 'toggle' to the active tab
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  });
  await page.waitForTimeout(1500);
  check(
    (await page.locator('#once-upon-panel').count()) === 1,
    'the toolbar toggle brings it back',
  );
  check(
    pageBridgeCalls.length === 0,
    `the GitHub page itself makes no calls to the bridge (${pageBridgeCalls.length}); the service worker does`,
  );

  // the story tag on a PR with no story: Build story -> Queued -> the story turns up -> panel
  const NOSTORY = Number(arg('no-story-pr', 10298));
  const newPage = await context.newPage();
  await newPage.goto(`https://github.com/${owner}/${repo}/pull/${NOSTORY}/files`, {
    waitUntil: 'domcontentloaded',
  });
  await newPage
    .waitForSelector('[data-ou-files]', { state: 'attached', timeout: 10000 })
    .catch(() => null);
  check(
    /Build story/.test(await filesTag(newPage)),
    `a PR with no story shows Build story by the title: "${await filesTag(newPage)}"`,
  );
  await newPage.locator('[data-ou-files] button[data-act=build]').click();
  await newPage.waitForTimeout(800);
  check(
    /Queued/.test(await filesTag(newPage)),
    `clicking Build story shows it queued (no session has claimed it yet): "${await filesTag(newPage)}"`,
  );
  const listenText = await newPage
    .locator('#once-upon-listen-notice')
    .evaluate((host) => host.shadowRoot.textContent)
    .catch(() => '');
  check(
    new RegExp(`No session listening for ${owner}/${repo}`, 'i').test(listenText),
    'and the page says no session is listening for the repo',
  );
  const noticePosition = await newPage
    .locator('#once-upon-listen-notice')
    .evaluate((host) => getComputedStyle(host.shadowRoot.querySelector('.n')).position)
    .catch(() => '');
  check(noticePosition === 'fixed', `and the notice has listen-notice.css (${noticePosition})`);
  const breq = buildRequests().find((build) => build.number === NOSTORY);
  check(
    !!breq && breq.url === `https://github.com/${owner}/${repo}/pull/${NOSTORY}`,
    'the build request lands in builds.json',
  );
  const other = await context.newPage();
  await other.goto(`https://github.com/${owner}/${repo}/pull/${NOSTORY}/files`, {
    waitUntil: 'domcontentloaded',
  });
  await other
    .waitForSelector('[data-ou-files]', { state: 'attached', timeout: 10000 })
    .catch(() => null);
  check(/Queued/.test(await filesTag(other)), 'another tab on that PR shows it queued too');
  await other.close();
  writeJson(path.join(home, `${owner}-${repo}-${NOSTORY}`, 'meta.json'), {
    kind: 'github',
    repo: `${owner}/${repo}`,
    number: NOSTORY,
  });
  writeJson(path.join(home, `${owner}-${repo}-${NOSTORY}`, 'chapters.json'), {
    title: 'Built',
    chapters: [{ title: 'Chapter 1: All', files: ['readme.md'] }],
  });
  // the tag looks again every 10s while queued, and status-many's answers can be 5s old
  const built = await newPage
    .waitForSelector('#once-upon-panel', { state: 'attached', timeout: 25000 })
    .catch(() => null);
  check(
    !!built,
    'when the story turns up, the panel opens by itself (looking again every 10s while queued)',
  );
  check(
    (await newPage.locator('[data-ou-files]').count()) === 0 &&
      (await newPage.locator('#once-upon-listen-notice').count()) === 0,
    'and the tag and the notice go away',
  );
  await newPage.locator('#ou-panel .ou-close').click();
  await newPage.waitForTimeout(300);
  check(
    /^Story$/.test(await filesTag(newPage)),
    `with the panel closed, the tag says Story: "${await filesTag(newPage)}"`,
  );
  await newPage
    .locator('[data-ou-files]')
    .evaluate((host) => host.shadowRoot.querySelector('a').click());
  await newPage.waitForTimeout(800);
  check(
    (await newPage.locator('#once-upon-panel').count()) === 1 &&
      new URL(newPage.url()).pathname.endsWith(`/pull/${NOSTORY}/files`),
    'and clicking it brings the panel back on this page',
  );
  await newPage.close();

  // PR list tags: one per PR (Story / Queued / Building… / Build story), one batched lookup, and a notice per repo with no listener
  const list = await context.newPage();
  await list.goto(`https://github.com/${owner}/${repo}/pulls?q=is%3Apr+is%3Amerged`, {
    waitUntil: 'domcontentloaded',
  });
  await list
    .waitForSelector('[data-ou-badge]', { state: 'attached', timeout: 15000 })
    .catch(() => null);
  await list.waitForTimeout(1500);
  const badges = await list.evaluate(() =>
    [...document.querySelectorAll('[data-ou-badge]')].map((host) => ({
      key: host.getAttribute('data-ou-badge'),
      text: host.shadowRoot.textContent.replace(/\s+/g, ' ').trim(),
      // story-tag.css applied: the tag is a pill
      styled: getComputedStyle(host.shadowRoot.querySelector('.b')).borderTopLeftRadius !== '0px',
    })),
  );
  const byKey = new Map(badges.map((badge) => [badge.key, badge.text]));
  const k = (number) => `${owner}/${repo}#${number}`.toLowerCase();
  check(badges.length >= 5, `the PR list gets a badge per PR (${badges.length})`);
  check(
    badges.length > 0 && badges.every((badge) => badge.styled),
    'every badge has story-tag.css (a pill)',
  );
  if (byKey.has(k(number))) {
    check(
      /Update queued|Updating/.test(byKey.get(k(number))),
      `the PR whose story is being updated says so: "${byKey.get(k(number))}"`,
    );
  } else {
    process.stdout.write(
      `note: #${number} isn't on the first page of the list, so its "Story" badge wasn't checked\n`,
    );
  }
  check(
    [...byKey.values()].some((text) => /Build story/.test(text)),
    'PRs without a story say "Build story"',
  );
  const target = badges.find((badge) => /Build story/.test(badge.text));
  if (target) {
    await list.locator(`[data-ou-badge="${target.key}"] button[data-act=build]`).click();
    await list.waitForTimeout(800);
    check(
      /Queued/.test(
        await list
          .locator(`[data-ou-badge="${target.key}"]`)
          .evaluate((host) => host.shadowRoot.textContent),
      ),
      'clicking Build story on the list shows Queued',
    );
    check(
      (await list
        .locator(`[data-ou-badge="${target.key}"]`)
        .evaluate((host) => host.shadowRoot.querySelectorAll('.b').length)) === 1,
      'one tag per row',
    );
    const number = Number(target.key.split('#')[1]);
    check(
      buildRequests().some((build) => build.number === number && build.status === 'pending'),
      'and sends the same build request as the PR page',
    );
  }
  const noticeText = await list
    .locator('#once-upon-listen-notice')
    .evaluate((host) => host.shadowRoot.textContent)
    .catch(() => '');
  check(
    new RegExp(`No session listening for ${owner}/${repo}`, 'i').test(noticeText) &&
      /Copy prompt for Claude/.test(noticeText),
    'the list says once that no session is listening for the repo, with Copy prompt for Claude',
  );
  await shot(list, 'pr-list');
  await list.close();

  // the PR's Conversation tab: the same single tag next to the title, and the same notice
  const convo = await context.newPage();
  await convo.goto(`https://github.com/${owner}/${repo}/pull/${NOSTORY}`, {
    waitUntil: 'domcontentloaded',
  });
  await convo
    .waitForSelector('[data-ou-convo]', { state: 'attached', timeout: 15000 })
    .catch(() => null);
  const convoTag = await convo
    .locator('[data-ou-convo]')
    .evaluate((host) => ({
      text: host.shadowRoot.textContent,
      tags: host.shadowRoot.querySelectorAll('.b').length,
      href: (host.shadowRoot.querySelector('a') || {}).href || '',
    }))
    .catch(() => null);
  check(
    !!convoTag && /Story/.test(convoTag.text) && convoTag.tags === 1,
    `the Conversation tab gets one story tag by the title (${convoTag && convoTag.text})`,
  );
  check(
    !!convoTag && convoTag.href === `https://github.com/${owner}/${repo}/pull/${NOSTORY}/changes`,
    'and Story links to Files changed, where the panel docks',
  );
  await convo.goto(`https://github.com/${owner}/${repo}/pull/${number}/files`, {
    waitUntil: 'domcontentloaded',
  });
  await convo.waitForTimeout(1500);
  check((await convo.locator('[data-ou-convo]').count()) === 0, 'and only on the Conversation tab');
  await convo.close();

  // a "Since you read it" chapter first: not numbered, the chapters he read keep their numbers, and it links GitHub's diff of its commits
  const commits = await (
    await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}/commits`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
  ).json();
  const since = {
    from: commits[0].sha,
    to: commits[commits.length - 1].sha,
    commits: commits.length - 1,
  };
  const plan = JSON.parse(readFileSync(path.join(home, id, 'chapters.json'), 'utf8'));
  plan.chapters.unshift({
    key: 'since-test',
    title: 'Since you read it: new commits',
    since,
    narrative: '### Since you read it\n\nThe new commits.',
    files: [rels[rels.length - 1]],
  });
  writeJson(path.join(home, id, 'chapters.json'), plan);
  const sincePage = await context.newPage();
  await sincePage.goto(`https://github.com/${owner}/${repo}/pull/${number}/files`, {
    waitUntil: 'domcontentloaded',
  });
  await sincePage.waitForSelector('#once-upon-panel', { state: 'attached', timeout: 15000 });
  await sincePage.locator('#ou-panel ol.ou-map li[data-n="0"]').click();
  const stepsText = await sincePage.locator('#ou-panel ol.ou-map').textContent();
  check(
    /New Since you read it: new commits/.test(stepsText) &&
      /1\. First half/.test(stepsText) &&
      /2\. Second half/.test(stepsText),
    `the Steps list shows it as New and keeps the old numbers: "${stepsText.replace(/\s+/g, ' ').trim()}"`,
  );
  await sincePage.locator('#ou-panel ol.ou-map li[data-n="1"]').click();
  const rangeHref = await sincePage
    .locator('#ou-panel .ou-since a')
    .getAttribute('href')
    .catch(() => null);
  check(
    rangeHref ===
      `https://github.com/${owner}/${repo}/pull/${number}/changes/${since.from}..${since.to}`,
    `it links GitHub's diff of just its commits (${rangeHref})`,
  );
  await sincePage.locator('#ou-panel ol.ou-map li[data-n="2"]').click();
  check(
    /Already finished in “Since you read it”/.test(
      await sincePage.locator('#ou-panel .ou-body').textContent(),
    ) || !rels.slice(0, half).includes(rels[rels.length - 1]),
    'a file it lists is finished there, not in the old chapter',
  );
  await sincePage.locator('#ou-panel ol.ou-map li[data-n="3"]').click();
  check(
    /Already finished in “Since you read it”/.test(
      await sincePage.locator('#ou-panel details.ou-filesbox').textContent(),
    ),
    'the old chapter that listed it says it was finished in "Since you read it"',
  );
  await sincePage.goto(rangeHref, { waitUntil: 'domcontentloaded' });
  await sincePage.waitForSelector('#once-upon-panel', { state: 'attached', timeout: 15000 });
  await sincePage.waitForTimeout(1500);
  check(
    /“Since you read it”/.test(await sincePage.locator('#ou-panel .ou-count-note').textContent()) &&
      /You're on GitHub's diff of just these commits/.test(
        await sincePage.locator('#ou-panel .ou-since').textContent(),
      ),
    `GitHub's diff of those commits opens on that chapter: "${(await sincePage.locator('#ou-panel .ou-count-note').textContent()).trim()}"`,
  );
  await sincePage.close();

  // 3. local page
  beat(home, 'load-test', 'waiting');
  const localPage = await context.newPage();
  const errors = [];
  localPage.on('pageerror', (e) => errors.push(e.message));
  await localPage.goto(`http://127.0.0.1:${port}/local/${local.id}/`);
  await localPage.waitForSelector('#once-upon-panel', { state: 'attached', timeout: 5000 });
  check(
    (await localPage.locator('[role=region][id^="diff-"]').count()) === 3,
    'local page draws 3 file regions',
  );
  await localPage.waitForTimeout(500);
  check(
    (await localPage.locator('#ou-panel .ou-light[data-level="ok"]').count()) === 1,
    `the status light is green with a listener: "${((await localPage.locator('#ou-panel .ou-light').getAttribute('title')) || '').replace(/\n/g, ' | ')}"`,
  );
  check(
    await localPage.locator('#ou-panel .ou-askhint').isHidden(),
    'and the Ask box has no warning',
  );
  // the Overview lists every chapter's drafts, grouped by chapter, with their actions
  const allc = localPage.locator('#ou-panel details.ou-allc');
  check(
    (await allc.count()) === 1 && (await allc.getAttribute('open')) !== null,
    'the Overview lists all drafted comments, open when there are few',
  );
  check(
    /Chapter 1/.test(await allc.locator('.ou-cgh').first().textContent()) &&
      /one\.txt:2/.test(await allc.locator('.ou-where').first().textContent()),
    `grouped by chapter, with file:line: "${(await allc.locator('.ou-where').first().textContent()).trim()}"`,
  );
  check(
    /Draft, not posted/.test(await allc.locator('.ou-cstate').first().textContent()) &&
      (await allc.locator('[data-draft-act="dismiss"]').count()) === 1,
    "each shows its state and its chapter's actions",
  );
  check(
    (await localPage.locator('#ou-panel [data-draft-act="posted"]').count()) === 0,
    'there is no Mark posted: posted is what gh finds',
  );
  await allc.locator('[data-draft-act="dismiss"]').click();
  await localPage.waitForTimeout(400);
  check(/Show dismissed \(1\)/.test(await allc.textContent()), 'Dismiss works from the Overview');
  await allc.locator('[data-draft-act="restore"]').dispatchEvent('click'); // its row is folded behind Show dismissed
  await localPage.waitForTimeout(400);
  await localPage.locator('#ou-panel .ou-next').click();
  await localPage.waitForTimeout(400);
  const localNote = await localPage.locator('#ou-panel .ou-count-note').textContent();
  check(/Showing 2 of 3/.test(localNote), `local page filters to chapter 1: "${localNote.trim()}"`);
  check(
    /Fix before push/.test(await localPage.locator('#ou-panel .ou-body').textContent()),
    'local page labels drafted comments "Fix before push"',
  );
  // drafts: Dismiss hides it behind "Show dismissed", and Restore brings it back
  await localPage.waitForTimeout(400);
  const drafts = () => localPage.locator('#ou-panel .ou-drafts').textContent();
  await localPage.locator('#ou-panel .ou-comment [data-draft-act="dismiss"]').click();
  await localPage.waitForTimeout(400);
  check(
    (await localPage.locator('#ou-panel .ou-comment[data-i="0"]').isHidden()) &&
      /Show dismissed \(1\)/.test(await drafts()),
    'Dismiss hides it behind "Show dismissed"',
  );
  await localPage.locator('#ou-panel [data-draft-show="showDismissed"]').click();
  await localPage.locator('#ou-panel .ou-comment [data-draft-act="restore"]').click();
  await localPage.waitForTimeout(400);
  check(
    await localPage.locator('#ou-panel .ou-comment[data-i="0"] pre').isVisible(),
    'Restore brings the draft back',
  );
  const prog = () => localPage.locator('#ou-panel .ou-progress').textContent();
  check(
    /0 of 1 marked viewed.*still to mark: one\.txt/.test(await prog()),
    `chapter progress lists what's left: "${await prog()}"`,
  );
  check(
    await localPage.evaluate(() => {
      const root = document.getElementById('once-upon-panel').shadowRoot;
      const progress = root.querySelector('.ou-progress');
      return (
        !!progress &&
        progress.closest('.ou-body') &&
        progress.previousElementSibling &&
        progress.previousElementSibling.tagName === 'H3'
      );
    }),
    'the tracker sits right under the chapter heading, not at the top of the panel',
  );
  check(
    (await localPage.locator('#ou-panel details.ou-filesbox[open]').count()) === 0,
    'Files in this chapter starts folded',
  );
  check(
    /1 to mark viewed/.test(
      await localPage.locator('#ou-panel details.ou-filesbox summary').textContent(),
    ),
    `the folded list has a summary: "${(await localPage.locator('#ou-panel details.ou-filesbox summary').textContent()).trim()}"`,
  );
  await localPage.locator('#ou-panel .ou-next').click();
  await localPage.waitForTimeout(300);
  check(
    /Chapter 1 still has 1 to mark viewed: one\.txt/.test(
      await localPage.locator('#ou-panel .ou-msg').textContent(),
    ),
    'moving on with files left gives a gentle note',
  );
  await localPage.locator('#ou-panel .ou-prev').click();
  await localPage.waitForTimeout(300);
  await localPage.locator('#ou-panel details.ou-filesbox summary').click();
  await localPage.waitForTimeout(300);
  // a line jump whose target moves after the first scroll (as when GitHub renders the files it passes) still ends on the line
  const settled = await localPage.evaluate(async () => {
    const link = document
      .getElementById('once-upon-panel')
      .shadowRoot.querySelector('.ou-comment code[data-start]');
    link.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    document.querySelector('.ou-local-files').prepend(spacer);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    const row = document.querySelector('tr[data-ou-flash]');
    const top = row ? row.getBoundingClientRect().top : null;
    spacer.remove();
    return { top, h: innerHeight };
  });
  check(
    settled.top !== null && settled.top > 0 && settled.top < settled.h,
    `a line jump re-scrolls when the page grows under it, and keeps the highlight (row at ${settled.top && Math.round(settled.top)}px)`,
  );
  // viewed too early: two.js comes back in chapter 2, gone.txt is only chapter 2's
  await localPage.locator('.ou-local-file[data-path="lib/two.js"] .ou-local-viewed').click();
  await localPage.waitForTimeout(500);
  const earlyText = () => localPage.locator('#ou-panel .ou-early-box').textContent();
  check(
    /two\.js is marked viewed, but chapter 2 covers more of it/.test(await earlyText()),
    `marking a "comes back later" file viewed warns in the chapter: "${await earlyText()}"`,
  );
  const twoRow = await localPage.locator('#ou-panel li[data-file="lib/two.js"]').textContent();
  check(
    !/comes back|Leave unviewed|Mark viewed/i.test(twoRow) && /here: the export/.test(twoRow),
    `a file a later chapter finishes has no tag, just its note: "${twoRow}"`,
  );
  check(
    /⚠ viewed early/.test(
      await localPage.locator('#ou-panel li[data-file="lib/two.js"] .ou-viewed').textContent(),
    ),
    'and on its file row',
  );
  await localPage.locator('#ou-panel .ou-all').click();
  await localPage.waitForTimeout(300);
  await localPage.locator('.ou-local-file[data-path="gone.txt"] .ou-local-viewed').click();
  await localPage.waitForTimeout(500);
  check(
    /gone\.txt is marked viewed early: it belongs to chapter 2/.test(await earlyText()),
    "a later chapter's file viewed early is flagged too",
  );
  await localPage.locator('.ou-local-file[data-path="gone.txt"] .ou-local-viewed').click();
  await localPage.locator('.ou-local-file[data-path="lib/two.js"] .ou-local-viewed').click();
  await localPage.locator('#ou-panel .ou-all').click();
  await localPage.waitForTimeout(500);
  check((await earlyText()) === '', 'unmarking them clears the warning');
  // the narrative's Mark viewed goes on a file's last mention in the chapter only; earlier mentions carry nothing
  const onePills = await localPage
    .locator('#ou-panel .ou-md [data-mark-for], #ou-panel .ou-md .ou-pill')
    .allTextContents();
  check(
    JSON.stringify(onePills) === JSON.stringify(['mark viewed']),
    `one.txt's button is on its last mention, nothing on the earlier ones: ${JSON.stringify(onePills)}`,
  );
  check(
    !/more below/.test(await localPage.locator('#ou-panel .ou-body').textContent()),
    'no "more below" anywhere',
  );
  const oneTag = () => localPage.locator('#ou-panel li[data-file="one.txt"] .ou-why').textContent();
  const oneToggle = () =>
    localPage
      .locator('.ou-local-file[data-path="one.txt"] .ou-local-viewed')
      .getAttribute('aria-pressed');
  const viewedJson = () =>
    existsSync(path.join(home, 'state', local.id, 'viewed.json'))
      ? JSON.parse(readFileSync(path.join(home, 'state', local.id, 'viewed.json'), 'utf8'))
      : {};
  check(
    /^Mark viewed/.test(await oneTag()) &&
      (await oneToggle()) === 'false' &&
      !viewedJson()['one.txt'],
    `a file the chapter finishes has a Mark viewed button, and nothing ticked it: "${await oneTag()}"`,
  );
  await localPage.locator('#ou-panel li[data-file="one.txt"] button[data-mark-for]').click();
  await localPage.waitForTimeout(500);
  check(
    /^Viewed ✓/.test(await oneTag()) && (await oneToggle()) === 'true',
    `clicking Mark viewed ticks the file's own Viewed toggle and says Viewed ✓: "${await oneTag()}"`,
  );
  check(
    await localPage
      .locator('.ou-local-file[data-path="one.txt"]')
      .evaluate((el) => el.classList.contains('ou-local-folded')),
    'and the page folds the file, as its own Viewed click does',
  );
  check(
    JSON.stringify(
      await localPage.locator('#ou-panel .ou-md [data-mark-for]').allTextContents(),
    ) === JSON.stringify(['viewed ✓']),
    "the narrative's button follows it",
  );
  check(!!viewedJson()['one.txt'], 'the bridge keeps the Viewed that Mark viewed set');
  check(
    (await localPage.locator('.ou-local-viewed[aria-pressed="true"]').count()) === 1,
    'Mark viewed ticked only that file',
  );
  check(
    (await localPage
      .locator('#ou-panel li[data-file="one.txt"] .ou-why button.ou-st-viewed')
      .count()) === 1,
    'the panel sees the local Viewed toggle',
  );
  check(
    /✓ All 1 marked viewed/.test(await prog()),
    `ticking the last one completes the chapter: "${await prog()}"`,
  );
  check(
    (await localPage.locator('#ou-panel .ou-stepprog.ou-done[data-prog-for="1"]').count()) === 1,
    'the Steps list shows a check on chapter 1',
  );
  await localPage.waitForTimeout(500);
  const reads = existsSync(path.join(home, 'state', local.id, 'read.json'))
    ? JSON.parse(readFileSync(path.join(home, 'state', local.id, 'read.json'), 'utf8'))
    : {};
  check(
    !!reads.one && reads.one.reason === 'viewed' && /^[0-9a-f]{40}$/.test(reads.one.head_sha || ''),
    `ticking a chapter's last file records it as read, with the range's head (${JSON.stringify(reads.one || null)})`,
  );
  await localPage.locator('#ou-panel .ou-md button[data-mark-for="one.txt"]').click(); // "viewed ✓" unticks it (and the page unfolds it, to reach a line)
  await localPage.waitForTimeout(500);
  check(
    (await oneToggle()) === 'false' &&
      !viewedJson()['one.txt'] &&
      /^Mark viewed/.test(await oneTag()),
    `clicking Viewed ✓ unticks it: "${await oneTag()}"`,
  );
  await localPage.locator('td.ou-local-num[data-line-anchor$="R2"]').first().click();
  await localPage.locator('.ou-local-note-form textarea').fill('Lower-case B');
  await localPage.locator('.ou-local-note-form button[type=submit]').click();
  await localPage.waitForTimeout(400);
  const notes = JSON.parse(readFileSync(path.join(home, 'state', local.id, 'notes.json'), 'utf8'));
  check(notes.length === 1 && notes[0].line === 2, 'a fix-before-push note is kept by the bridge');
  // Add to fix before push: the drafted comment becomes a note, and the draft says it's there
  await localPage.locator('#ou-panel .ou-drafts .ou-comment [data-draft-act="fix"]').click();
  await localPage.waitForTimeout(500);
  const fixState = await localPage
    .locator('#ou-panel .ou-drafts .ou-comment .ou-cstate')
    .first()
    .textContent();
  check(
    /In fix before push · Jump to line 2/.test(fixState) &&
      (await localPage.locator('#ou-panel .ou-drafts [data-draft-act="fix"]').count()) === 0,
    `Add to fix before push turns the draft into "In fix before push": "${fixState}"`,
  );
  const fixNotes = JSON.parse(
    readFileSync(path.join(home, 'state', local.id, 'notes.json'), 'utf8'),
  );
  check(
    fixNotes.length === 2 &&
      fixNotes.some(
        (note) => note.body === 'Fix B' && note.draft && note.path === 'one.txt' && note.line === 2,
      ),
    'it is a real note on that line',
  );
  check(
    /Fix B/.test(await localPage.locator('.ou-local-notes-list').textContent()) &&
      /2 open/.test(await localPage.locator('.ou-local-notes-toggle').textContent()),
    "and it shows in the page's checklist",
  );
  // Fix before push in the panel: both notes are drafts until Send hands them over as one request
  const fixBox = () => localPage.locator('#ou-panel .ou-fixes').textContent();
  check(
    /Fix before push \(2\)/.test(await fixBox()) &&
      (await localPage.locator('#ou-panel .ou-fixes [data-fix-act="send"]').textContent()) ===
        'Send 2 notes',
    `the panel lists the notes with Send 2 notes: "${await fixBox()}"`,
  );
  await localPage.locator('#ou-panel .ou-fixes [data-fix-act="send"]').click();
  await localPage.waitForTimeout(500);
  const sentNotes = JSON.parse(
    readFileSync(path.join(home, 'state', local.id, 'notes.json'), 'utf8'),
  );
  const fixRequests = JSON.parse(readFileSync(path.join(home, 'fixes.json'), 'utf8'));
  check(
    sentNotes.every((note) => note.sent) && Object.keys(fixRequests).length === 1,
    'Send makes one fix request of both notes',
  );
  check(
    /2 sent/.test(await fixBox()) &&
      (await localPage.locator('#ou-panel .ou-fixes [data-fix-act="remove"]').count()) === 0 &&
      /sent to/.test(await localPage.locator('.ou-local-note-row').first().textContent()),
    `sent notes are locked, here and in the diff: "${await fixBox()}"`,
  );
  // "being changed": a session's mark dims the file and names it, until it's done
  const requestId = Object.keys(fixRequests)[0];
  await runCli(home, [
    'working',
    '--request',
    requestId,
    '--files',
    'one.txt:2',
    '--consumer',
    'fixer',
  ]);
  await localPage.waitForTimeout(6000); // the next pulse
  check(
    /Being changed by fixer: one.txt \(line 2\)/.test(
      await localPage.locator('#ou-panel .ou-working').textContent(),
    ) && (await localPage.locator('[data-ou-changing="fixer"]').count()) === 1,
    `a "working" mark shows in the panel and dims the file: "${await localPage.locator('#ou-panel .ou-working').textContent()}"`,
  );
  await runCli(home, ['fixed', '--request', requestId, '--sha', 'abc1234', '--consumer', 'fixer']);
  await localPage.waitForTimeout(6000);
  check(
    (await localPage.locator('[data-ou-changing]').count()) === 0 &&
      /2 fixed/.test(await fixBox()) &&
      /Fixed in abc1234/.test(await fixBox()),
    `fixed clears the mark, and the notes say where they were fixed: "${await fixBox()}"`,
  );
  await shot(localPage, 'local-chapter1');
  await localPage.reload();
  await localPage.waitForSelector('#once-upon-panel', { state: 'attached', timeout: 5000 });
  await localPage.waitForTimeout(300);
  check(
    /chapter 1/.test(await localPage.locator('#ou-panel .ou-count-note').textContent()),
    'local page comes back on chapter 1 after a reload',
  );
  check(
    (await localPage.locator('#ou-panel details.ou-filesbox[open]').count()) === 1,
    'an opened files list stays open after a reload',
  );
  check(
    (await localPage.locator('.ou-local-note-row').count()) === 2,
    'the notes (his own and the added draft) are still on the line after a reload',
  );
  check(
    /In fix before push · fixed in abc1234/.test(
      await localPage.locator('#ou-panel .ou-drafts').textContent(),
    ),
    'and the draft still says In fix before push, fixed in its commit',
  );
  // a jump link is reachable by keyboard: Tab focuses it, Enter jumps as a click does
  const jumpLink = localPage.locator('#ou-panel .ou-body [data-rel][tabindex="0"]').first();
  await jumpLink.focus();
  check(
    await jumpLink.evaluate((el) => el.getRootNode().activeElement === el),
    'a file jump link takes focus',
  );
  await localPage.keyboard.press('Enter');
  await localPage.waitForTimeout(300);
  check(
    (await localPage.locator('[data-ou-flash]').count()) > 0,
    'Enter on a jump link jumps to the file (it flashes)',
  );
  // Q&A: who answers, Answered by, collapse, Dismiss with Undo, and Clear conversation, all kept by the bridge
  const askWho = () => localPage.locator('#ou-panel .ou-askwho').textContent();
  const qaCount = (selector = '.ou-qa') =>
    localPage.locator(`#ou-panel .ou-questions ${selector}`).count();
  const reloadPanel = async () => {
    await localPage.reload();
    await localPage.waitForSelector('#once-upon-panel', { state: 'attached', timeout: 5000 });
    await localPage.waitForTimeout(800);
  };
  beat(home, 'load-test', 'waiting');
  await reloadPanel();
  check(
    /Answered by load-test \(listening for everything\)/.test(await askWho()),
    `the line under the Ask box says who answers: "${(await askWho()).trim()}"`,
  );
  beat(home, 'api-10', 'waiting', { story: local.id });
  const storyTook = await localPage
    .locator('#ou-panel .ou-askwho', {
      hasText: 'api-10, the session listening for this story',
    })
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(storyTook, 'a story listener takes over on the next pulse, and the line says so');
  await localPage.locator('#ou-panel .ou-ask textarea').fill('Why B?');
  await localPage.locator('#ou-panel .ou-ask button').click();
  await localPage.waitForTimeout(800);
  const localQuestion = readFileSync(path.join(home, 'inbox.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
    .find((entry) => entry.type === 'question' && entry.text === 'Why B?');
  check(!!localQuestion, 'a question from the local page lands in the inbox');
  if (localQuestion) {
    await runCli(home, [
      'answer',
      '--question',
      localQuestion.id,
      '--text',
      'Because B.',
      '--consumer',
      'api-10',
    ]);
    const answeredBy = await localPage
      .locator('#ou-panel .ou-questions', { hasText: 'Answered by api-10' })
      .waitFor({ timeout: 7000 })
      .then(() => true)
      .catch(() => false);
    check(answeredBy, 'the answer says which session gave it');
    await localPage.locator('#ou-panel .ou-questions').scrollIntoViewIfNeeded();
    await shot(localPage, 'local-qa');
    await localPage.locator('#ou-panel .ou-qa [data-qa-act="collapse"]').click();
    check(
      (await qaCount('.ou-qa-collapsed')) === 1 && (await qaCount('.ou-a')) === 0,
      'collapse folds an exchange to its question',
    );
    await reloadPanel();
    check((await qaCount('.ou-qa-collapsed')) === 1, 'and it stays collapsed after a reload');
    await localPage.locator('#ou-panel .ou-qa [data-qa-act="dismiss"]').click();
    check(
      (await qaCount()) === 0 &&
        /Dismissed 1 question/.test(await localPage.locator('#ou-panel .ou-qundo').textContent()),
      'Dismiss hides it, with Undo',
    );
    await localPage.locator('#ou-panel [data-qa-act="undo"]').click();
    await localPage.waitForTimeout(300);
    check((await qaCount()) === 1, 'Undo brings it back');
    await localPage.locator('#ou-panel [data-qa-act="clear"]').click();
    await localPage.waitForTimeout(300);
    check(
      (await qaCount()) === 0 &&
        /Show dismissed \(1\)/.test(
          await localPage.locator('#ou-panel .ou-questions').textContent(),
        ),
      'Clear conversation dismisses every question, behind Show dismissed',
    );
    await reloadPanel();
    await localPage.waitForTimeout(5500);
    check(
      (await qaCount()) === 0 &&
        /Show dismissed \(1\)/.test(
          await localPage.locator('#ou-panel .ou-questions').textContent(),
        ),
      'a cleared conversation stays cleared after a reload and the next poll',
    );
    await localPage.locator('#ou-panel [data-qa-act="show-dismissed"]').click();
    await localPage.locator('#ou-panel .ou-qa-dismissed [data-qa-act="restore"]').click();
    await localPage.waitForTimeout(300);
    check(
      (await qaCount()) === 1 && (await qaCount('.ou-qa-dismissed')) === 0,
      'Show dismissed, then Restore, brings one back',
    );
  }
  // Rebuild from here: chapter 2's box asks what should change, queues a rebuild_from request, and the line under the
  // toolbar follows it to Rebuilt
  {
    await localPage.locator('#ou-panel ol.ou-map li[data-n="2"]').click();
    await localPage.locator('#ou-panel .ou-rebuild-open').click();
    check(
      /Chapter 1 stays exactly as it is/.test(
        await localPage.locator('#ou-panel .ou-rebuild-form').textContent(),
      ),
      'Rebuild from here says what it keeps',
    );
    await localPage.locator('#ou-panel .ou-rebuild-form textarea').fill('Tell gone.txt first');
    await localPage.locator('#ou-panel .ou-rebuild-form button[type="submit"]').click();
    await localPage.waitForTimeout(500);
    const asked = buildRequests().find((build) => build.story === local.id);
    check(
      !!asked &&
        asked.mode === 'rebuild_from' &&
        asked.from_step === 2 &&
        asked.guidance === 'Tell gone.txt first' &&
        asked.kind === 'local',
      `Queue rebuild sends a rebuild_from request for chapter 2 with the guidance: ${JSON.stringify(asked && { mode: asked.mode, from_step: asked.from_step, guidance: asked.guidance })}`,
    );
    const rebuildLine = () => localPage.locator('#ou-panel .ou-rebuilding').textContent();
    check(
      /^Rebuild from chapter 2 queued/.test(await rebuildLine()),
      `the panel says it's queued: "${await rebuildLine()}"`,
    );
    await localPage.locator('#ou-panel ol.ou-map li[data-n="0"]').click();
    check(
      (await localPage.locator('#ou-panel .ou-rebuild-open').textContent()) === 'Rebuild queued' &&
        (await localPage.locator('#ou-panel .ou-rebuild-open').isDisabled()),
      'and Rebuild story on the Overview waits for it',
    );
    new Builds(home).done(asked.id, { note: 'Re-told from chapter 2.' });
    await localPage.waitForTimeout(6000);
    check(
      /^Rebuilt from chapter 2 at .*Re-told from chapter 2\.$/.test(await rebuildLine()),
      `the pulse brings Rebuilt: "${await rebuildLine()}"`,
    );
    await localPage.locator('#ou-panel ol.ou-map li[data-n="1"]').click(); // back where the next checks read
  }
  // Claude rewrites chapters.json: the panel's pulse redraws it open, and the page's own poll while it's closed
  const localFile = path.join(local.dir, 'chapters.json');
  const rewrite = (word) => {
    const data = JSON.parse(readFileSync(localFile, 'utf8'));
    data.chapters[0].narrative += `\n\n${word}`;
    writeJson(localFile, data);
  };
  rewrite('Redrawn-open.');
  await localPage.waitForTimeout(6500);
  check(
    /Redrawn-open/.test(await localPage.locator('#ou-panel .ou-body').textContent()),
    'the local page redraws an open panel when chapters.json changes (its pulse)',
  );
  await localPage.locator('#ou-panel .ou-close').click();
  rewrite('Redrawn-closed.');
  await localPage.waitForTimeout(6500);
  await localPage.locator('.ou-local-reopen').click();
  await localPage.waitForTimeout(300);
  check(
    /Redrawn-closed/.test(await localPage.locator('#ou-panel .ou-body').textContent()),
    'and picks up a change made while the panel was closed',
  );
  check(
    errors.length === 0,
    `no page errors on the local page${errors.length ? `: ${errors.join('; ')}` : ''}`,
  );
} finally {
  await context.close();
  await bridge.close();
}
process.stdout.write(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exitCode = failures ? 1 : 0;
