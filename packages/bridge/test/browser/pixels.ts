/**
 * Pixel checks for the browser test: a screenshot is compared with a committed baseline PNG, and a miss writes the
 * actual and a diff image and says how many pixels differ. The compare is pure (`compare`); the rest drives Playwright.
 *
 * Baselines live in `pixels/<platform>/<name>.png` next to this file. They are text-rendered by this machine's
 * fonts, so each platform has its own folder, and a platform with no folder skips the step (one line on stdout)
 * instead of failing on glyph differences it doesn't own. `UPDATE_SNAPSHOTS=1` (or `--update-snapshots`) writes them.
 *
 * The match is strict on purpose: the same Chromium and fonts on the same machine render the same pixels, and a
 * color rename that lands on a nearly-right shade (#cf222e to #d1242f) is the failure this exists to catch. Per-pixel
 * threshold 0.005 in pixelmatch's OKLab distance with anti-aliased pixels counted (0.01 and the default 0.1 both
 * pass that exact pair), and no differing pixel is allowed.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Locator, Page } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Where baselines live: one folder per platform (`darwin`, `linux`...). */
export const BASELINE_ROOT = path.join(HERE, 'pixels');
export const baselineDir = (platform: string = process.platform) =>
  path.join(BASELINE_ROOT, platform);
/** Where a miss writes its actual and diff images (packages/bridge/test-results is gitignored). */
export const FAILURE_DIR = path.resolve(HERE, '../../test-results/pixel-diff');

/** The screens shot, each in both color schemes (so `<name>-light.png` and `<name>-dark.png`): the load test takes them all, and the fast suite checks the baselines are there. */
export const SCREENS = [
  'panel-github',
  'local-story',
  'local-qa',
  'local-error',
  'board',
  'toast',
  'story-tag',
] as const;
export const SCHEMES = ['light', 'dark'] as const;
export const baselineNames = () =>
  SCREENS.flatMap((screen) => SCHEMES.map((scheme) => `${screen}-${scheme}.png`));

/** pixelmatch's per-pixel distance below which two colors are the same (OKLab; 1 is black against white). */
export const THRESHOLD = 0.005;
/** How many differing pixels a shot may have. */
export const MAX_DIFF_PIXELS = 0;

export interface Comparison {
  /** The images' sizes differ (the text says how); nothing else is compared. */
  sizeMismatch: string | null;
  diffPixels: number;
  total: number;
  /** The diff image (red where the pixels differ), when the sizes match. */
  diffPng: Buffer | null;
}

/** Compares two PNGs pixel by pixel. */
export function compare(expected: Buffer, actual: Buffer): Comparison {
  const was = PNG.sync.read(expected);
  const now = PNG.sync.read(actual);
  const total = now.width * now.height;
  if (was.width !== now.width || was.height !== now.height) {
    return {
      sizeMismatch: `baseline is ${was.width}x${was.height}, shot is ${now.width}x${now.height}`,
      diffPixels: total,
      total,
      diffPng: null,
    };
  }
  const diff = new PNG({ width: was.width, height: was.height });
  const diffPixels = pixelmatch(was.data, now.data, diff.data, was.width, was.height, {
    threshold: THRESHOLD,
    includeAA: true,
  });
  return { sizeMismatch: null, diffPixels, total, diffPng: PNG.sync.write(diff) };
}

/** The Primer variable names the story UI reads: the names var() uses that no stylesheet here defines (an alias layer's own names are defined, so they drop out). */
export function primerNames(cssFiles: string[]): string[] {
  const css = cssFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  return [...used].filter((name) => !defined.has(name) && !name.startsWith('--ou-')).sort();
}

/**
 * GitHub's own Primer values for the variables the story UI reads, light and dark (github.com's functional color tokens).
 * The shots on GitHub's pages pin these on the page, so they look as they do on GitHub, don't move when github.com's CSS
 * does, and are the same before and after a change in the UI's own fallbacks. The fast suite checks every name the CSS
 * reads (primerNames) is here.
 */
