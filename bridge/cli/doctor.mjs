/**
 * `diff-story doctor`: is everything connected? The config and token, the
 * bridge, a Claude session listening, and the extension. Each check prints
 * PASS, WARN or FAIL with what it found and, when it isn't passing, the fix.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { listeners } from '../listeners/listeners.mjs';
import { formatTime } from '../config/settings.mjs';

const localTime = (iso) => formatTime(iso);

function listenerPid(port) {
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

/** Runs every check; resolves true when nothing FAILed. */
export async function doctor(
  home,
  cfg,
  { port: portOpt, out = (text) => process.stdout.write(text + '\n') } = {},
) {
  const port = Number(portOpt || cfg.port);
  const results = [];
  const add = (level, name, detail, fix) => results.push({ level, name, detail, fix });

  // config and token
  const cfgFile = path.join(home, 'config.json');
  const mode = existsSync(cfgFile) ? (statSync(cfgFile).mode & 0o777).toString(8) : null;
  if (!cfg.token) {
    add('FAIL', 'Token', 'config.json has no token', 'Run: diff-story setup');
  } else {
    add(
      mode === '600' ? 'PASS' : 'WARN',
      'Config and token',
      `${cfgFile} (mode ${mode}), port ${port}`,
      mode === '600' ? null : `chmod 600 ${cfgFile}`,
    );
  }

  // the bridge: process, port, token
  const proc = listenerPid(port);
  let health = null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(2000),
    });
    health = { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    health = null;
  }
  if (!health) {
    add(
      'FAIL',
      'Bridge',
      proc
        ? `port ${port} is taken by pid ${proc.pid} (${proc.command}), which didn't answer`
        : `nothing is listening on 127.0.0.1:${port}`,
      'Start it: diff-story serve (leave it running, or run it with nohup)',
    );
  } else if (health.status === 401) {
    add(
      'FAIL',
      'Bridge token',
      `the bridge on ${port} rejects this config's token${proc ? ` (pid ${proc.pid})` : ''}`,
      'Restart the bridge so it reads config.json again, and paste the same token into the extension options',
    );
  } else if (health.body && health.body.name === 'diff-story-bridge') {
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
  let seen = null;
  try {
    seen = JSON.parse(readFileSync(seenFile, 'utf8'));
  } catch {
    seen = null;
  }
  if (seen) {
    add('PASS', 'Extension', `last talked to the bridge ${localTime(seen.at)} (${seen.origin})`);
  } else {
    add(
      'WARN',
      'Extension',
      'the bridge has never heard from the extension',
      'chrome://extensions → Load unpacked → src/, then in its options paste the port and token and click Test connection',
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
        .map((listener) => `${listener.consumer} (${listener.state}, ${listener.age_s}s ago)`)
        .join(', '),
    );
  } else {
    add(
      'WARN',
      'Claude listening',
      all.length
        ? `no live listener; last was ${all[0].consumer} ${localTime(all[0].at)}`
        : 'no Claude session has ever listened',
      'In Claude Code, in the repo you want to listen for: /diff-story-listen <owner/name>. Until then, questions wait in the inbox.',
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
