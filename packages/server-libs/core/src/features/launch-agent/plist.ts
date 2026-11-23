/*
 * The bridge's LaunchAgent plist, as text. Pure: the install step (install.ts) works out the paths and the adapter writes the
 * file. It runs `node bin/once-upon.mjs serve` from the main checkout's bridge folder at login. No KeepAlive on purpose: a
 * deploy restarts the bridge with `launchctl kickstart -k` (scripts/lib/respawn-bridge.sh), which starts it whether or not it
 * runs, and launchd's own restart would fight a bridge stopped by hand and crash-loop against one started by hand.
 */

export interface LaunchAgentInput {
  label: string;
  /** the Node 24 binary, as a stable path (never an fnm multishell link) */
  node: string;
  /** `<main checkout>/packages/server/bridge`: the job's working directory and where `bin/once-upon.mjs` is */
  bridgeDir: string;
  /** where launchd appends the bridge's stdout and stderr: the bridge's own rotated log */
  logFile: string;
  /** the job's PATH */
  path: string;
  /** set only when the install ran with ONCE_UPON_HOME, so the job reads the same home */
  onceUponHome?: string;
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const str = (text: string): string => `<string>${escapeXml(text)}</string>`;

/**
 * The job's PATH: Node's folder first, then the install shell's entries without fnm's per-shell links (which vanish with the
 * shell), then the places `gh`, `git` and `claude` live. launchd's own default is only /usr/bin:/bin:/usr/sbin:/sbin.
 */
export function launchPath({
  nodeDir,
  installPath,
  home,
}: {
  nodeDir: string;
  installPath: string;
  home: string;
}): string {
  const fromShell = installPath.split(':').filter((dir) => dir && !dir.includes('fnm_multishells'));
  const standard = [
    `${home}/.local/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [...new Set([nodeDir, ...fromShell, ...standard])].join(':');
}

export function launchAgentPlist(input: LaunchAgentInput): string {
  const environment = [
    `    <key>PATH</key>\n    ${str(input.path)}`,
    ...(input.onceUponHome
      ? [`    <key>ONCE_UPON_HOME</key>\n    ${str(input.onceUponHome)}`]
      : []),
  ].join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(input.label)}
  <key>ProgramArguments</key>
  <array>
    ${str(input.node)}
    ${str(`${input.bridgeDir}/bin/once-upon.mjs`)}
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  ${str(input.bridgeDir)}
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  ${str(input.logFile)}
  <key>StandardErrorPath</key>
  ${str(input.logFile)}
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
</dict>
</plist>
`;
}
