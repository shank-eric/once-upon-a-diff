import { existsSync } from 'node:fs';
import path from 'node:path';
import { readSettings, type Config } from '../config/settings.ts';
import { writeFileAtomic, readJson } from '../../adapters/stores/fs/json-file.ts';
import type { StoryStore } from '../stories/store.ts';
import type { Inbox } from '../inbox/inbox.ts';
import {
  readBridgeFile,
  removeBridgeFile,
  tokenFingerprint,
  writeBridgeFile,
} from '../../adapters/stores/bridge-file.ts';
import { pidAlive, portTaken } from '../../adapters/os.ts';
import { restrictFile, appendText } from '../../adapters/stores/fs/files.ts';

/*
 * The bridge as a process: which one is running on a port, its log file, what it records about the extension, and starting
 * it. The HTTP app (server/index.ts) is what runs; the CLI's `serve` starts it through `startBridge`, which the entry point
 * (bin/once-upon.ts) hands the app's `createBridge`, so the CLI never imports the app.
 */

/** What is on a port: this home's bridge, one started with another token, something else, or nothing. */
export type PortState = 'ours' | 'old-token' | 'foreign' | 'free';

/**
 * Is this home's bridge on the port? Answered without calling it. A port something listens on is taken, and it's ours
 * when bridge.json (which the bridge writes when it starts listening) names a live process and this port. A bridge
 * started before the token was rotated is told apart by the token's fingerprint in that file. Anything else on the port
 * is "foreign": another program, another home's bridge, or a bridge whose file is gone.
 */
export async function portState(
  home: string,
  port: number | string,
  token?: string,
): Promise<PortState> {
  const number = Number(port);
  if (!(await portTaken(number))) {
    return 'free';
  }
  const file = readBridgeFile(home);
  if (!file || file.port !== number || !pidAlive(file.pid)) {
    return 'foreign';
  }
  return token && file.token !== tokenFingerprint(token) ? 'old-token' : 'ours';
}

/** The running HTTP app, as far as the CLI needs it: an http.Server, with the stores it serves from. */
export interface RunningBridge {
  once(event: 'error', listener: (err: Error) => void): unknown;
  listen(port: number, host: string, listening: () => void): unknown;
  stories: StoryStore;
  inbox: Inbox;
}

/** What the HTTP app is started with. */
export interface BridgeStart {
  home: string;
  token: string;
  log: (line: string) => void;
  extensionIds?: string[];
}

let factory: ((start: BridgeStart) => RunningBridge) | null = null;

/** The entry point gives the CLI the HTTP app's `createBridge` here. */
export function setBridgeFactory(create: (start: BridgeStart) => RunningBridge): void {
  factory = create;
}

/** Starts the bridge on 127.0.0.1 and resolves once it listens. */
export function serve(
  home: string,
  cfg: Config,
  opts: { port?: unknown; [flag: string]: unknown },
): Promise<RunningBridge> {
  if (!factory) {
    throw new Error('the bridge app is not set up: bin/once-upon.ts hands it to setBridgeFactory');
  }
  const port = Number(opts.port || cfg.port);
  // the bridge keeps its own log in <home>/bridge.log, for `once-upon doctor`
  const logFile = path.join(home, 'bridge.log');
  if (existsSync(logFile)) {
    restrictFile(logFile, 0o600); // an older bridge may have made it readable by others
  }
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    process.stderr.write(`once-upon bridge: ${line}\n`);
    try {
      appendText(logFile, text, 0o600);
    } catch {
      /* the log is a convenience */
    }
  };
  const server = factory({
    home,
    token: cfg.token,
    log,
    extensionIds: readSettings(home).extensionIds,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(
        `listening on http://127.0.0.1:${port}, pid ${process.pid} (stories: ${server.stories.list().length}, inbox: ${server.inbox.file})`,
      );
      resolve(server);
    });
  });
}

/** The bridge announces itself in bridge.json once it listens (a CLI told apart from a foreign program by it). */
export const announceBridge = (home: string, port: number, token: string): void =>
  writeBridgeFile(home, port, token);

/** Removes bridge.json when it is this process's. */
export const retireBridge = (home: string): void => removeBridgeFile(home);

/** The last time the extension talked to the bridge, for `once-upon doctor` and the status light. */
export interface ExtensionSeen {
  at: string;
  origin: string;
}

const seenFile = (home: string) => path.join(home, 'extension-seen.json');

export const readExtensionSeen = (home: string): ExtensionSeen | null =>
  readJson<ExtensionSeen>(seenFile(home));

export const writeExtensionSeen = (home: string, seen: ExtensionSeen): void =>
  writeFileAtomic(seenFile(home), JSON.stringify(seen));
