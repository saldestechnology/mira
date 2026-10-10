import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type BoardRole, type Me, type Workspace } from '../src/api';
import { authState, setSignedIn, setSignedOut, startMeRefresh } from '../src/auth';
import {
  HINT_COALESCE_MS,
  ME_REFRESH_MS,
  READ_ONLY_BADGE,
  bannerText,
  boardAccess,
  DELETED_BADGE,
  FREE_WORKSPACE_TEXT,
  canManageBilling,
  freeWorkspaceNote,
  cloudErrorMessage,
  createMeRefresher,
  createUnlockWatcher,
  meChanged,
  portalTarget,
  trialStatusText,
  workspaceOf,
  type MeRefreshDeps,
} from '../src/cloud-logic';

// docs/cloud.md, client side.

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 1, ...patch });
const meWith = (role: Me['user']['role'], ws?: Workspace): Me => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', role },
  teams: [],
  ...(ws ? { workspace: ws } : {}),
});

afterEach(() => {
  setSignedOut();
  vi.restoreAllMocks();
});

describe('workspaceOf', () => {
  it('reads the workspace of a signed-in or offline user and nothing else', () => {
    const ws = workspace({ banner: 'Hi' });
    expect(workspaceOf({ mode: 'signed-in', me: meWith('owner', ws) })).toEqual(ws);
    expect(workspaceOf({ mode: 'offline', me: meWith('owner', ws) })).toEqual(ws);
    expect(workspaceOf({ mode: 'offline', me: null })).toBeNull();
    expect(workspaceOf({ mode: 'signed-in', me: meWith('owner') })).toBeNull();
    expect(workspaceOf({ mode: 'open' })).toBeNull();
    expect(workspaceOf({ mode: 'signed-out' })).toBeNull();
    expect(workspaceOf({ mode: 'unknown' })).toBeNull();
  });
});

describe('bannerText', () => {
  it.each<[string, Workspace | null | undefined, string | null]>([
    ['no workspace', null, null],
    ['an undefined workspace', undefined, null],
    ['nothing to say', workspace(), null],
    ['the operator banner', workspace({ banner: 'Payment failed' }), 'Payment failed'],
    ['a banner with padding', workspace({ banner: '  Trial ends soon ' }), 'Trial ends soon'],
    ['a blank banner', workspace({ banner: '   ' }), null],
    ['the banner over the read-only notice', workspace({ banner: 'Pay now', readOnly: true }), 'Pay now'],
    ['a plain notice for read-only without a banner', workspace({ readOnly: true }), 'This workspace is read-only.'],
  ])('%s', (_name, ws, text) => {
    expect(bannerText(ws)).toBe(text);
  });
});

describe('boardAccess', () => {
  it.each<[BoardRole | null | undefined, boolean, boolean, boolean, string | null]>([
    ['owner', false, false, false, null],
    ['editor', false, false, false, null],
    ['commenter', false, true, false, 'Can comment'],
    ['viewer', false, true, true, 'View only'],
    [null, false, false, false, null],
    [undefined, false, false, false, null],
    ['owner', true, true, true, READ_ONLY_BADGE],
    ['editor', true, true, true, READ_ONLY_BADGE],
    ['commenter', true, true, true, READ_ONLY_BADGE],
    ['viewer', true, true, true, READ_ONLY_BADGE],
    [null, true, true, true, READ_ONLY_BADGE],
  ])('role %s with read-only %s', (role, locked, store, comments, badge) => {
    expect(boardAccess(role, workspace({ readOnly: locked }))).toEqual({ storeReadOnly: store, commentsReadOnly: comments, badge });
  });

  it('is the plain role rule without a workspace', () => {
    expect(boardAccess('owner', null)).toEqual({ storeReadOnly: false, commentsReadOnly: false, badge: null });
    expect(boardAccess('owner', null, true)).toEqual({ storeReadOnly: true, commentsReadOnly: true, badge: DELETED_BADGE });
    expect(boardAccess(undefined, workspace({ readOnly: true }), true).badge).toBe(DELETED_BADGE);
    expect(boardAccess('viewer', undefined)).toEqual({ storeReadOnly: true, commentsReadOnly: true, badge: 'View only' });
    expect(boardAccess('commenter', null)).toEqual({ storeReadOnly: true, commentsReadOnly: false, badge: 'Can comment' });
  });

  it('opens a board that needs features this client lacks read-only, and still allows comments', () => {
    expect(boardAccess('owner', null, false, true)).toEqual({ storeReadOnly: true, commentsReadOnly: false, badge: null });
    expect(boardAccess(null, null, false, true).storeReadOnly).toBe(true);
    expect(boardAccess('viewer', null, false, true)).toEqual({ storeReadOnly: true, commentsReadOnly: true, badge: 'View only' });
    expect(boardAccess('owner', workspace({ readOnly: true }), false, true).badge).toBe(READ_ONLY_BADGE);
    expect(boardAccess('owner', null, true, true).badge).toBe(DELETED_BADGE);
    expect(boardAccess('owner', null, false, false).storeReadOnly).toBe(false);
  });

  it('lets a viewer stay a viewer once the workspace is writable again', () => {
    expect(boardAccess('viewer', workspace({ readOnly: true })).storeReadOnly).toBe(true);
    expect(boardAccess('viewer', workspace({ readOnly: false }))).toEqual({ storeReadOnly: true, commentsReadOnly: true, badge: 'View only' });
  });
});

