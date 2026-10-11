import { afterEach, describe, expect, it, vi } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Me, Workspace } from '../src/api';
import { authState, onAuth, refreshMeSoon, setSignedIn, setSignedOut, startMeRefresh } from '../src/auth';
import { createUnlockWatcher, workspaceOf } from '../src/cloud-logic';
import { MSG_WORKSPACE, onWorkspaceHint, resyncRooms, type DeniedReason } from '../src/sync';

// docs/cloud.md, "Read-only": the relay tells open sockets when the read-only switch flips, and the app reconnects when
// the workspace is writable again. Fake providers stand in for y-websocket's WebsocketProvider.

const settle = () => new Promise((resolve) => setImmediate(resolve));

const workspace = (patch: Partial<Workspace> = {}): Workspace => ({ readOnly: false, banner: null, seatLimit: null, seatsUsed: 1, ...patch });
const meWith = (ws?: Workspace): Me => ({
  user: { id: 'u1', email: 'ana@example.com', name: 'Ana', role: 'member' },
  teams: [],
  ...(ws ? { workspace: ws } : {}),
});

type Handler = (encoder: encoding.Encoder, decoder: decoding.Decoder, provider: unknown, emitSynced: boolean, messageType: number) => void;

function fakeProvider() {
  return {
    messageHandlers: [] as Handler[],
    disconnect: vi.fn<() => void>(),
    connect: vi.fn<() => void>(),
  };
}
type FakeProvider = ReturnType<typeof fakeProvider>;

/** Delivers a message to the provider the way y-websocket does: by its first varUint. Returns what the handler wrote. */
function receive(provider: FakeProvider, build: (enc: encoding.Encoder) => void) {
  const enc = encoding.createEncoder();
  build(enc);
  const decoder = decoding.createDecoder(encoding.toUint8Array(enc));
  const messageType = decoding.readVarUint(decoder);
  const reply = encoding.createEncoder();
  provider.messageHandlers[messageType](reply, decoder, provider, true, messageType);
  return encoding.length(reply);
}

const hintFrame = (readOnly: boolean) => (enc: encoding.Encoder) => {
  encoding.writeVarUint(enc, MSG_WORKSPACE);
  encoding.writeVarString(enc, JSON.stringify({ readOnly }));
};

