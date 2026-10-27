/*
 * <home>/bridge.json: which process is the bridge, and on which port. The bridge writes it when it starts listening and
 * removes it when it closes. `once-upon local` reads it to tell its own bridge from something else on the port without
 * calling it over HTTP (a call would need a token, and a stale one is the case to catch).
 */
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.ts';

export interface BridgeFile {
  pid: number;
  port: number;
  /** a short fingerprint of the token the bridge started with, never the token */
  token: string;
}

const bridgeFile = (home: string) => path.join(home, 'bridge.json');
export const tokenFingerprint = (token: string) =>
  createHash('sha256').update(`once-upon-bridge:${token}`).digest('hex').slice(0, 16);

/** Records this process as the bridge on `port`. */
export function writeBridgeFile(home: string, port: number, token: string): void {
  try {
    writeJsonAtomic(bridgeFile(home), { pid: process.pid, port, token: tokenFingerprint(token) });
  } catch {
    /* a home that can't be written: the bridge still works, it just can't be recognised */
  }
}

/** Removes the file, when it is this process's. */
export function removeBridgeFile(home: string): void {
  if (readBridgeFile(home)?.pid === process.pid) {
    rmSync(bridgeFile(home), { force: true });
  }
}

export function readBridgeFile(home: string): BridgeFile | null {
  try {
    const value = JSON.parse(readFileSync(bridgeFile(home), 'utf8'));
    return Number.isInteger(value.pid) &&
      Number.isInteger(value.port) &&
      typeof value.token === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