describe('canManageBilling', () => {
  it.each<[string, Me | null | undefined, boolean]>([
    ['the owner of a hosted workspace', meWith('owner', workspace()), true],
    ['an admin of a hosted workspace', meWith('admin', workspace()), false],
    ['a member of a hosted workspace', meWith('member', workspace()), false],
    ['a guest of a hosted workspace', meWith('guest', workspace()), false],
    ['the owner of a plain accounts server', meWith('owner'), false],
    ['the owner of a workspace provided free', meWith('owner', workspace({ billing: false })), false],
    ['the owner of a workspace that says billing is on', meWith('owner', workspace({ billing: true })), true],
    ['nobody', null, false],
    ['an unknown user', undefined, false],
  ])('%s', (_name, me, expected) => {
    expect(canManageBilling(me)).toBe(expected);
  });
});

describe('freeWorkspaceNote', () => {
  it('speaks to the owner of a workspace provided free, and to nobody else', () => {
    const free = workspace({ billing: false });
    expect(freeWorkspaceNote(meWith('owner', free))).toBe("This workspace is provided free (education or internal). There's nothing to bill.");
    expect(freeWorkspaceNote(meWith('admin', free))).toBeNull();
    expect(freeWorkspaceNote(meWith('owner', workspace()))).toBeNull();
    expect(freeWorkspaceNote(meWith('owner'))).toBeNull();
    expect(freeWorkspaceNote(null)).toBeNull();
  });

  it('is also what the no_billing error reads', () => {
    expect(cloudErrorMessage(new ApiError(409, 'no_billing', 'no_billing'))).toBe(FREE_WORKSPACE_TEXT);
  });
});

describe('trialStatusText', () => {
  const date = '2026-11-07T15:00:00Z';
  const localizedDate = new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  it('formats a valid trial end date in the viewer locale', () => {
    expect(trialStatusText('trialing', date)).toBe(`Free trial until ${localizedDate}`);
  });

  it('keeps a past date visible while the workspace is still trialing', () => {
    expect(trialStatusText('trialing', '2020-01-02T00:00:00Z')).toBe(
      `Free trial until ${new Date('2020-01-02T00:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`,
    );
  });

  it.each<[string, unknown, unknown]>([
    ['a bad date', 'trialing', 'not a date'],
    ['an active workspace', 'active', date],
    ['an unknown state', 'new_lifecycle', date],
    ['a missing state', undefined, date],
    ['a missing date', 'trialing', undefined],
    ['a null date', 'trialing', null],
  ])('shows nothing for %s', (_name, state, endsAt) => {
    expect(trialStatusText(state, endsAt)).toBeNull();
  });
});

describe('cloudErrorMessage', () => {
  it('prefers the server text and falls back to a readable one', () => {
    expect(cloudErrorMessage(new ApiError(409, 'seat_limit', 'All 3 seats are in use.'))).toBe('All 3 seats are in use.');
    expect(cloudErrorMessage(new ApiError(409, 'seat_limit', 'seat_limit'))).toBe(
      'All seats are in use. Remove or disable someone, or ask the workspace owner to add seats.',
    );
    expect(cloudErrorMessage(new ApiError(402, 'read_only', 'read_only'))).toBe('This workspace is read-only right now. Ask the workspace owner to check billing.');
    expect(cloudErrorMessage(new ApiError(402, 'read_only', 'The workspace is locked.'))).toBe('The workspace is locked.');
  });

  it.each<[string, unknown]>([
    ['another API error', new ApiError(409, 'last_owner', 'The workspace needs an owner')],
    ['an inherited property name', new ApiError(400, 'constructor', 'x')],
    ['a plain error', new Error('seat_limit')],
    ['a string', 'seat_limit'],
    ['nothing', undefined],
  ])('has nothing to say about %s', (_name, error) => {
    expect(cloudErrorMessage(error)).toBeNull();
  });
});