export const PRIMER_PALETTE: Record<string, { light: string; dark: string }> = {
  '--bgColor-default': { light: '#ffffff', dark: '#0d1117' },
  '--bgColor-muted': { light: '#f6f8fa', dark: '#151b23' },
  '--bgColor-accent-muted': { light: '#ddf4ff', dark: '#388bfd1a' },
  '--bgColor-attention-muted': { light: '#fff8c5', dark: '#bb800926' },
  '--bgColor-emphasis': { light: '#25292e', dark: '#3d444d' },
  '--fgColor-default': { light: '#1f2328', dark: '#f0f6fc' },
  '--fgColor-muted': { light: '#59636e', dark: '#9198a1' },
  '--fgColor-accent': { light: '#0969da', dark: '#4493f8' },
  '--fgColor-attention': { light: '#9a6700', dark: '#d29922' },
  '--fgColor-danger': { light: '#d1242f', dark: '#f85149' },
  '--fgColor-success': { light: '#1a7f37', dark: '#3fb950' },
  '--fgColor-onEmphasis': { light: '#ffffff', dark: '#ffffff' },
  '--borderColor-default': { light: '#d1d9e0', dark: '#3d444d' },
  '--borderColor-muted': { light: '#d1d9e0b3', dark: '#3d444db3' },
};

/** A style rule that pins the Primer palette for a color scheme on the page and on the hosts the story UI mounts in. */
export const primerRule = (scheme: 'light' | 'dark'): string =>
  `html, body, #once-upon-panel, [data-ou-badge], [data-ou-convo] {${Object.entries(PRIMER_PALETTE)
    .map(([name, value]) => `${name}: ${value[scheme]} !important;`)
    .join(' ')}}`;

/** The names of the .css files under dirs, recursively. */
export function cssFilesUnder(...dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.css')) {
        found.push(full);
      }
    }
  };
  dirs.forEach(walk);
  return found;
}

const ELEMENT_MIN_SETTLE_MS = 300;

/**
 * CSS on every shot, in the page and in every shadow root. No scrollbars, and no resize grip on a textarea. With the grip
 * drawn, the Ask button's rounded corners came out of the raster two ways: in about 4 of 10 runs (local-qa, light or dark)
 * its bottom-right corner differed by 2 px, 3 to 4 shade levels, at 449,988 and 448,989, the same inside one run and
 * different between runs. The layout was measured in clean and flaky runs alike and is identical (the button at
 * x 1451.234375, width 38.765625, so its right edge is whole), so it was never a position that moved. Without the grip the
 * corners are the same in every run (0 of 10 flaked). The corners of the button differ from the grip-drawn ones, so the
 * baselines are shot without it.
 */
export const SHOT_STYLE = '*{scrollbar-width:none !important}textarea{resize:none !important}';

