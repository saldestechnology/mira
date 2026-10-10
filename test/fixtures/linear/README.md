# Linear importer fixtures

`graphql.json` is a small, hand-built fixture in Linear's GraphQL response shape. The tests use it through an injected transport and never contact Linear. `test/linear-import.test.ts` generates larger normalized snapshots from the same fixture concepts to exercise batch boundaries and performance.

Real recordings can replace or extend these responses with `node scripts/linear-import.mjs fetch --record <directory> --out <directory>`. The recorder writes scrubbed request/response JSON files with mode `0600`; it never records the Authorization header or API key. Keep fixtures free of customer data and credentials.
