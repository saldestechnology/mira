section: Changed
audience: dev

- Test fetches no longer reuse idle sockets and retry one reset GET with a visible log line, ending the Windows ECONNRESET flakes in the real-HTTP tests (test/http-retry.ts).
