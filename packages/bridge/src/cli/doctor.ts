/**
 * `once-upon doctor`: is everything connected? The Node it runs on, the config and token, the
 * bridge, a Claude session listening, and the extension. Each check prints
 * PASS, WARN or FAIL with what it found and, when it isn't passing, the fix.
 */
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listeners } from '../listeners/listeners.ts';
import { formatTime } from '../config/settings.ts';
import { readJson } from '../util/json-file.ts';
import { MIN_NODE_MAJOR, nodeVersionProblem } from '../../bin/node-version.mjs';
import type { Config } from '../config/settings.ts';

type Level = 'PASS' | 'WARN' | 'FAIL';

const localTime = (iso: string) => formatTime(iso);

function listenerPid(port: number): { pid: string; command: string } | null {
  try {
    const pid = execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')[0];
    if (!pid) {
      return null;
    }
    const command = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim();
    return { pid, command };
  } catch {
    return null;
  }
}

type Health = { status: number; body: { name?: string; version?: string } | null };

/** The bridge's /api/health answer, or null when nothing answered within 2s. */
async function fetchHealth(port: number, token: string | undefined): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json().catch(() => null)) as Health['body'];
    return { status: response.status, body };
  } catch {
    return null;
  }
}

/**
 * Runs every check; resolves true when nothing FAILed. opts.port overrides the config's.
 */
export async function doctor(
  home: string,
  cfg: Pick<Config, 'port' | 'token'>,
  {
    port: portOpt,
    wait = 0,
    out = (text) => process.stdout.write(text + '\n'),
    nodeVersion = process.versions.node,
  }: {
    port?: number | string;
    wait?: number;
    out?: (text: string) => unknown;
    /** the Node to judge, for tests; the one running doctor by default */
    nodeVersion?: string;
  } = {},
): Promise<boolean> {
  const port = Number(portOpt || cfg.port);
  const results: { level: Level; name: string; detail: string; fix?: string | null }[] = [];
  const add = (level: Level, name: string, detail: string, fix?: string | null) =>
    results.push({ level, name, detail, fix });

  // Node: the CLI's entry stops an older one, but not a .ts file run directly with a type-stripping flag
  const nodeProblem = nodeVersionProblem(nodeVersion);
  add(
    nodeProblem ? 'FAIL' : 'PASS',
    'Node',
    `v${nodeVersion} at ${process.execPath}${nodeProblem ? `, needs ${MIN_NODE_MAJOR} or newer` : ''}`,
    nodeProblem
      ? `Run fnm use or nvm use in the once-upon-a-diff repo (.nvmrc says ${MIN_NODE_MAJOR}), or fnm exec --using=${MIN_NODE_MAJOR} once-upon doctor`
      : null,
  );

  // config and token
  const cfgFile = path.join(home, 'config.json');
  const mode = existsSync(cfgFile) ? (statSync(cfgFile).mode & 0o777).toString(8) : null;
  if (!cfg.token) {
    add('FAIL', 'Token', 'config.json has no token', 'Run: once-upon setup');
  } else {
    add(
      mode === '600' ? 'PASS' : 'WARN',
      'Config and token',
      `${cfgFile} (mode ${mode}), port ${port}`,
      mode === '600' ? null : `chmod 600 ${cfgFile}`,
    );
  }

  // the bridge: process, port, token
  let health = await fetchHealth(port, cfg.token);
  // --wait N: a bridge that was just started may not be listening yet
  const deadline = Date.now() + wait * 1000;
  while (!health && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    health = await fetchHealth(port, cfg.token);
  }
  const proc = listenerPid(port);
  if (!health) {
    add(
      'FAIL',
      'Bridge',
      proc
        ? `port ${port} is taken by pid ${proc.pid} (${proc.command}), which didn't answer`
        : `nothing is listening on 127.0.0.1:${port}`,
      'Start it: once-upon serve (leave it running, or run it with nohup)',
    );
  } else if (health.status === 401) {
    add(
      'FAIL',
      'Bridge token',
      `the bridge on ${port} rejects this config's token${proc ? ` (pid ${proc.pid})` : ''}`,
      'Restart the bridge so it reads config.json again, and paste the same token into the extension options',
    );
  } else if (health.body && health.body.name === 'once-upon-bridge') {
    add(
      'PASS',
      'Bridge',
      `running on 127.0.0.1:${port}, version ${health.body.version}${proc ? `, pid ${proc.pid}` : ''}`,
    );
  } else {
    add(
      'FAIL',
      'Bridge',
      `something else answers on port ${port} (HTTP ${health.status})`,
      'Pick another port: set "port" in config.json, restart the bridge, and change it in the extension options',
    );
  }

  // the extension: the bridge records when it last heard from it
  const seenFile = path.join(home, 'extension-seen.json');
  const seen = readJson<{ at: string; origin: string }>(seenFile);
  if (seen) {
    add('PASS', 'Extension', `last talked to the bridge ${localTime(seen.at)} (${seen.origin})`);
  } else {
    add(
      'WARN',
      'Extension',
      'the bridge has never heard from the extension',
      'yarn build, then chrome://extensions → Load unpacked → packages/extension/.output/chrome-mv3, then in its options paste the port and token and click Test connection',
    );
  }

  // a Claude session listening for questions
  const all = listeners(home);
  const live = all.filter((listener) => listener.live);
  if (live.length) {
    add(
      'PASS',
      'Claude listening',
      live
        .map((listener) => {
          const covers = listener.story || listener.repo || 'everything';
          return `${listener.consumer} (${covers}, ${listener.state}, ${listener.age_s}s ago)`;
        })
        .join(', '),
    );
  } else {
    add(
      'WARN',
      'Claude listening',
      all.length
        ? `no live listener; last was ${all[0].consumer} ${localTime(all[0].at)}`
        : 'no Claude session has ever listened',
      'In Claude Code, in the repo you want to listen for: /once-upon-listen <owner/name>. Until then, questions wait in the inbox.',
    );
  }
  for (const result of results) {
    out(`${result.level.padEnd(4)}  ${result.name}: ${result.detail}`);
    if (result.fix) {
      out(`      fix: ${result.fix}`);
    }
  }
  const fails = results.filter((result) => result.level === 'FAIL').length;
  const warns = results.filter((result) => result.level === 'WARN').length;
  out(
    `\n${fails ? `${fails} failing` : 'Nothing failing'}${warns ? `, ${warns} to look at` : ''}.`,
  );
  return fails === 0;
}
