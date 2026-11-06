/**
 * Bundles Preact, its hooks and htm (dev dependencies, exact versions in package.json) into one ES module the bridge
 * serves at /assets/preact.mjs, so the board page needs no CDN and no build step and the bridge no runtime dependencies.
 * The output is deterministic: the same versions give the same bytes, and public/vendor/preact.mjs.sha256 holds its
 * SHA-256 so a hand edit or a stale rebuild shows in a test. Run it after changing a version: yarn vendor
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const OUT = path.join(ROOT, 'public/vendor');
// not require.resolve('<name>/package.json'): htm's exports don't list it. The folder is where the main file's path passes node_modules/<name>
const pkgDir = (name: string) => {
  const marker = `node_modules${path.sep}${name}`;
  const main = require.resolve(name);
  return main.slice(0, main.lastIndexOf(marker) + marker.length);
};
const versionOf = (name: string): string =>
  JSON.parse(readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8')).version;

const preactVersion = versionOf('preact');
const htmVersion = versionOf('htm');

const bundle = await rolldown({
  input: path.join(ROOT, 'scripts/preact-entry.ts'),
  platform: 'browser',
  treeshake: true,
  logLevel: 'warn',
});
const { output } = await bundle.generate({ format: 'esm', minify: true, comments: false });
await bundle.close();
const chunks = output.filter((item) => item.type === 'chunk');
if (chunks.length !== 1) {
  throw new Error(`expected one chunk, got ${chunks.length}`);
}
const code = chunks[0].code.replace(/\n*\/\/# sourceMappingURL=.*\s*$/, '\n');
const out =
  `// Preact ${preactVersion} (MIT, see preact-LICENSE) with its hooks, and htm ${htmVersion} (Apache-2.0, see htm-LICENSE) bound to Preact's h as html.\n` +
  `// Made by scripts/vendor-preact.ts from the npm packages. Don't edit by hand; public/vendor/preact.mjs.sha256 is its checksum.\n` +
  code;
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'preact.mjs'), out);
const sha = createHash('sha256').update(out).digest('hex');
writeFileSync(path.join(OUT, 'preact.mjs.sha256'), `${sha}  preact.mjs\n`);
copyFileSync(path.join(pkgDir('preact'), 'LICENSE'), path.join(OUT, 'preact-LICENSE'));
copyFileSync(path.join(pkgDir('htm'), 'LICENSE'), path.join(OUT, 'htm-LICENSE'));
process.stdout.write(
  `wrote public/vendor/preact.mjs (${(out.length / 1024).toFixed(1)} KB, preact ${preactVersion}, htm ${htmVersion}, sha256 ${sha.slice(0, 12)})\n`,
);
