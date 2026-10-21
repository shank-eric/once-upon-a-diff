/**
 * Wraps highlight.js (a dev dependency) into one ES module the bridge serves
 * at /assets/highlight.mjs, so the local page needs no CDN and the bridge no
 * runtime dependencies. Run it after changing the version: yarn vendor
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PKG = path.dirname(require.resolve('highlight.js/package.json'));
const { version } = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
// erb's grammar uses xml and ruby, so they come first
const LANGS = [
  'xml',
  'ruby',
  'erb',
  'javascript',
  'typescript',
  'json',
  'yaml',
  'css',
  'scss',
  'markdown',
  'bash',
  'shell',
];
const OUT = path.join(ROOT, 'bridge/public/vendor');

const wrap = (file) =>
  `(() => { const module = { exports: {} }; const exports = module.exports;\n${readFileSync(file, 'utf8')}\nreturn module.exports; })()`;
let out = `// highlight.js ${version} (BSD-3-Clause, see highlight.js-LICENSE): core and ${LANGS.join(', ')}.\n// Made by scripts/vendor-hljs.mjs from the npm package. Don't edit by hand.\n`;
out += `const hljs = ${wrap(path.join(PKG, 'lib/core.js'))};\n`;
for (const lang of LANGS) {
  out += `hljs.registerLanguage('${lang}', ${wrap(path.join(PKG, 'lib/languages', `${lang}.js`))});\n`;
}
out += 'export default hljs;\n';
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'highlight.mjs'), out);
copyFileSync(path.join(PKG, 'LICENSE'), path.join(OUT, 'highlight.js-LICENSE'));
process.stdout.write(
  `wrote ${path.relative(ROOT, path.join(OUT, 'highlight.mjs'))} (${Math.round(out.length / 1024)} KB, highlight.js ${version})\n`,
);
