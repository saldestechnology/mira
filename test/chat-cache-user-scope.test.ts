import { afterEach, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/api';
import {
  clearChatCache, deleteChannel, putOutbox, purgeOtherUsers, readChannel, readOutbox, writeChannel,
} from '../src/chat-cache';
import type { OutboxItem } from '../src/ui/chat-logic';

type Row = Record<string, unknown>;
type StoreData = { keyPath: string; rows: Map<IDBValidKey, unknown> };

class MemoryRequest<T> {
  result!: T;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;
}

class MemoryTransaction {
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;

  constructor(private data: StoreData) {}

  objectStore() { return new MemoryObjectStore(this.data, this); }
  finish() { this.oncomplete?.({} as Event); }
}

class MemoryObjectStore {
  constructor(private data: StoreData, private tx: MemoryTransaction) {}

  get(key: IDBValidKey) {
    const request = new MemoryRequest<unknown>();
    queueMicrotask(() => {
      request.result = this.data.rows.get(key);
      request.onsuccess?.({ target: request } as unknown as Event);
      queueMicrotask(() => this.tx.finish());
    });
    return request;
  }

  getAll() {
    const request = new MemoryRequest<unknown[]>();
    queueMicrotask(() => {
      request.result = [...this.data.rows.values()];
      request.onsuccess?.({ target: request } as unknown as Event);
      queueMicrotask(() => this.tx.finish());
    });
    return request;
  }

  put(value: Row) {
    const request = new MemoryRequest<IDBValidKey>();
    queueMicrotask(() => {
      const key = value[this.data.keyPath] as IDBValidKey;
      this.data.rows.set(key, value);
      request.result = key;
      request.onsuccess?.({ target: request } as unknown as Event);
      queueMicrotask(() => this.tx.finish());
    });
    return request;
  }

  delete(key: IDBValidKey) {
    const request = new MemoryRequest<undefined>();
    queueMicrotask(() => {
      this.data.rows.delete(key);
      request.result = undefined;
      request.onsuccess?.({ target: request } as unknown as Event);
      queueMicrotask(() => this.tx.finish());
    });
    return request;
  }

  openCursor() {
    const request = new MemoryRequest<IDBCursorWithValue | null>();
    const entries = [...this.data.rows.entries()];
    let index = 0;
    const step = () => queueMicrotask(() => {
      if (index >= entries.length) {
        request.result = null;
        request.onsuccess?.({ target: request } as unknown as Event);
        queueMicrotask(() => this.tx.finish());
        return;
      }
      const [key, value] = entries[index];
      request.result = {
        key,
        value,
        delete: () => {
          const deleted = new MemoryRequest<undefined>();
          this.data.rows.delete(key);
          return deleted;
        },
        continue: () => {
          index++;
          step();
        },
      } as unknown as IDBCursorWithValue;
      request.onsuccess?.({ target: request } as unknown as Event);
    });
    step();
    return request;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  onversionchange: (() => void) | null = null;
  private stores = new Map<string, StoreData>();

  constructor(public version: number) {
    if (version === 1) {
      this.createObjectStore('channels', { keyPath: 'key' });
      this.createObjectStore('outbox', { keyPath: 'clientId' });
      this.stores.get('channels')!.rows.set('workspace/main', { key: 'workspace/main', messages: [{ text: 'legacy A' }] });
      this.stores.get('outbox')!.rows.set('legacy-draft', { clientId: 'legacy-draft', text: 'legacy A draft' });
    }
  }

  createObjectStore(name: string, options: { keyPath: string }) {
    this.stores.set(name, { keyPath: options.keyPath, rows: new Map() });
    return {};
  }

  deleteObjectStore(name: string) { this.stores.delete(name); }
  transaction(name: string) { return new MemoryTransaction(this.stores.get(name)!); }
  close() {}
}

class MemoryIndexedDB {
  database = new MemoryDatabase(1);

  open() {
    const request = new MemoryRequest<MemoryDatabase>();
    queueMicrotask(() => {
      request.result = this.database;
      request.onupgradeneeded?.({ oldVersion: 1 } as IDBVersionChangeEvent);
      this.database.version = 2;
      queueMicrotask(() => request.onsuccess?.({ target: request } as unknown as Event));
    });
    return request;
  }

  deleteDatabase() {
    const request = new MemoryRequest<undefined>();
    queueMicrotask(() => {
      request.result = undefined;
      request.onsuccess?.({ target: request } as unknown as Event);
    });
    return request;
  }
}

const message = (id: number, text: string): ChatMessage => ({
  id, kind: 'workspace', ref: 'main', authorId: 'ana', authorName: 'Ana', clientId: `client-${id}-xx`, text,
  replyTo: null, objectId: null, mentions: [], createdAt: id, editedAt: null, deleted: false, deletedBy: null,
});

const outboxItem = (clientId: string, text: string): OutboxItem => ({
  clientId, kind: 'workspace', ref: 'main', text, replyTo: null, objectId: null, createdLocal: 1, state: 'queued',
});

afterEach(async () => {
  await clearChatCache();
  vi.unstubAllGlobals();
});

it('migrates unscoped rows away and stores, reads, and purges chat rows by account id', async () => {
  vi.stubGlobal('indexedDB', new MemoryIndexedDB() as unknown as IDBFactory);

  expect(await readChannel('user-a', 'workspace/main')).toBeUndefined();
  expect(await readOutbox('user-a')).toEqual([]);

  await writeChannel('user-a', { key: 'workspace/main', messages: [message(1, 'A text')], savedAt: 1 });
  await writeChannel('user-b', { key: 'workspace/main', messages: [message(2, 'B text')], savedAt: 2 });
  await putOutbox('user-a', outboxItem('draft-a-123', 'A draft'));
  await putOutbox('user-b', outboxItem('draft-b-123', 'B draft'));

  expect((await readChannel('user-a', 'workspace/main'))?.messages.map((item) => item.text)).toEqual(['A text']);
  expect((await readChannel('user-b', 'workspace/main'))?.messages.map((item) => item.text)).toEqual(['B text']);
  expect(await readOutbox('user-a')).toEqual([outboxItem('draft-a-123', 'A draft')]);
  expect(await readOutbox('user-b')).toEqual([outboxItem('draft-b-123', 'B draft')]);

  await purgeOtherUsers('user-b');
  expect(await readChannel('user-a', 'workspace/main')).toBeUndefined();
  expect(await readOutbox('user-a')).toEqual([]);
  expect((await readChannel('user-b', 'workspace/main'))?.messages.map((item) => item.text)).toEqual(['B text']);
  expect(await readOutbox('user-b')).toEqual([outboxItem('draft-b-123', 'B draft')]);
});

it('deletes only the denied account and channel cache row', async () => {
  vi.stubGlobal('indexedDB', new MemoryIndexedDB() as unknown as IDBFactory);
  await writeChannel('user-a', { key: 'workspace/main', messages: [message(1, 'A text')], savedAt: 1 });
  await writeChannel('user-b', { key: 'workspace/main', messages: [message(2, 'B text')], savedAt: 2 });

  await deleteChannel('user-a', 'workspace/main');

  expect(await readChannel('user-a', 'workspace/main')).toBeUndefined();
  expect((await readChannel('user-b', 'workspace/main'))?.messages.map((item) => item.text)).toEqual(['B text']);
});
