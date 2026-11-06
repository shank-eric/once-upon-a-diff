/*
 * Lets a test load code that names the vendored Preact as the pages do, `/assets/preact.mjs` (the bridge serves it from the web package's
 * public/vendor/preact.mjs; Node would read it as a file at the root). Call it before importing that code. `vendorFile` is the path to the
 * vendored file, which the kit does not know: a path, not an import, so the kit still imports no package of this repo.
 */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export function registerPreact(vendorFile: string): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '/assets/preact.mjs') {
        return { url: pathToFileURL(vendorFile).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}
