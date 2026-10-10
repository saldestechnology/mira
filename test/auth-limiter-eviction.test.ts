import { describe, expect, it, vi } from 'vitest';
import { createAuth } from '../server/auth.mjs';
import { loadConfig } from '../server/config.mjs';

// Exercise the public sign-in API with a movable clock. The directory stub keeps every address unknown,
// so requests exercise the limiter without creating users, tokens or mail.
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CAP = 50_000;

vi.setConfig({ testTimeout: 60_000 });

function setup() {
  const clock = { t: T0 };
  const config = loadConfig({}, () => {});
  const auth = createAuth({
    directory: { getUserByEmail: () => null } as any,
    config,
    mailer: { send: async () => {} },
    now: () => clock.t,
  });
  const login = (email: string, ip: string) => auth.requestLogin({ email, ip });
  return { clock, login };
}

async function fillPairs(login: ReturnType<typeof setup>['login'], start: number, count: number) {
  // Keep the promise batch bounded while still letting each async public API call finish.
  const batchSize = 1_000;
  for (let offset = 0; offset < count; offset += batchSize) {
    const size = Math.min(batchSize, count - offset);
    const results = await Promise.all(Array.from({ length: size }, (_, i) => {
      const n = start + offset + i;
      return login(`filler-${n}@example.com`, `198.51.${Math.floor(n / 256) % 256}.${n % 256}`);
    }));
    expect(results.every((result) => 'ok' in result)).toBe(true);
  }
}

describe('sign-in limiter eviction', () => {
  it('bounds both maps, evicts each oldest key, and keeps refreshed hit counts', async () => {
    const { clock, login } = setup();
    const oldEmail = 'old@example.com';
    const oldIp = '192.0.2.1';
    const warmEmail = 'warm@example.com';
    const warmIp = '192.0.2.2';
    const busyEmail = 'busy@example.com';
    const busyIp = '192.0.2.3';

    // Put the oldest email at its exact threshold, then make the same IP reach its independent threshold
    // through distinct emails. The keys are first in both maps before anything else is inserted.
    for (let i = 0; i < 5; i++) expect(await login(oldEmail, oldIp)).toEqual({ ok: true });
    expect(await login(oldEmail, oldIp)).toEqual({ limited: true });
    const oldIpEmails = Array.from({ length: 15 }, (_, i) => `old-ip-${i}@example.com`);
    for (const email of oldIpEmails) expect(await login(email, oldIp)).toEqual({ ok: true });
    expect(await login('old-ip-threshold@example.com', oldIp)).toEqual({ limited: true });

    // Add one live count for each warm key. Later allowed requests at capacity must refresh both keys.
    expect(await login(warmEmail, warmIp)).toEqual({ ok: true });

    // Five email hits, spread over 40 minutes, and fifteen more people sharing the IP put both busy keys
    // exactly at their limits. The spread lets the final checks prove a refused attempt was not counted.
    for (let i = 0; i < 5; i++) {
      clock.t = T0 + i * 10 * MINUTE;
      expect(await login(busyEmail, busyIp)).toEqual({ ok: true });
    }
    const busyIpEmails = Array.from({ length: 15 }, (_, i) => `busy-ip-${i}@example.com`);
    for (const email of busyIpEmails) expect(await login(email, busyIp)).toEqual({ ok: true });

    // Bring the email and IP maps to the same size: these existing addresses get distinct IPs, so only
    // the IP map grows. Each email remains well below its own limit.
    for (let i = 0; i < oldIpEmails.length; i++) {
      expect(await login(oldIpEmails[i], `203.0.113.${i + 1}`)).toEqual({ ok: true });
      expect(await login(busyIpEmails[i], `203.0.113.${i + 32}`)).toEqual({ ok: true });
    }

    // 33 existing keys in each map plus 49,967 pairs reaches the 50,000-key cap exactly.
    await fillPairs(login, 0, CAP - 33);
    clock.t = T0 + 55 * MINUTE;

    // A refused hit refreshes a busy key without adding a timestamp. An allowed hit refreshes a partially
    // used key. Eighteen new keys force past the cap far enough to evict the old email and IP separately,
    // and would also evict either refreshed key if its map order were not updated.
    expect(await login(busyEmail, busyIp)).toEqual({ limited: true });
    expect(await login(warmEmail, warmIp)).toEqual({ ok: true });
    await fillPairs(login, CAP, 18);

    // Use a fresh counterpart each time so these probes inspect one map at a time.
    expect(await login(oldEmail, '192.0.2.40')).toEqual({ ok: true }); // oldest email was evicted
    expect(await login('fresh-on-old-ip@example.com', oldIp)).toEqual({ ok: true }); // oldest IP was evicted
    expect(await login(busyEmail, '192.0.2.41')).toEqual({ limited: true }); // refusal refreshed email LRU
    expect(await login('fresh-on-busy-ip@example.com', busyIp)).toEqual({ limited: true }); // and IP LRU

    // The allowed refresh kept the warm email's two hits: three more fit, the next does not.
    for (let i = 0; i < 3; i++) expect(await login(warmEmail, `192.0.2.${50 + i}`)).toEqual({ ok: true });
    expect(await login(warmEmail, '192.0.2.60')).toEqual({ limited: true });

    // The warm IP also retained its two hits after an allowed refresh (18 more distinct emails reach 20).
    for (let i = 0; i < 18; i++) expect(await login(`warm-ip-${i}@example.com`, warmIp)).toEqual({ ok: true });
    expect(await login('warm-ip-threshold@example.com', warmIp)).toEqual({ limited: true });

    // At one hour plus a millisecond, only the first busy email/IP hit has expired. Since refusals above
    // did not count, four email hits and nineteen IP hits remain, so this request is allowed exactly once.
    clock.t = T0 + HOUR + 1;
    expect(await login(busyEmail, busyIp)).toEqual({ ok: true });
    expect(await login(busyEmail, busyIp)).toEqual({ limited: true });
  });
});
