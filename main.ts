// Entrypoint: the entry <-> env lifecycle. This file only wires the forge
// (app.ts) into the trial env: it binds an ephemeral port, tells the env
// where to reach it, then waits until the env says the trial is over.
//
// The order of operations is fixed by the env's contract:
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to register with, so the process exits 1 right away.
//   2. Build the server (createApp from app.ts) and listen on port 0, so
//      the kernel picks a free port. Port 8080 belongs to the env itself
//      and must never be bound here.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      request's source address plus N as this entry's base URL. The first
//      registration wins: a 409 means another entry registered first, and
//      this process simply carries on waiting like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The env answers immediately ({"done": false} while the suite runs),
//      so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits
//      before the env says it is done.
//   5. Close the server and exit 0. The env then stops and writes the
//      export the scorer reads.
//
// Nothing else lives here: no package, no Node built-in beyond fetch and
// timers, no model call. The server itself is app.ts.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
if (envOrigin === "") {
  process.stderr.write("[forge] MAKEFUN_ENV_URL is not set, so there is no env to register with\n");
  process.exit(1);
}

// One register or done request may take this long before it is abandoned.
const REQUEST_BUDGET_MS = 30_000;
// Retries start this far apart and never wait longer than the cap.
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff after `failures` failed attempts: exponential from the first wait, capped. */
function backoffMs(failures: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

/**
 * Announce the bound port until the env accepts it. A 200 is the normal
 * answer; a 409 means a first registration already won, which is not this
 * process's problem. A 400 or 405 is a contract error and ends the program;
 * a network error or any other status is retried, because the env may still
 * be starting up.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let fatal: Error | null = null;
    try {
      const response = await fetch(`${envOrigin}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        fatal = new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register answered HTTP ")) {
        fatal = err;
      }
    }
    if (fatal !== null) throw fatal;
    await pause(backoffMs(failures));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function awaitCompletion(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(backoffMs(failures));
  }
}

/** Bind the port, announce it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("the server did not bind an ephemeral TCP port");
  }
  process.stdout.write(`[forge] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write("[forge] registered; waiting for the env to say done\n");

  await awaitCompletion();
  server.close();
  process.stdout.write("[forge] done\n");
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
