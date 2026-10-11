# Testing

How tests are run is in the README ("Tests and checks"): `npm test`, `npm run test:repeat`, the Windows shards and the timing budget. This page is about writing tests that do not fail on a slow, noisy machine. The Windows CI shards run two to five times slower than a laptop and share their CPU, so a test that is right on a quiet machine can fail there for no reason of its own.

## How we write timing-safe tests

A test should prove a **behaviour**, not a **speed**. If a test would still be correct on a machine ten times slower, it is timing-safe. Everything below follows from that.

### Never do these

- `await sleep(N)` and then `expect(...)` that something already happened. The margin is a guess.
- `expect(elapsed).toBeLessThan(N)`, a ratio of two timings, a median under 1 ms, an "operations per second" threshold, or a latency verdict such as `OK`. Examples that failed on CI: a remote load test asserting the verdict `OK` (turned `DEGRADED` by a busy runner, run 38007561347), a copy test comparing a tick gap to the copy time, a save test asserting a write between 20 s and 33 s.
- A negative assertion ("nothing happened") after a short sleep. It passes when the thing is merely late, so it proves nothing.
- Hard-coded ports (use `test/free-port.ts`), or a path built from `new URL(import.meta.url).pathname` (see "Windows" below).

### Do these instead

1. **Wait for the event, with a generous timeout.** Poll with `until(() => condition, 20_000)` (`test/mcp-harness.ts`). A long timeout costs nothing when the condition is met at once, and a real hang still fails. Wait for the thing the test needs (the saved file, the logged line, the recorded request), not for time to pass.
2. **Prove a negative with a barrier.** Updates over one connection are processed in order. After the request that must change nothing, make an allowed write over the same connection, wait until a *separate observer* sees it, and only then assert the forbidden effect is absent: everything earlier has arrived by then. See `writeBarrier` in `test/mcp-accounts.test.ts`. A barrier must be a write the room accepts (in a comments room a thread, not a `meta` key). Prove the barrier itself: inject a stray effect before it and check the test fails.
3. **Inject the clock, or use the fake timers the code already offers.** The backup engine has a timer rig (`rig()` in `test/backup-settle.test.ts`: `timers.fireDelay(300)`), sessions can be aged by moving the stored row instead of sleeping, and rate limits take a clock. If the code under test has no clock, add one rather than sleeping.
4. **Assert only lower bounds on real time.** "The socket must not close before its session ends" is a property; "it closes within 3.5 s" is a guess. A generous watchdog (60 s) is fine for "it must not hang".
5. **Count work instead of timing it.** Assert the number of recomputations, cache hits, items visited or queries made (`test/container-store.test.ts`, `test/guides.test.ts`, the icon search test). A deterministic cost cannot flake and catches the same regressions.
6. **A test-only hook may only tighten.** When a test must shorten a real delay (a 30 s maximum save wait, a rate window), add a startup-validated environment variable that can only move the setting in the *safe* direction: `TABULA_TEST_SAVE_MAX_WAIT_MS` can only shorten the wait, and is a pure, unit-tested function (`saveMaxWaitMs` in `server/save-delay.mjs`); `TABULA_TEST_CHAT_BURST_WINDOW_MS` can only lengthen the burst window (stricter) and throws unless `NODE_ENV=test`. A stray value in production must never loosen a limit or delay a save. Name the hook in the commit and the changelog fragment.

### Windows

- Build paths from `fileURLToPath(import.meta.url)` (and `path.join`), never from `new URL(...).pathname`: on Windows that gives `/D:/a/...`, which broke the AI bar availability test.
- Signals do not exist on Windows: `kill('SIGKILL')` ends the process with exit code 1 and a null signal. Assert that a process ended (and its output), not which signal ended it; accept `SIGKILL` on POSIX and a number on Windows if the reason matters.
- File modes do not exist on Windows (everything reports `0o666`): assert them only where `!isWindows` (`test/platform.ts`).
- Child processes, file locks and renames are slower and stricter on Windows. Poll, do not sleep, and close handles before removing a directory.
- Run `npm run test:repeat -- <files> --times 15 --platform win32` before you report. It runs the Windows branches of your test 15 times in a row; it does not simulate Windows itself, so CI (and the nightly run on Windows) remains the proof.

## Real HTTP requests in tests

Every test file runs with `test/setup-http.ts`, which wraps the global `fetch` (`test/http-retry.ts`): requests send `connection: close`, so a test that blocked its event loop past the server's keep-alive timeout cannot reuse a socket the server already closed (the Windows `fetch failed` / `ECONNRESET` flakes of 2026-10-10 and 11), and one GET or HEAD that still fails with a reset socket is tried once more, printing a `[http-retry]` line so the retry is visible in the output. Other methods, other errors and a second failure are not touched. A test that stubs `fetch` replaces the wrapper and is unaffected.

## Starting a relay

Always start a relay child through `startRelayProcess` (`test/start-relay.ts`), never with a hand-written spawn that waits for a line: it reports an early exit with the relay's output and retries a taken port on a fresh one. The per-file starters hid a relay that died before printing `Tabula relay`, consuming the full 30-second limit without useful output in run 38044216287; wait for what the test needs with `until`.

### Proving the fix

A timing fix is done when it passes **and** still fails when the behaviour it guards is broken. For each test you change, apply one mutation to the production code (make the save never fire, never unload the room, let the refused write through, compute the layout on every read) and check that the new test fails; then revert it. A mutation that makes the test *hang* until the process is killed also counts: it cannot pass. Say in your report which mutations you ran and what you could not run. Also run the file a few times at once on a busy machine: if it is going to flake, it shows there first.
