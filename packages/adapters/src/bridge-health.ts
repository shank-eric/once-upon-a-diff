/*
 * The one call anything in this repo's CLI or core makes to the running bridge: the doctor's health check. The CLI never calls
 * the server (ADR-15); it reads and writes the shared files through core, and `orchestration/bridge/doctor.ts` is the one file
 * that imports this one (the depcruise rule `health-check-is-the-doctors`). packages/bridge/test/cli-never-calls-server.test.ts
 * keeps any other file in cli or core from reaching the bridge by fetch, a socket, a signal or a program.
 */

type Health = { status: number; body: { name?: string; version?: string } | null };

/**
 * The bridge's /api/health answer, or null when nothing answered within 2s. This stays an HTTP call on purpose: it is
 * the one check that walks the same road as the browser (127.0.0.1, the port, the token), and a 401 can only come from
 * the running bridge, which holds the token it started with. Everything else on this machine that isn't a browser reads
 * and writes files and stores instead.
 */
export async function fetchHealth(port: number, token: string | undefined): Promise<Health | null> {
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