afterEach(() => {
  setSignedOut();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('onWorkspaceHint', () => {
  it('uses a message type that y-websocket does not', () => {
    // 0 sync, 1 awareness, 2 auth, 3 query awareness
    expect(MSG_WORKSPACE).toBe(4);
  });

  it('calls back for each hint and writes nothing back to the relay', () => {
    const provider = fakeProvider();
    const callback = vi.fn<() => void>();
    onWorkspaceHint(provider, callback);
    expect(receive(provider, hintFrame(true))).toBe(0);
    expect(receive(provider, hintFrame(false))).toBe(0);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('only fills its own slot', () => {
    const provider = fakeProvider();
    onWorkspaceHint(provider, () => undefined);
    expect(Object.keys(provider.messageHandlers).map(Number)).toEqual([MSG_WORKSPACE]);
  });

  it('does not throw for a payload that is empty, cut off or not JSON', () => {
    const provider = fakeProvider();
    const callback = vi.fn<() => void>();
    onWorkspaceHint(provider, callback);
    expect(() => receive(provider, (enc) => encoding.writeVarUint(enc, MSG_WORKSPACE))).not.toThrow(/./);
    expect(() =>
      receive(provider, (enc) => {
        encoding.writeVarUint(enc, MSG_WORKSPACE);
        encoding.writeVarString(enc, 'not json {');
      }),
    ).not.toThrow(/./);
    expect(() =>
      receive(provider, (enc) => {
        encoding.writeVarUint(enc, MSG_WORKSPACE);
        encoding.writeUint8Array(enc, new Uint8Array([0xff, 0xff, 0xff]));
      }),
    ).not.toThrow(/./);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('keeps a failing listener from breaking the socket', () => {
    const provider = fakeProvider();
    onWorkspaceHint(provider, () => {
      throw new Error('listener failed');
    });
    expect(() => receive(provider, hintFrame(true))).not.toThrow(/./);
  });
});

describe('resyncRooms', () => {
  it('disconnects and connects each room once, the board and the comments', () => {
    const board = fakeProvider();
    const comments = fakeProvider();
    resyncRooms({ denied: null }, [board, comments]);
    for (const room of [board, comments]) {
      expect(room.disconnect).toHaveBeenCalledTimes(1);
      expect(room.connect).toHaveBeenCalledTimes(1);
      expect(room.disconnect.mock.invocationCallOrder[0]).toBeLessThan(room.connect.mock.invocationCallOrder[0]);
    }
  });

  it.each<DeniedReason>(['unauthenticated', 'no_access', 'not_found', 'access_removed'])('leaves a board the relay refused (%s) alone', (reason) => {
    const board = fakeProvider();
    resyncRooms({ denied: reason }, [board]);
    expect(board.disconnect).not.toHaveBeenCalled();
    expect(board.connect).not.toHaveBeenCalled();
  });
});

// The same chain main.ts builds for an open board: sockets -> hint -> one /api/me -> signed-in state -> read-only switch
// and, when the workspace is writable again, a reconnect of both rooms.
describe('a board in a hosted workspace', () => {
  async function open(initial: Workspace | undefined) {
    if (initial) await setSignedIn(meWith(initial));
    else await setSignedIn(meWith());
    const board = fakeProvider();
    const comments = fakeProvider();
    const conn = { denied: null as DeniedReason | null };
    const readOnly: boolean[] = [];

    const watchUnlock = createUnlockWatcher(() => resyncRooms(conn, [board, comments]));
    const applyAccess = () => {
      const ws = workspaceOf(authState());
      readOnly.push(ws?.readOnly === true);
      watchUnlock(ws);
    };
    applyAccess();
    const release = onAuth(applyAccess);
    onWorkspaceHint(board, refreshMeSoon);
    onWorkspaceHint(comments, refreshMeSoon);

    let answer = meWith(initial);
    const fetchMe = vi.fn<() => Promise<Me>>(async () => answer);
    const timers: Array<() => void> = [];
    let tick: () => void = () => undefined;
    const stop = startMeRefresh({
      fetchMe,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => undefined,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => undefined,
    });
    return {
      board,
      comments,
      conn,
      readOnly,
      fetchMe,
      serverNow: (ws: Workspace | undefined) => {
        answer = meWith(ws);
      },
      /** Both sockets of the board get the relay's message, a moment apart. */
      push: (to: boolean) => {
        receive(board, hintFrame(to));
        receive(comments, hintFrame(to));
      },
      coalesced: async () => {
        timers.splice(0).forEach((fn) => fn());
        await settle();
      },
      fallback: async () => {
        tick();
        await settle();
      },
      close: () => {
        stop();
        release();
      },
    };
  }

  it('asks /api/me once for the two sockets and switches to read-only without a reconnect', async () => {
    const b = await open(workspace());
    try {
      b.serverNow(workspace({ readOnly: true }));
      b.push(true);
      await b.coalesced();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      expect(workspaceOf(authState())?.readOnly).toBe(true);
      expect(b.readOnly.at(-1)).toBe(true);
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).not.toHaveBeenCalled();
        expect(room.connect).not.toHaveBeenCalled();
      }
    } finally {
      b.close();
    }
  });

  it('reconnects both rooms once when the answer says the workspace is writable again', async () => {
    const b = await open(workspace({ readOnly: true }));
    try {
      b.serverNow(workspace());
      b.push(false);
      await b.coalesced();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      expect(b.readOnly.at(-1)).toBe(false);
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).toHaveBeenCalledTimes(1);
        expect(room.connect).toHaveBeenCalledTimes(1);
      }

      b.push(false);
      await b.coalesced();
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).toHaveBeenCalledTimes(1);
        expect(room.connect).toHaveBeenCalledTimes(1);
      }
    } finally {
      b.close();
    }
  });

  it('does not take the hint at its word', async () => {
    const b = await open(workspace({ readOnly: true }));
    try {
      b.push(false);
      await b.coalesced();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      expect(workspaceOf(authState())?.readOnly).toBe(true);
      expect(b.board.disconnect).not.toHaveBeenCalled();
    } finally {
      b.close();
    }
  });

  it('still reconnects when only the five minute refresh sees the unlock', async () => {
    const b = await open(workspace({ readOnly: true }));
    try {
      b.serverNow(workspace());
      await b.fallback();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).toHaveBeenCalledTimes(1);
        expect(room.connect).toHaveBeenCalledTimes(1);
      }
    } finally {
      b.close();
    }
  });

  it('reconnects on the first refresh after the tab is seen again', async () => {
    const listeners: Array<() => void> = [];
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('document', doc);
    const b = await open(workspace({ readOnly: true }));
    try {
      b.serverNow(workspace());
      b.push(false);
      await b.coalesced();
      await b.fallback();
      expect(b.fetchMe).not.toHaveBeenCalled();
      expect(b.board.disconnect).not.toHaveBeenCalled();

      doc.visibilityState = 'visible';
      listeners.forEach((fn) => fn());
      await settle();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).toHaveBeenCalledTimes(1);
        expect(room.connect).toHaveBeenCalledTimes(1);
      }
    } finally {
      b.close();
    }
  });

  it('does not reconnect a board the relay refused', async () => {
    const b = await open(workspace({ readOnly: true }));
    try {
      b.conn.denied = 'access_removed';
      b.serverNow(workspace());
      b.push(false);
      await b.coalesced();
      expect(b.fetchMe).toHaveBeenCalledTimes(1);
      expect(b.board.disconnect).not.toHaveBeenCalled();
      expect(b.board.connect).not.toHaveBeenCalled();
    } finally {
      b.close();
    }
  });

  it('does not reconnect when the session ends', async () => {
    const b = await open(workspace({ readOnly: true }));
    try {
      setSignedOut();
      expect(b.board.disconnect).not.toHaveBeenCalled();
      b.push(false);
      await b.coalesced();
      expect(b.fetchMe).not.toHaveBeenCalled();
      expect(b.board.disconnect).not.toHaveBeenCalled();
    } finally {
      b.close();
    }
  });

  it('is inert without a control plane', async () => {
    const b = await open(undefined);
    try {
      b.push(true);
      b.push(false);
      await b.coalesced();
      await b.fallback();
      expect(b.fetchMe).not.toHaveBeenCalled();
      for (const room of [b.board, b.comments]) {
        expect(room.disconnect).not.toHaveBeenCalled();
        expect(room.connect).not.toHaveBeenCalled();
      }
    } finally {
      b.close();
    }
  });
});
