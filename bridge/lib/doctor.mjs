/**
 * `diff-story doctor`: is everything connected? Each check prints PASS, WARN
 * or FAIL with what it found and, when it isn't passing, the fix.
 */
import { existsSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { StoryStore } from './stories.mjs';
import { listeners, onPath } from './health.mjs';
import { Builds } from '../inbox/builds.mjs';
import { Inbox } from '../inbox/inbox.mjs';
import { formatTime } from '../config/settings.mjs';

const et = (iso) => formatTime(iso);

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
  { port: portOpt, out = (s) => process.stdout.write(s + '\n') } = {},
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
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(2000),
    });
    health = { status: r.status, body: await r.json().catch(() => null) };
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
    add('PASS', 'Extension', `last talked to the bridge ${et(seen.at)} (${seen.origin})`);
  } else {
    add(
      'WARN',
      'Extension',
      'the bridge has never heard from the extension',
      'chrome://extensions → Load unpacked → src/, then in its options paste the port and token and click Test connection',
    );
  }

  // the story root and the stories
  try {
    accessSync(home, constants.W_OK);
    const store = new StoryStore({ home, roots: cfg.roots, scratch: true });
    const list = store.list();
    add(
      list.length ? 'PASS' : 'WARN',
      'Stories',
      list.length
        ? `${list.length}: ${list
            .slice(0, 6)
            .map((s) => s.id)
            .join(', ')}${list.length > 6 ? ', …' : ''}`
        : `none under ${home} or pr-story's scratch folders`,
      list.length
        ? null
        : 'Make one with the pr-story skill (its render step publishes it), or: diff-story local --repo DIR --base REF',
    );
  } catch (e) {
    add(
      'FAIL',
      'Story root',
      `${home} isn't writable: ${e.message}`,
      `Check the folder's permissions, or set DIFF_STORY_HOME`,
    );
  }

  // a Claude session listening for questions
  const ls = listeners(home);
  const live = ls.filter((l) => l.live);
  if (live.length) {
    add(
      'PASS',
      'Claude listening',
      live.map((l) => `${l.consumer} (${l.state}, ${l.age_s}s ago)`).join(', '),
    );
  } else {
    add(
      'WARN',
      'Claude listening',
      ls.length
        ? `no live listener; last was ${ls[0].consumer} ${et(ls[0].at)}`
        : 'no Claude session has ever listened',
      'In a Claude Code session, run as a background task: diff-story wait --consumer pr-story. Until then, questions wait in the inbox.',
    );
  }
  const pending = new Builds(home, new Inbox(home)).pending();
  if (pending.length) {
    add(
      'WARN',
      'Build requests',
      `${pending.length} pending: ${pending.map((b) => `${b.repo}#${b.number}`).join(', ')}`,
      'A listening Claude session picks them up; or list them with: diff-story builds',
    );
  }

  // autoBuild and autoAnswer
  for (const key of ['autoBuild', 'autoAnswer']) {
    const c = cfg[key];
    if (!c || !c.enabled) {
      add('PASS', key, 'off');
      continue;
    }
    const good = Array.isArray(c.command) && c.command.length && onPath(c.command[0]);
    add(
      good ? 'PASS' : 'FAIL',
      key,
      `on: ${JSON.stringify(c.command)}`,
      good ? null : `"${key}.command" must be an argv array whose first item is on PATH`,
    );
  }

  // the bridge log
  const logFile = path.join(home, 'bridge.log');
  const tail = existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n').slice(-8)
    : [];
  const errors = tail.filter((l) =>
    /error|Error|EADDRINUSE|autoAnswer for|autoBuild could/.test(l),
  );
  add(
    errors.length ? 'WARN' : 'PASS',
    'Bridge log',
    tail.length
      ? `${logFile}, last ${tail.length} lines${errors.length ? `, ${errors.length} look like errors` : ''}`
      : 'no log yet (the bridge writes one when started with diff-story serve)',
    errors.length ? 'See the lines below' : null,
  );

  for (const r of results) {
    out(`${r.level.padEnd(4)}  ${r.name}: ${r.detail}`);
    if (r.fix) {
      out(`      fix: ${r.fix}`);
    }
  }
  if (tail.length) {
    out('\nbridge.log (last lines):');
    for (const l of tail) {
      out(`  ${l}`);
    }
  }
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'WARN').length;
  out(
    `\n${fails ? `${fails} failing` : 'Nothing failing'}${warns ? `, ${warns} to look at` : ''}.`,
  );
  return fails === 0;
}
