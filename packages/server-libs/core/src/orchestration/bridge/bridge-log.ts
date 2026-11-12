import {
  copyFile,
  fileSize,
  appendText,
  truncateFile,
  restrictFile,
} from '@once-upon-a-diff/adapters/stores/fs/files';

/** How big bridge.log may grow before its lines move to bridge.log.1: with that backup the log is at most twice this. */
export const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Appends to the bridge's log, keeping it under `maxBytes`: a write that would pass the cap first copies the file to
 * `<file>.1` (replacing the old copy) and empties it in place. Copy and truncate, never rename: deploy-local.sh starts the
 * bridge with its stderr on this file, and that descriptor follows the inode, so a rename would leave it filling the backup.
 * The size is read on each write (a line is rare, and the stderr copy of every line also lands in the file).
 */
export function makeBridgeLog(
  file: string,
  maxBytes = BRIDGE_LOG_MAX_BYTES,
): (text: string) => void {
  return (text) => {
    try {
      if (fileSize(file) + text.length > maxBytes) {
        copyFile(file, `${file}.1`);
        restrictFile(`${file}.1`, 0o600);
        truncateFile(file);
      }
      appendText(file, text, 0o600);
    } catch {
      /* the log is a convenience */
    }
  };
}
