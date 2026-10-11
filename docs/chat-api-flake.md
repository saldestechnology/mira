# Chat pagination ECONNRESET investigation

## Finding

The exact cause of the Windows CI failures is not proven by the available failed-run logs. The strongest lead is a stale HTTP keep-alive socket caused by synchronous fixture seeding:

1. The pagination test makes a GET, which opens the relay's chat database.
2. The test then performs 130 SQLite inserts synchronously, one autocommit per row, while the relay runs in another process.
3. The next GET uses Node's global `fetch`, which is based on Undici and can reuse an idle connection. Node's HTTP server defaults to a 5-second keep-alive timeout. In Node 24.6 and later, the additional 1-second timeout buffer makes the socket timeout 6 seconds.
4. If the synchronous inserts block the test event loop past the server's timeout, the relay can close the idle socket while the client's connection-expiry timer cannot run. The next fetch can then attempt to use the stale socket and fail with `ECONNRESET`.

The [Node v24.10 fetch documentation](https://nodejs.org/download/release/v24.10.0/docs/api/globals.html#fetch) confirms global fetch uses Undici. The [Node v24.10 HTTP documentation](https://nodejs.org/download/release/v24.10.0/docs/api/http.html#serverkeepalivetimeout) documents the 5-second default and the 1-second buffer added in v24.6.

A separate local diagnostic reproduced `ECONNRESET` with a child HTTP server after a deliberately forced 7.2-second synchronous block. The same diagnostic seeded 130 rows in 12.4 ms locally and the following fetch succeeded. This shows that the stale-socket mechanism is possible, but does not show that Windows CI's real seed takes long enough to trigger it.

The pagination fixture now inserts its rows in one `BEGIN IMMEDIATE` transaction to avoid 130 individual commits and reduce event-loop blocking. If the post-seed request fails, the test reports how long fixture setup took. The harness enriches failures during `fetch()` or response-body reading with a snapshot of the relay PID, exit code, signal, recorded exit details, recent child output, and original error. It does not retry, so a failed API request still fails the test. A null exit code and no recorded exit event are only a snapshot; a child exit can race with the error report.

Do not mark this as an expected product failure based on current evidence. The relay handles request errors by returning an HTTP response, the history limiter rejects with a response rather than resetting the connection, and no relay crash is visible in the CI logs. The precise cause remains a hypothesis until a Windows failure is captured with the new harness diagnostics.

## CI evidence

| Commit | First run | Rerun |
| --- | --- | --- |
| `1e223cc34e46c3aee3204baf50ebae70f0d9f2d0` (Windows, Node 22, shard 2/2) | Run `38090657775`, job `114326256327`: the post-seed history GET failed with `TypeError: fetch failed`, caused by `read ECONNRESET` (`errno: -4077`, `syscall: read`). An earlier GET had succeeded to open the database. | Job `114328467091` passed; the test passed in 2.755 seconds. |
| `96705a3a3b67d08de482f6ddccc34a7e9a296a6c` (Windows, Node 26, shard 2/2) | Run `38098080256`, job `114348101674`: the same post-seed GET and fetch cause failed. | Job `114350482110` passed; the test passed in 635 ms. The full rerun completed successfully. |

Both failed-run logs contain no relay exit or uncaught rejection before the reset. The relay output is buffered by `test/mcp-harness.ts`, and the previous API helper exposed only the raw fetch error, so the logs could not distinguish a relay exit from a reset while the relay remained alive. The test and harness are unchanged between the two failing commits; each failure passed on its CI rerun.

The history limiter allows 120 page requests per minute and returns an HTTP limit response when exceeded. The failing operation received no HTTP response, so the limiter does not explain the observed transport error. Slow startup is also inconsistent with the failure location: the test had already started the relay and completed earlier API calls.

## Local reproduction

On Node 24.10.0 on Darwin, the requested command completed 30 runs with 0 failures. Each run passed all 20 tests; total repeat time was 1m47s. One CPU-bound Node process ran during the repeats. The repeat runner sets `CI=true`, and `vite.config.ts` uses two workers in CI; the runner does not pass a `--maxWorkers` argument through to Vitest.

`--platform win32` sets `TABULA_TEST_PLATFORM=win32`; it does not change `process.platform`. This pagination test and its harness do not read that variable, so the command does not emulate Windows networking or filesystem behavior. Windows CI remains the only actual Windows reproduction.

## Follow-up if Windows CI fails again

Use the enhanced error's process snapshot and output tail to see whether a relay exit had been observed by the time of failure; a missing exit event does not prove the relay stayed alive. Compare the reported seed duration with the idle-socket interval. If the failure persists after transactional seeding, correlate the error snapshot with the child process's later exit state before changing server code.