/** Takes the page to a still, hover-free state: mouse parked off the page, focus dropped (through shadow roots), scrolled to the top, fonts and two frames done. */
export async function settle(page: Page): Promise<void> {
  await page.mouse.move(-10, -10);
  await page.evaluate(async () => {
    let root: Document | ShadowRoot = document;
    for (;;) {
      const active: Element | null = root.activeElement;
      if (!active) {
        break;
      }
      (active as HTMLElement).blur();
      if (!active.shadowRoot) {
        break;
      }
      root = active.shadowRoot;
    }
    window.scrollTo(0, 0);
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export interface ShotOptions {
  /** The element to shoot, found on the page; the viewport when not given. */
  target?: (page: Page) => Locator;
  /** Elements painted over (a solid box) in the shot, because their text is a clock or a date. */
  mask?: (page: Page) => Locator[];
  /** Extra CSS for the shot only. */
  style?: string;
}

export interface Pixels {
  /** False on a platform with no baseline folder: nothing is compared, and shots say so once. */
  active: boolean;
  /** Takes the shot twice, back to back (they must match), then compares it with its baseline or, when updating, writes it. Answers the line to print and whether it is a failure. */
  shot(page: Page, name: string, options?: ShotOptions): Promise<{ ok: boolean; line: string }>;
}

export function createPixels(options: {
  update: boolean;
  platform?: string;
  dir?: string;
  failureDir?: string;
}): Pixels {
  const platform = options.platform ?? process.platform;
  const dir = options.dir ?? baselineDir(platform);
  const failureDir = options.failureDir ?? FAILURE_DIR;
  const active = options.update || existsSync(dir);
  rmSync(failureDir, { recursive: true, force: true });
  const rel = (file: string) => path.relative(process.cwd(), file) || file;
  const take = async (page: Page, { target, mask, style }: ShotOptions) =>
    (target ? target(page) : page).screenshot({
      animations: 'disabled',
      caret: 'hide',
      style: `${SHOT_STYLE}${style ?? ''}`,
      mask: mask?.(page) ?? [],
      maskColor: '#ff00ff',
    });
  const keepFailure = (name: string, actual: Buffer, diff: Buffer | null) => {
    mkdirSync(failureDir, { recursive: true });
    writeFileSync(path.join(failureDir, `${name}-actual.png`), actual);
    if (diff) {
      writeFileSync(path.join(failureDir, `${name}-diff.png`), diff);
    }
    return rel(path.join(failureDir, `${name}-${diff ? 'diff' : 'actual'}.png`));
  };
  return {
    active,
    async shot(page, name, shotOptions = {}) {
      await settle(page);
      // a poll that redraws, or a layout that is still settling, shows up as two different shots back to back: take
      // up to six, 700 ms apart, until two in a row match, and fail loudly if none do
      let actual = await take(page, shotOptions);
      let twin = { diffPixels: 1, diffPng: null as Buffer | null };
      for (let again = 0; again < 6 && twin.diffPixels > 0; again++) {
        await page.waitForTimeout(again === 0 ? ELEMENT_MIN_SETTLE_MS : 700);
        const next = await take(page, shotOptions);
        twin = compare(actual, next);
        actual = next;
      }
      if (twin.diffPixels > 0) {
        const file = keepFailure(`${name}-unstable`, actual, twin.diffPng);
        return {
          ok: false,
          line: `pixels ${name}: two shots back to back keep differing, by ${twin.diffPixels} px the last time (a redraw or a clock?), see ${file}`,
        };
      }
      const file = path.join(dir, `${name}.png`);
      if (options.update) {
        const old = existsSync(file) ? readFileSync(file) : null;
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, actual);
        if (!old) {
          return { ok: true, line: `pixels ${name}: baseline created (${rel(file)})` };
        }
        const was = compare(old, actual);
        return {
          ok: true,
          line:
            was.sizeMismatch || was.diffPixels > 0
              ? `pixels ${name}: baseline updated (${was.sizeMismatch ?? `${was.diffPixels} px changed`})`
              : `pixels ${name}: baseline unchanged`,
        };
      }
      if (!existsSync(file)) {
        keepFailure(name, actual, null);
        return {
          ok: false,
          line: `pixels ${name}: no baseline at ${rel(file)}; run UPDATE_SNAPSHOTS=1 yarn test:extension and commit it`,
        };
      }
      const result = compare(readFileSync(file), actual);
      if (result.sizeMismatch) {
        const out = keepFailure(name, actual, null);
        return { ok: false, line: `pixels ${name}: ${result.sizeMismatch}, see ${out}` };
      }
      if (result.diffPixels > MAX_DIFF_PIXELS) {
        const out = keepFailure(name, actual, result.diffPng);
        const percent = ((100 * result.diffPixels) / result.total).toFixed(3);
        return {
          ok: false,
          line: `pixels ${name}: ${result.diffPixels} of ${result.total} px differ (${percent}%, limit ${MAX_DIFF_PIXELS}), diff at ${out}`,
        };
      }
      return { ok: true, line: `pixels ${name}: matches its baseline` };
    },
  };
}
