# Windows test notes

- Compare filesystem paths only after normalizing separators. Keep URL paths, manifest paths, and import specifiers in their own formats.
- Guard POSIX permission-bit assertions with the platform check used by `test/auth.test.ts`. For directory symlinks on Windows, use a junction.
- Normalize line endings when a test parser depends on `\n`. The current `.gitattributes` keeps repository text files at LF.
- Replace short sleeps with an event, protocol round trip, observable condition, or injected clock. Keep real-time waits only when elapsed time is the behavior under test, and give them a generous watchdog.
- Use `h.config()` or an explicit 60-second snapshot hold for backup test fixtures. Keep short holds only in focused tests that exercise timeout behavior.
- `npm run test:repeat -- <files> --times 15 --platform win32` forces Windows-specific test branches; it does not run on a Windows filesystem or host.
