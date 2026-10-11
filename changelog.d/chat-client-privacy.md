section: Fixed

- Chat: scope offline messages and drafts to the confirmed account, purge other accounts' saved rows, and reset open tabs when identity changes. Protect in-flight reads, deletes, overlapping loads and paginated reconnects from restoring private or purged messages.
- Chat: discard stale edit, delete and reaction responses; clear denied history, cache rows, unread counts and drafts; reconcile offline cache restores and serialize per-channel history fetches.
- Chat: isolate listener and reset failures so auth changes complete, and await the async identity setter in the guest-expiry and live-camera tests.
