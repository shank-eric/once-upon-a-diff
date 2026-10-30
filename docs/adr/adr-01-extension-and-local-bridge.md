# ADR-01: An extension plus a local bridge, with everything on this machine

Descriptive draft, 10/27, of the code on `stack/5-board-checks` (8710395).

## Context

A story has to show on GitHub's own PR page, next to the diff. The work behind it, writing stories, answering questions and fixing notes, happens in Claude Code sessions on the reviewer's Mac. GitHub's page CSP stops a content script from calling anything but GitHub, and nothing in the product has an account, a server or a database.

## Decision

- **An unpacked MV3 Chrome extension** (WXT, `packages/extension`). It has a fixed ID (`faaibhigocihefldbmdgchcnnclalkmo`, from a manifest key kept outside git), so its `chrome.storage` survives rebuilds. Content scripts on github.com draw the panel and the PR tags. The background service worker is the only code that makes network calls, and only to `http://127.0.0.1:<port>` with the token from the options page (`entrypoints/background.ts`).
- **A local bridge** (`packages/bridge`, `once-upon serve`) bound to `127.0.0.1:4823`. It's plain Node 24 running its TypeScript directly, with no build and one runtime dependency, Valibot, which checks request bodies (ADR-15). highlight.js and Preact are vendored. It serves story data to the extension and its own pages (the local diff page, the agent board), and keeps everything in `~/.once-upon` and in each checkout's `.once-upon/`.
- **Guards on every request** (`server/index.ts`): the Host must be loopback or an exact `allowed_hosts` name, the Origin must be the extension or the bridge's own pages, writes must be JSON, bodies are capped at 256 KB, there are no CORS headers, the pages get a strict CSP, and the bearer token or a page key is required.
- **Nobody supervises the bridge.** The user starts it (`yarn bridge`), or the listen skill spawns it detached when `doctor` finds nothing on the port. There's no launch agent, so after a reboot the next skill run or the user starts it again. `bridge.json` lets the CLI tell its own bridge from something else on the port without calling it.
- **An optional reverse proxy** (puma-dev) gives the board and inbox an https name (`once-upon.test`) so they can use cookies. The defaults also name `once-upon.fidev.net`.

## Consequences

- Nothing leaves the machine except what Claude Code and `gh` send anyway. Data and privacy are simple to explain.
- No second machine or phone can reach it. The board's phone layout only helps on this Mac's browser, or wherever the proxy name resolves to it.
- The bridge has to be running for anything on a page to work. The status light, `doctor` and the not-connected pages exist to say when it isn't. Questions asked in the CLI's absence still queue, because the inbox is a file (ADR-05).
- Three things move separately: the built extension, the running bridge, and the checkout each skill is linked from. The skill helper (`skills/once-upon/bin/story.ts`) imports bridge modules from its own checkout, so a skill linked to one checkout can publish with code that differs from the running bridge's. The status light catches only a bridge "too old for the panel".
- One bridge per port per machine. Tests run their own on random ports with a temporary home.
- The default `allowed_hosts` includes a name from one particular puma-dev setup (`once-upon.fidev.net`), so that setup detail ships to every user.

## Open questions

1. Should the bridge get a launch agent, or keep relying on the skill to start it?
2. Should the extension, bridge and skill check one shared version, beyond "too old for the panel"?
3. Should `once-upon.fidev.net` stay in the defaults before a Web Store release?
4. Is phone access (the board's mobile layout) a goal, and if so, through what? The bridge is loopback-only by design.