describe('portalTarget', () => {
  it.each<[unknown, string | null]>([
    ['https://billing.stripe.com/p/session/abc', 'https://billing.stripe.com/p/session/abc'],
    ['http://billing.example.com/x', null],
    ['javascript:alert(1)', null],
    ['data:text/html,hi', null],
    ['//billing.example.com', null],
    ['/portal', null],
    ['not a url', null],
    ['', null],
    [undefined, null],
    [5, null],
    [{ url: 'https://x.example.com' }, null],
  ])('%j', (url, target) => {
    expect(portalTarget(url)).toBe(target);
  });
});

describe('meChanged', () => {
  it('compares what the server said', () => {
    const a = meWith('owner', workspace({ banner: 'x' }));
    expect(meChanged(null, a)).toBe(true);
    expect(meChanged(a, structuredClone(a))).toBe(false);
    expect(meChanged(a, meWith('owner', workspace({ banner: 'y' })))).toBe(true);
    expect(meChanged(a, meWith('owner', workspace({ banner: 'x', readOnly: true })))).toBe(true);
    expect(meChanged(a, meWith('admin', workspace({ banner: 'x' })))).toBe(true);
  });
});

describe('createMeRefresher', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  function harness(overrides: Partial<MeRefreshDeps> = {}) {
    let tick: () => void = () => undefined;
    const state = { active: true, visible: true };
    const cleared = vi.fn<(handle: unknown) => void>();
    const intervals: number[] = [];
    const fetchMe = vi.fn<() => Promise<Me>>(async () => meWith('owner', workspace({ readOnly: true })));
    const apply = vi.fn<(me: Me) => void>();
    const expired = vi.fn<() => void>();
    const refresher = createMeRefresher({
      active: () => state.active,
      visible: () => state.visible,
      fetchMe,
      apply,
      expired,
      setInterval: (fn, ms) => {
        tick = fn;
        intervals.push(ms);
        return 'handle';
      },
      clearInterval: cleared,
      ...overrides,
    });
    return { refresher, state, fetchMe, apply, expired, cleared, intervals, tick: () => tick() };
  }

  it('asks every five minutes', () => {
    expect(harness().intervals).toEqual([5 * 60 * 1000]);
    expect(ME_REFRESH_MS).toBe(300_000);
  });

  it('fetches /api/me on each tick and hands the answer on', async () => {
    const h = harness();
    h.tick();
    await settle();
    expect(h.fetchMe).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith(meWith('owner', workspace({ readOnly: true })));
    h.tick();
    await settle();
    expect(h.fetchMe).toHaveBeenCalledTimes(2);
  });

  it('stays quiet while nobody is signed in on a hosted workspace', async () => {
    const h = harness();
    h.state.active = false;
    h.tick();
    await settle();
    expect(h.fetchMe).not.toHaveBeenCalled();
  });

  it('skips hidden tabs and catches up as soon as the tab is seen', async () => {
    const h = harness();
    h.state.visible = false;
    h.tick();
    h.tick();
    await settle();
    expect(h.fetchMe).not.toHaveBeenCalled();
    h.state.visible = true;
    h.refresher.resume();
    await settle();
    expect(h.fetchMe).toHaveBeenCalledTimes(1);
    h.refresher.resume();
    await settle();
    expect(h.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('does not overlap two requests', async () => {
    let release: (me: Me) => void = () => undefined;
    const h = harness({ fetchMe: () => new Promise<Me>((resolve) => (release = resolve)) });
    h.tick();
    h.tick();
    release(meWith('owner', workspace()));
    await settle();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('ends the session on a 401 and ignores every other failure', async () => {
    const h = harness({ fetchMe: async () => Promise.reject(new ApiError(401, 'unauthenticated', 'Sign in required')) });
    h.tick();
    await settle();
    expect(h.expired).toHaveBeenCalledTimes(1);
    expect(h.apply).not.toHaveBeenCalled();

    for (const error of [new ApiError(0, 'network', 'network'), new ApiError(500, 'internal', 'x'), new TypeError('boom'), new ApiError(402, 'read_only', 'x')]) {
      const other = harness({ fetchMe: async () => Promise.reject(error) });
      other.tick();
      await settle();
      expect(other.expired).not.toHaveBeenCalled();
      expect(other.apply).not.toHaveBeenCalled();
    }
  });

  it('drops an answer that arrives after the person signed out', async () => {
    let release: (me: Me) => void = () => undefined;
    const h = harness({ fetchMe: () => new Promise<Me>((resolve) => (release = resolve)) });
    h.tick();
    h.state.active = false;
    release(meWith('owner', workspace()));
    await settle();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('keeps going after a failure', async () => {
    let fail = true;
    const h = harness({ fetchMe: async () => (fail ? Promise.reject(new TypeError('offline')) : meWith('owner', workspace())) });
    h.tick();
    await settle();
    fail = false;
    h.tick();
    await settle();
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it('stops', () => {
    const h = harness();
    h.refresher.stop();
    expect(h.cleared).toHaveBeenCalledWith('handle');
  });

  describe('hints from the relay', () => {
    function timers() {
      const waiting = new Map<number, { fn: () => void; ms: number }>();
      let next = 0;
      return {
        setTimeout: (fn: () => void, ms: number) => {
          waiting.set(++next, { fn, ms });
          return next;
        },
        clearTimeout: (handle: unknown) => void waiting.delete(handle as number),
        waiting: () => [...waiting.values()],
        fire: () => {
          const due = [...waiting.values()];
          waiting.clear();
          due.forEach((t) => t.fn());
        },
      };
    }

    it('turns a burst of hints into one request after a short wait', async () => {
      const t = timers();
      const h = harness({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
      h.refresher.hint();
      h.refresher.hint();
      h.refresher.hint();
      expect(t.waiting().map((w) => w.ms)).toEqual([HINT_COALESCE_MS]);
      expect(h.fetchMe).not.toHaveBeenCalled();
      t.fire();
      await settle();
      expect(h.fetchMe).toHaveBeenCalledTimes(1);
      expect(h.apply).toHaveBeenCalledTimes(1);

      h.refresher.hint();
      t.fire();
      await settle();
      expect(h.fetchMe).toHaveBeenCalledTimes(2);
    });

    it('asks again when a hint arrives while an older answer is still on its way', async () => {
      const t = timers();
      const releases: Array<(me: Me) => void> = [];
      const h = harness({
        setTimeout: t.setTimeout,
        clearTimeout: t.clearTimeout,
        fetchMe: () => new Promise<Me>((resolve) => releases.push(resolve)),
      });
      h.refresher.hint();
      t.fire();
      h.refresher.hint();
      t.fire();
      expect(releases).toHaveLength(1);
      releases[0](meWith('owner', workspace({ readOnly: true })));
      await settle();
      expect(releases).toHaveLength(2);
      releases[1](meWith('owner', workspace()));
      await settle();
      expect(h.apply).toHaveBeenCalledTimes(2);
      expect(releases).toHaveLength(2);
    });

    it('stays quiet for anyone who is not on a hosted workspace', async () => {
      const t = timers();
      const h = harness({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
      h.state.active = false;
      h.refresher.hint();
      t.fire();
      await settle();
      expect(h.fetchMe).not.toHaveBeenCalled();
    });

    it('leaves a hidden tab for when it is seen again', async () => {
      const t = timers();
      const h = harness({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
      h.state.visible = false;
      h.refresher.hint();
      t.fire();
      await settle();
      expect(h.fetchMe).not.toHaveBeenCalled();
      h.state.visible = true;
      h.refresher.resume();
      await settle();
      expect(h.fetchMe).toHaveBeenCalledTimes(1);
    });

    it('drops a hint that is still waiting when it stops', async () => {
      const t = timers();
      const h = harness({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
      h.refresher.hint();
      h.refresher.stop();
      expect(t.waiting()).toEqual([]);
      t.fire();
      await settle();
      expect(h.fetchMe).not.toHaveBeenCalled();
    });

    it('uses the real timers by default', () => {
      vi.useFakeTimers();
      try {
        const h = harness();
        h.refresher.hint();
        vi.advanceTimersByTime(HINT_COALESCE_MS - 1);
        expect(h.fetchMe).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(h.fetchMe).toHaveBeenCalledTimes(1);
        h.refresher.hint();
        h.refresher.stop();
        vi.advanceTimersByTime(HINT_COALESCE_MS * 2);
        expect(h.fetchMe).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('createUnlockWatcher', () => {
  it('fires once when a read-only workspace becomes writable', () => {
    const onUnlock = vi.fn<() => void>();
    const watch = createUnlockWatcher(onUnlock);
    watch(workspace({ readOnly: true }));
    watch(workspace({ readOnly: true, banner: 'Pay up' }));
    expect(onUnlock).not.toHaveBeenCalled();
    watch(workspace({ readOnly: false }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
    watch(workspace({ readOnly: false, banner: 'Welcome back' }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('is quiet when the workspace turns read-only, or was never locked', () => {
    const onUnlock = vi.fn<() => void>();
    const watch = createUnlockWatcher(onUnlock);
    watch(workspace());
    watch(workspace({ readOnly: true }));
    watch(workspace());
    expect(onUnlock).toHaveBeenCalledTimes(1);

    const other = vi.fn<() => void>();
    const never = createUnlockWatcher(other);
    never(workspace());
    never(workspace({ banner: 'Hello' }));
    never(workspace({ readOnly: true }));
    expect(other).not.toHaveBeenCalled();
  });

  it('does not take a missing workspace (open mode, signed out) for an unlock', () => {
    const onUnlock = vi.fn<() => void>();
    const watch = createUnlockWatcher(onUnlock);
    watch(workspace({ readOnly: true }));
    watch(null);
    watch(undefined);
    expect(onUnlock).not.toHaveBeenCalled();
    watch(workspace());
    expect(onUnlock).toHaveBeenCalledTimes(1);

    const plain = vi.fn<() => void>();
    const open = createUnlockWatcher(plain);
    open(null);
    open(null);
    expect(plain).not.toHaveBeenCalled();
  });
});

describe('startMeRefresh', () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  function start(answer: () => Promise<Me>) {
    let tick: () => void = () => undefined;
    const fetchMe = vi.fn<() => Promise<Me>>(answer);
    const stop = startMeRefresh({
      fetchMe,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => undefined,
    });
    return { fetchMe, stop, tick: () => tick() };
  }

  it('moves a banner and the read-only switch into the signed-in state', async () => {
    await setSignedIn(meWith('member', workspace()));
    const s = start(async () => meWith('member', workspace({ readOnly: true, banner: 'Pay up' })));
    s.tick();
    await settle();
    const state = authState();
    expect(state.mode).toBe('signed-in');
    expect(workspaceOf(state)).toEqual(workspace({ readOnly: true, banner: 'Pay up' }));
    s.stop();
  });

  it('does not notify anyone when nothing changed', async () => {
    const me = meWith('member', workspace());
    await setSignedIn(me);
    const s = start(async () => structuredClone(me));
    const before = authState();
    s.tick();
    await settle();
    expect(authState()).toBe(before);
    s.stop();
  });

  it('does nothing on a server without a control plane, or when signed out', async () => {
    await setSignedIn(meWith('owner'));
    const plain = start(async () => meWith('owner'));
    plain.tick();
    await settle();
    expect(plain.fetchMe).not.toHaveBeenCalled();
    plain.stop();

    setSignedOut();
    const out = start(async () => meWith('owner', workspace()));
    out.tick();
    await settle();
    expect(out.fetchMe).not.toHaveBeenCalled();
    out.stop();
  });

  it('signs the person out when the session has ended', async () => {
    await setSignedIn(meWith('owner', workspace()));
    const s = start(async () => Promise.reject(new ApiError(401, 'unauthenticated', 'Sign in required')));
    s.tick();
    await settle();
    expect(authState().mode).toBe('signed-out');
    s.stop();
  });

  it('uses the real timers by default', async () => {
    vi.useFakeTimers();
    try {
      await setSignedIn(meWith('owner', workspace()));
      const fetchMe = vi.fn<() => Promise<Me>>(async () => meWith('owner', workspace()));
      const stop = startMeRefresh({ fetchMe });
      vi.advanceTimersByTime(ME_REFRESH_MS - 1);
      expect(fetchMe).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(fetchMe).toHaveBeenCalledTimes(1);
      stop();
      vi.advanceTimersByTime(ME_REFRESH_MS * 2);
      expect(fetchMe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('billing portal request', () => {
  it('posts with the CSRF header and returns the address', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ url: 'https://billing.example.com/p' }), { status: 200 }));
    const result = await createApi(fetchFn).billingPortal();
    expect(result).toEqual({ url: 'https://billing.example.com/p' });
    const [path, init] = fetchFn.mock.calls[0];
    expect(path).toBe('/api/billing/portal');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-tabula': '1' });
  });

  it('surfaces the 502 and 403 of the server', async () => {
    const reply = (status: number, error: string) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error, message: 'No.' }), { status }));
    await expect(createApi(reply(502, 'bad_gateway')).billingPortal()).rejects.toMatchObject({ status: 502, code: 'bad_gateway' });
    await expect(createApi(reply(403, 'forbidden')).billingPortal()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});
