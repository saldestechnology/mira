// The browser's copy of board chat (docs/chat.md, Offline): IndexedDB `tabula-chat` with a `channels` store (the last 50
// messages of each channel this person opened, for reading offline) and an `outbox` store (messages not yet accepted by
// the server). Every row is keyed by user id. Sign-out deletes the whole database; changing users can delete just the old
// user's rows. Without IndexedDB (a private window, blocked site data) every call resolves to nothing and chat works from
// memory only.

import type { ChatMessage } from './api';
import type { OutboxItem } from './ui/chat-logic';

const DB_NAME = 'tabula-chat';
const VERSION = 2;
const CHANNELS = 'channels';
const OUTBOX = 'outbox';

export interface CachedChannel { key: string; messages: ChatMessage[]; savedAt: number }

interface StoredOutboxItem extends OutboxItem { key: string; userId: string }

const scopedKey = (userId: string, key: string) => JSON.stringify([userId, key]);

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Version 1 did not record an owner for either store. Those rows cannot safely be assigned to the person who opens
      // the database next, so discard them while moving to user-scoped keys.
      if (event.oldVersion < VERSION) {
        if (db.objectStoreNames.contains(CHANNELS)) db.deleteObjectStore(CHANNELS);
        if (db.objectStoreNames.contains(OUTBOX)) db.deleteObjectStore(OUTBOX);
        db.createObjectStore(CHANNELS, { keyPath: 'key' });
        db.createObjectStore(OUTBOX, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // another tab deleting the database (sign-out) must not wait on this connection
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) return resolve(undefined);
    let req: IDBRequest<T> | void;
    try {
      const tx = db.transaction(store, mode);
      req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

export const readChannel = (userId: string, key: string): Promise<CachedChannel | undefined> =>
  run<CachedChannel>(CHANNELS, 'readonly', (s) => s.get(scopedKey(userId, key)) as IDBRequest<CachedChannel>);

export const writeChannel = (userId: string, entry: CachedChannel): Promise<unknown> =>
  run(CHANNELS, 'readwrite', (s) => s.put({ ...entry, userId, key: scopedKey(userId, entry.key) }));

export const readOutbox = (userId: string): Promise<OutboxItem[]> =>
  run<StoredOutboxItem[]>(OUTBOX, 'readonly', (s) => s.getAll() as IDBRequest<StoredOutboxItem[]>).then((items) =>
    (items ?? []).filter((item) => item.userId === userId).map(({ key: _key, userId: _userId, ...item }) => item));

export const putOutbox = (userId: string, item: OutboxItem): Promise<unknown> =>
  run(OUTBOX, 'readwrite', (s) => s.put({ ...item, userId, key: scopedKey(userId, item.clientId) }));

export const deleteOutbox = (userId: string, clientId: string): Promise<unknown> =>
  run(OUTBOX, 'readwrite', (s) => s.delete(scopedKey(userId, clientId)));

function prune(store: string, keep: (userId: unknown) => boolean): Promise<unknown> {
  return run<IDBCursorWithValue | null>(store, 'readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const userId = (cursor.value as { userId?: unknown }).userId;
      if (!keep(userId)) cursor.delete();
      cursor.continue();
    };
    return req;
  });
}

/** Keep only rows that belong to the confirmed account; unscoped legacy rows are always removed. */
export async function purgeOtherUsers(userId: string): Promise<void> {
  await Promise.all([
    prune(CHANNELS, (owner) => owner === userId),
    prune(OUTBOX, (owner) => owner === userId),
  ]);
}

/** Remove one account's rows (and any legacy rows whose owner was never recorded). */
export async function clearUserChatCache(userId: string): Promise<void> {
  await Promise.all([
    prune(CHANNELS, (owner) => typeof owner === 'string' && owner !== userId),
    prune(OUTBOX, (owner) => typeof owner === 'string' && owner !== userId),
  ]);
}

/** Sign-out: the cached messages and the unsent ones are this person's and go with them. */
export function clearChatCache(): Promise<void> {
  return open().then((db) => {
    db?.close();
    opening = null;
    return new Promise<void>((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve();
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  });
}
