import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import { outboxItem } from '../src/ui/chat-logic';

type EventHandler = ((event: Event) => void) | null;

interface FakeRequest<T> {
  result?: T;
  onsuccess?: EventHandler;
  onerror?: EventHandler;
  onblocked?: EventHandler;
  onupgradeneeded?: EventHandler;
}

interface FakeStoreState {
  keyPath: string;
  values: Map<string, unknown>;
}

interface FakeDatabaseState {
  stores: Map<string, FakeStoreState>;
  connections: Set<FakeDatabase>;
  pendingDelete?: { name: string; request: FakeRequest<undefined> };
}

interface FakeTransaction {
  oncomplete: EventHandler;
  onerror: EventHandler;
  onabort: EventHandler;
  objectStore(name: string): FakeObjectStore;
}

interface FakeObjectStore {
  get(key: IDBValidKey): FakeRequest<unknown>;
  getAll(): FakeRequest<unknown[]>;
  put(value: unknown): FakeRequest<undefined>;
  delete(key: IDBValidKey): FakeRequest<undefined>;
}

interface FakeDatabase {
  readonly closed: boolean;
  readonly objectStoreNames: { contains(name: string): boolean };
  onversionchange: EventHandler;
  close(): void;
  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore;
  transaction(name: string, mode: IDBTransactionMode): FakeTransaction;
}

/** Shared origin storage with independent connections, versionchange, and a pending blocked delete. */
function sharedFakeIndexedDB() {
  const databases = new Map<string, FakeDatabaseState>();
  let versionchangeEvents = 0;
  let blockedEvents = 0;
  let completedDeletes = 0;

  const copy = <T>(value: T): T => structuredClone(value);

  const request = <T>(transaction: FakeTransaction, run: () => T): FakeRequest<T> => {
    const result: FakeRequest<T> = {};
    queueMicrotask(() => {
      try {
        result.result = run();
        transaction.oncomplete?.(new Event('complete'));
      } catch {
        transaction.onerror?.(new Event('error'));
      }
    });
    return result;
  };

  const completeDelete = (name: string, state: FakeDatabaseState, req: FakeRequest<undefined>) => {
    if (databases.get(name) === state) databases.delete(name);
    if (state.pendingDelete?.request === req) state.pendingDelete = undefined;
    completedDeletes++;
    queueMicrotask(() => req.onsuccess?.(new Event('success')));
  };

  const connect = (state: FakeDatabaseState): FakeDatabase => {
    let isClosed = false;
    let db: FakeDatabase;
    db = {
      get closed() {
        return isClosed;
      },
      objectStoreNames: { contains: (name) => state.stores.has(name) },
      onversionchange: null,
      close() {
        if (isClosed) return;
        isClosed = true;
        state.connections.delete(db);
        if (state.connections.size === 0 && state.pendingDelete) {
          completeDelete(state.pendingDelete.name, state, state.pendingDelete.request);
        }
      },
      createObjectStore(name, options) {
        if (state.stores.has(name)) throw new Error(`Object store already exists: ${name}`);
        state.stores.set(name, { keyPath: options.keyPath, values: new Map() });
        return this.transaction(name, 'readwrite').objectStore(name);
      },
      transaction(name) {
        const store = state.stores.get(name);
        if (!store) throw new Error(`Object store does not exist: ${name}`);
        const transaction: FakeTransaction = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          objectStore(storeName) {
            if (storeName !== name || isClosed) throw new Error('Invalid database connection.');
            return {
              get(key) {
                return request(transaction, () => {
                  const value = store.values.get(String(key));
                  return value === undefined ? undefined : copy(value);
                });
              },
              getAll() {
                return request(transaction, () => [...store.values.values()].map(copy));
              },
              put(value) {
                return request(transaction, () => {
                  const row = value as Record<string, unknown>;
                  store.values.set(String(row[store.keyPath]), copy(value));
                  return undefined;
                });
              },
              delete(key) {
                return request(transaction, () => {
                  store.values.delete(String(key));
                  return undefined;
                });
              },
            };
          },
        };
        return transaction;
      },
    };
    state.connections.add(db);
    return db;
  };

  const factory = {
    open(name: string) {
      const req: FakeRequest<FakeDatabase> = {};
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        const state = databases.get(name) ?? { stores: new Map(), connections: new Set<FakeDatabase>() };
        databases.set(name, state);
        req.result = connect(state);
        if (isNew) req.onupgradeneeded?.(Object.assign(new Event('upgradeneeded'), { oldVersion: 0 }));
        req.onsuccess?.(new Event('success'));
      });
      return req as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(name: string) {
      const req: FakeRequest<undefined> = {};
      queueMicrotask(() => {
        const state = databases.get(name);
        if (!state) {
          completeDelete(name, { stores: new Map(), connections: new Set() }, req);
          return;
        }

        for (const connection of state.connections) {
          versionchangeEvents++;
          connection.onversionchange?.(new Event('versionchange'));
        }

        if (state.connections.size > 0) {
          state.pendingDelete = { name, request: req };
          blockedEvents++;
          req.onblocked?.(new Event('blocked'));
          return;
        }
        completeDelete(name, state, req);
      });
      return req as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;

  return {
    factory,
    connectionCount: (name: string) => databases.get(name)?.connections.size ?? 0,
    versionchangeEvents: () => versionchangeEvents,
    blockedEvents: () => blockedEvents,
    completedDeletes: () => completedDeletes,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('CDX-43 chat cache account isolation', () => {
  it('clears the signed-out account across tabs before the other tab reopens the cache', async () => {
    const shared = sharedFakeIndexedDB();
    vi.stubGlobal('indexedDB', shared.factory);

    // Each module instance represents a tab with its own cached open connection.
    const tabA = await import('../src/chat-cache');
    const previousAccountMessage: ChatMessage = {
      id: 7,
      kind: 'board',
      ref: 'b1',
      authorId: 'account-a',
      authorName: 'Account A',
      clientId: 'aaaaaaaa',
      text: 'private message',
      replyTo: null,
      objectId: null,
      mentions: [],
      createdAt: 7,
      editedAt: null,
      deleted: false,
      deletedBy: null,
    };
    const channel = { key: 'board/b1', messages: [previousAccountMessage], savedAt: 7 };
    const pending = outboxItem({
      clientId: 'bbbbbbbb',
      kind: 'board',
      ref: 'b1',
      text: 'unsent private message',
      createdLocal: 8,
    });

    await Promise.all([tabA.writeChannel('u1', channel), tabA.putOutbox('u1', pending)]);
    expect(shared.connectionCount('tabula-chat')).toBe(1);

    vi.resetModules();
    const tabB = await import('../src/chat-cache');
    expect(await tabB.readChannel('u1', 'board/b1')).toEqual(channel);
    expect(await tabB.readOutbox('u1')).toEqual([pending]);
    expect(shared.connectionCount('tabula-chat')).toBe(2);

    await tabB.clearChatCache();

    expect(shared.versionchangeEvents()).toBe(1);
    expect(shared.blockedEvents()).toBe(0);
    expect(shared.completedDeletes()).toBe(1);
    expect(shared.connectionCount('tabula-chat')).toBe(0);
    expect(await tabA.readChannel('u1', 'board/b1')).toBeUndefined();
    expect(await tabA.readOutbox('u1')).toEqual([]);
    expect(shared.connectionCount('tabula-chat')).toBe(1);
  });
});
