import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ServerTemplate, type ServerTemplateInfo } from '../src/api';
import type { BaseObj } from '../src/types';
import type { CustomTemplate, TemplateContent } from '../src/custom-templates';
import { setSignedIn, setSignedOut } from '../src/auth';
import {
  OFFLINE_MESSAGE, indexedDbCache, memoryCache, serverBackend, TemplateError, type ServerBackendDeps, type TemplateApi,
} from '../src/template-server';
import {
  TemplateError as ExportedTemplateError, browserTemplates, createTemplateStore, duplicateSavedTemplate, getTemplate, listTemplates, onTemplatesChange,
  putTemplate, removeTemplate, serverTemplateCache, templateHomeFor, templateStoreFor, templatesShared, validateTemplate,
} from '../src/template-store';

const sticky = (id: string): BaseObj => ({ id, type: 'sticky', x: 0, y: 0, w: 100, h: 80, rotation: 0, z: '1', text: id });
const content = (...ids: string[]): TemplateContent => ({ objects: ids.map(sticky), steps: [], bounds: { x: 0, y: 0, w: 100, h: 80 } });

/** The server as the backend sees it: templates in a map, every call logged, and a switch for the network. */
function fakeServer(initial: ServerTemplate[] = []) {
  const rows = new Map<string, ServerTemplate>(initial.map((t) => [t.id, t]));
  const calls: string[] = [];
  let seq = 0;
  let down = false;
  let inFlight = 0;
  let peak = 0;
  const info = (t: ServerTemplate): ServerTemplateInfo => {
    const { content: _content, ...rest } = t;
    return rest;
  };
  const gate = async <T>(name: string, run: () => T): Promise<T> => {
    calls.push(name);
    if (down) throw new ApiError(0, 'network', 'network');
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return run();
  };
  const api: TemplateApi = {
    listTemplates: () => gate('list', () => [...rows.values()].map(info)),
    getTemplate: (id) => gate(`get ${id}`, () => {
      const t = rows.get(id);
      if (!t) throw new ApiError(404, 'not_found', 'Template not found');
      return structuredClone(t);
    }),
    createTemplate: (input) => gate('create', () => {
      const t: ServerTemplate = {
        id: `srv${++seq}`, version: 1, name: input.name, category: input.category, description: input.description ?? '', scope: input.scope ?? 'personal',
        teamId: input.teamId ?? null, teamName: input.teamId ? 'Team' : null, createdBy: 'me', ownerName: 'Me', createdAt: 10 + seq, updatedAt: 10 + seq,
        objectCount: input.content.objects.length, stepCount: 0, canChange: true, content: input.content,
      };
      rows.set(t.id, t);
      return structuredClone(t);
    }),
    updateTemplate: (id, patch) => gate(`update ${id} ${Object.keys(patch).sort().join(',')}`, () => {
      const t = rows.get(id);
      if (!t) throw new ApiError(404, 'not_found', 'Template not found');
      if (!t.canChange) throw new ApiError(403, 'forbidden', 'Only the template owner can change it');
      const next = {
        ...t, ...patch, teamId: patch.scope === 'team' ? (patch.teamId ?? null) : patch.scope ? null : t.teamId, updatedAt: t.updatedAt + 1,
      } as ServerTemplate;
      rows.set(id, next);
      return structuredClone(next);
    }),
    duplicateTemplate: (id) => gate(`duplicate ${id}`, () => {
      const t = rows.get(id);
      if (!t) throw new ApiError(404, 'not_found', 'Template not found');
      const copy = { ...structuredClone(t), id: `srv${++seq}`, name: `${t.name} (copy)`, scope: 'personal' as const, teamId: null, canChange: true };
      rows.set(copy.id, copy);
      return structuredClone(copy);
    }),
    deleteTemplate: (id) => gate(`delete ${id}`, () => {
      if (!rows.delete(id)) throw new ApiError(404, 'not_found', 'Template not found');
    }),
  };
  return {
    api, rows, calls, setDown: (v: boolean) => void (down = v), peak: () => peak,
    seed: (t: ServerTemplate) => void rows.set(t.id, t),
    fetches: () => calls.filter((c) => c.startsWith('get ')),
  };
}

const server = (id: string, updatedAt: number, extra: Partial<ServerTemplate> = {}): ServerTemplate => ({
  id, version: 1, name: `Template ${id}`, category: 'Custom', description: '', scope: 'team', teamId: 'team1', teamName: 'Design', createdBy: 'other',
  ownerName: 'Bo', createdAt: updatedAt, updatedAt, objectCount: 1, stepCount: 0, canChange: false, content: content('a'), ...extra,
});

function backendOver(fake: ReturnType<typeof fakeServer>, deps: Partial<ServerBackendDeps> = {}) {
  const cache = deps.cache ?? memoryCache();
  let offline = false;
  const backend = serverBackend({ api: fake.api, cache, origin: () => 'https://tabula.example', offline: () => offline, ...deps });
  return { backend, cache, setOffline: (v: boolean) => void (offline = v), store: createTemplateStore(backend) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the server backend', () => {
  it('lists the templates with their content, fetched a few at a time', async () => {
    const fake = fakeServer(Array.from({ length: 10 }, (_, i) => server(`s${i}`, 100 + i)));
    const { store } = backendOver(fake);
    const list = await store.list();
    expect(list.map((t) => t.id)).toEqual(['s9', 's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1', 's0']);
    expect(list[0]).toMatchObject({ scope: 'team', teamId: 'team1', teamName: 'Design', ownerName: 'Bo', canChange: false, content: content('a') });
    expect(fake.fetches()).toHaveLength(10);
    expect(fake.peak()).toBeGreaterThan(1);
    expect(fake.peak()).toBeLessThanOrEqual(4);
  });

  it('fetches a template again only when it changed, and keeps what the list says about who may change it', async () => {
    const fake = fakeServer([server('a', 100), server('b', 200)]);
    const { store } = backendOver(fake);
    await store.list();
    expect(fake.fetches()).toHaveLength(2);
    await store.list();
    expect(fake.fetches()).toHaveLength(2);
    fake.seed(server('a', 150, { name: 'Edited', canChange: true }));
    const list = await store.list();
    expect(fake.fetches()).toHaveLength(3);
    expect(list.find((t) => t.id === 'a')).toMatchObject({ name: 'Edited', canChange: true });
    fake.seed({ ...server('b', 200), canChange: true, teamName: 'Renamed team' });
    expect((await store.list()).find((t) => t.id === 'b')).toMatchObject({ canChange: true, teamName: 'Renamed team' });
    expect(fake.fetches()).toHaveLength(3);
  });

  it('forgets templates that are gone from the server', async () => {
    const fake = fakeServer([server('a', 100), server('b', 200)]);
    const { store, cache } = backendOver(fake);
    await store.list();
    fake.rows.delete('a');
    expect((await store.list()).map((t) => t.id)).toEqual(['b']);
    expect((await cache.keys()).sort()).toEqual(['https://tabula.example|list', 'https://tabula.example|t|b']);
  });

  it('opens one template, and says so when it is gone', async () => {
    const fake = fakeServer([server('a', 100)]);
    const { store, cache } = backendOver(fake);
    expect((await store.get('a'))?.name).toBe('Template a');
    fake.rows.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(await cache.keys()).not.toContain('https://tabula.example|t|a');
  });

  describe('without the server', () => {
    it('lists and opens what was cached, with no request while the app knows it is offline', async () => {
      const fake = fakeServer([server('a', 100), server('b', 200)]);
      const { store, setOffline } = backendOver(fake);
      await store.list();
      await store.get('a');
      fake.calls.length = 0;
      setOffline(true);
      expect((await store.list()).map((t) => t.id).sort()).toEqual(['a', 'b']);
      expect((await store.get('b'))?.name).toBe('Template b');
      expect(await store.get('never-seen')).toBeUndefined();
      expect(fake.calls).toEqual([]);
    });

    it('falls back to the cache when the request fails', async () => {
      const fake = fakeServer([server('a', 100)]);
      const { store } = backendOver(fake);
      await store.list();
      fake.setDown(true);
      expect((await store.list()).map((t) => t.id)).toEqual(['a']);
      expect((await store.get('a'))?.id).toBe('a');
    });

    it('lists only the templates whose content is cached', async () => {
      const fake = fakeServer([server('a', 100), server('b', 200)]);
      const { store, cache } = backendOver(fake);
      await store.list();
      await cache.delete('https://tabula.example|t|b');
      fake.setDown(true);
      expect((await store.list()).map((t) => t.id)).toEqual(['a']);
    });

    it('refuses to save, change, duplicate or delete, with a clear message and no request', async () => {
      const fake = fakeServer([server('a', 100, { canChange: true })]);
      const { store, setOffline } = backendOver(fake);
      const t = (await store.list())[0];
      fake.calls.length = 0;
      setOffline(true);
      for (const run of [() => store.put({ ...t, name: 'x' }), () => store.put({ ...t, id: 'new' }), () => store.duplicate('a'), () => store.remove('a')]) {
        const error = await run().catch((e: Error) => e);
        expect(error).toBeInstanceOf(TemplateError);
        expect((error as Error).message).toBe(OFFLINE_MESSAGE);
      }
      expect(fake.calls).toEqual([]);
      expect(OFFLINE_MESSAGE).toContain('offline');
    });

    it('says the server could not be reached when a save fails on the network', async () => {
      const fake = fakeServer();
      const { store } = backendOver(fake);
      fake.setDown(true);
      await expect(store.put({ ...validateTemplate(base()), id: 'n1' })).rejects.toThrow('Could not reach the server');
    });
  });

  describe('the cache is tagged with the server it came from', () => {
    it('never uses what another origin left', async () => {
      const fake = fakeServer([server('a', 100)]);
      const cache = memoryCache();
      const first = backendOver(fake, { cache, origin: () => 'https://one.example' });
      await first.store.list();
      const second = backendOver(fake, { cache, origin: () => 'https://two.example' });
      fake.setDown(true);
      expect(await second.store.list()).toEqual([]);
      expect(await second.store.get('a')).toBeUndefined();
      expect((await first.store.list()).map((t) => t.id)).toEqual(['a']);
      expect((await cache.keys()).every((k) => k.startsWith('https://one.example|'))).toBe(true);
    });

    it('ignores a record whose tag does not match its key', async () => {
      const fake = fakeServer();
      const cache = memoryCache();
      await cache.put('https://tabula.example|list', { origin: 'https://evil.example', value: [server('a', 1)] });
      const { store } = backendOver(fake, { cache });
      fake.setDown(true);
      expect(await store.list()).toEqual([]);
    });

    it('keeps working when the cache cannot be written', async () => {
      const fake = fakeServer([server('a', 100, { canChange: true })]);
      const broken = { ...memoryCache(), put: () => Promise.reject(new Error('quota')), delete: () => Promise.reject(new Error('quota')), keys: () => Promise.reject(new Error('quota')) };
      const { store } = backendOver(fake, { cache: broken });
      const [t] = await store.list();
      expect((await store.put({ ...t, name: 'Renamed' })).name).toBe('Renamed');
      await store.remove('a');
    });
  });

  describe('saving', () => {
    it('creates a template the server does not know, and answers with the server\'s id and sharing', async () => {
      const fake = fakeServer();
      const { store } = backendOver(fake);
      const saved = await store.put({ ...validateTemplate(base()), id: 'client-id', scope: 'team', teamId: 'team1' });
      expect(saved).toMatchObject({ id: 'srv1', scope: 'team', teamId: 'team1', canChange: true });
      expect(fake.calls).toEqual(['create']);
      expect((await store.get('srv1'))?.name).toBe('Retro');
    });

    it('makes a template personal when nothing says otherwise', async () => {
      const fake = fakeServer();
      const { store } = backendOver(fake);
      expect((await store.put(validateTemplate(base()))).scope).toBe('personal');
    });

    it('updates a known template with only what changed', async () => {
      const fake = fakeServer([server('a', 100, { canChange: true, scope: 'personal', teamId: null, teamName: null })]);
      const { store } = backendOver(fake);
      const [t] = await store.list();
      fake.calls.length = 0;
      await store.put({ ...t, name: 'Renamed' });
      await store.put({ ...t, name: 'Renamed', category: 'Risk', description: 'Why' });
      await store.put({ ...t, name: 'Renamed', category: 'Risk', description: 'Why', content: content('a', 'b') });
      await store.put({ ...t, name: 'Renamed', category: 'Risk', description: 'Why', content: content('a', 'b'), scope: 'team', teamId: 'team2' });
      expect(fake.calls).toEqual([
        'update a name',
        'update a category,description',
        'update a content',
        'update a scope,teamId',
      ]);
    });

    it('sends no request for a save that changes nothing', async () => {
      const fake = fakeServer([server('a', 100, { canChange: true })]);
      const { store } = backendOver(fake);
      const [t] = await store.list();
      fake.calls.length = 0;
      expect((await store.put(t)).id).toBe('a');
      expect(fake.calls).toEqual([]);
    });

    it('moves the template to the server\'s answer, so a second save updates the same one', async () => {
      const fake = fakeServer();
      const { store } = backendOver(fake);
      const saved = await store.put(validateTemplate(base()));
      await store.put({ ...saved, name: 'Again' });
      expect(fake.calls).toEqual(['create', `update ${saved.id} name`]);
      expect(fake.rows.size).toBe(1);
    });

    it('shows the server\'s own message when it refuses, without a prefix', async () => {
      const fake = fakeServer([server('a', 100, { canChange: false })]);
      const { store } = backendOver(fake);
      const [t] = await store.list();
      const error = await store.put({ ...t, name: 'Mine now' }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(TemplateError);
      expect((error as Error).message).toBe('Only the template owner can change it');
    });

    it('says a template is gone when it was deleted elsewhere', async () => {
      const fake = fakeServer([server('a', 100, { canChange: true })]);
      const { store } = backendOver(fake);
      const [t] = await store.list();
      fake.rows.delete('a');
      await expect(store.put({ ...t, name: 'x' })).rejects.toThrow('That template is no longer available.');
    });
  });

  it('duplicates on the server and keeps the copy in the list', async () => {
    const fake = fakeServer([server('a', 100)]);
    const { store, cache } = backendOver(fake);
    const copy = await store.duplicate('a');
    expect(copy).toMatchObject({ name: 'Template a (copy)', scope: 'personal', teamId: null, canChange: true });
    expect(await cache.keys()).toContain(`https://tabula.example|t|${copy.id}`);
    await expect(store.duplicate('missing')).rejects.toThrow('That template is no longer available.');
  });

  it('deletes, and does not mind a template that is already gone', async () => {
    const fake = fakeServer([server('a', 100, { canChange: true })]);
    const { store } = backendOver(fake);
    await store.list();
    await store.remove('a');
    expect(fake.rows.size).toBe(0);
    await expect(store.remove('a')).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('tells other tabs about a change and hears them', async () => {
    const fake = fakeServer();
    const notify = vi.fn<() => void>();
    const heard: (() => void)[] = [];
    const { store } = backendOver(fake, { bus: { notify, onNotify: (fn) => (heard.push(fn), () => undefined) } });
    const seen = vi.fn<() => void>();
    store.onChange(seen);
    await store.put(validateTemplate(base()));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    heard[0]();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('checks everything the server sends before the app sees it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeServer([server('good', 100), server('bad', 200, { content: { objects: 'no' } as unknown as TemplateContent }), server('worse', 300, { name: '' })]);
    const { store } = backendOver(fake);
    expect((await store.list()).map((t) => t.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is the same as the template store the app uses: shared, with errors passed through', () => {
    expect(ExportedTemplateError).toBe(TemplateError);
    expect(backendOver(fakeServer()).store.shared).toBe(true);
    expect(createTemplateStore(null).shared).toBe(false);
  });
});

function base(): CustomTemplate {
  return {
    id: 'x', version: 1, name: 'Retro', category: 'Retrospective', description: '', createdBy: 'me', createdAt: 1, updatedAt: 1, content: content('a'),
  };
}

describe('the IndexedDB cache', () => {
  /** Just enough of IndexedDB: out-of-line keys, getAllKeys, clear. */
  function fakeIdb() {
    const stores = new Map<string, Map<string, unknown>>();
    const request = <T>(run: () => T) => {
      const r: { result?: T; onsuccess?: () => void } = {};
      queueMicrotask(() => {
        r.result = run();
        r.onsuccess?.();
      });
      return r;
    };
    const factory = {
      open() {
        const req: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void } = {};
        setTimeout(() => {
          req.result = {
            createObjectStore: (name: string) => void stores.set(name, new Map()),
            transaction: (name: string) => {
              const rows = stores.get(name)!;
              const tx: { oncomplete?: () => void; objectStore: () => unknown } = {
                objectStore: () => ({
                  get: (key: string) => request(() => rows.get(key)),
                  put: (value: unknown, key: string) => request(() => void rows.set(key, structuredClone(value))),
                  delete: (key: string) => request(() => void rows.delete(key)),
                  getAllKeys: () => request(() => [...rows.keys()]),
                  clear: () => request(() => void rows.clear()),
                }),
              };
              setTimeout(() => tx.oncomplete?.(), 0);
              return tx;
            },
          };
          if (!stores.size) req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    };
    return { factory: factory as unknown as IDBFactory, stores };
  }

  it('stores values under keys, lists the keys and clears them', async () => {
    const { factory, stores } = fakeIdb();
    const cache = indexedDbCache(factory);
    await cache.put('a', { n: 1 });
    await cache.put('b', { n: 2 });
    expect(await cache.get('a')).toEqual({ n: 1 });
    expect((await cache.keys()).sort()).toEqual(['a', 'b']);
    await cache.delete('a');
    expect(await cache.get('a')).toBeUndefined();
    await cache.clear();
    expect(await cache.keys()).toEqual([]);
    expect([...stores.keys()]).toEqual(['cache']);
  });

  it('lasts as long as the page where the browser has no IndexedDB', async () => {
    const cache = indexedDbCache(undefined);
    await cache.put('a', 1);
    expect(await cache.get('a')).toBe(1);
  });
});

describe('the seam between the browser and the server', () => {
  const me = (role: 'owner' | 'admin' | 'member' | 'guest' = 'member') => ({
    user: { id: 'u1', email: 'ana@example.com', name: 'Ana', role }, teams: [{ id: 'team1', name: 'Design', role: 'member' as const }],
  });
  const storage = new Map<string, string>();
  const storageStub = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  };

  afterEach(() => {
    vi.stubGlobal('localStorage', storageStub);
    setSignedOut();
    storage.clear();
  });

  it('keeps templates in the browser unless the person is signed in to a workspace', () => {
    for (const mode of ['unknown', 'open', 'signed-out'] as const) {
      expect(templateHomeFor(mode)).toBe('browser');
      expect(templateStoreFor(mode).shared).toBe(false);
      expect(templateStoreFor(mode)).toBe(browserTemplates());
    }
    for (const mode of ['signed-in', 'offline'] as const) {
      expect(templateHomeFor(mode)).toBe('server');
      expect(templateStoreFor(mode).shared).toBe(true);
      expect(templateStoreFor(mode)).toBe(templateStoreFor('signed-in'));
    }
    expect(templateStoreFor('signed-in')).not.toBe(browserTemplates());
  });

  it('sends the app\'s own calls to the one that fits the sign-in state', async () => {
    vi.stubGlobal('localStorage', storageStub);
    const seen: string[] = [];
    const served = [server('s1', 100, { canChange: true })];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      seen.push(`${init.method} ${url}`);
      const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/templates' && init.method === 'GET') return reply(served.map(({ content: _c, ...info }) => info));
      if (url === '/api/templates/s1' && init.method === 'GET') return reply(served[0]);
      if (url === '/api/templates/s1' && init.method === 'DELETE') return new Response(null, { status: 204 });
      if (url === '/api/templates/s1/duplicate') return reply({ ...served[0], id: 's2', scope: 'personal', teamId: null }, 201);
      return reply({ error: 'not_found' }, 404);
    });

    expect(templatesShared()).toBe(false);
    expect(await listTemplates()).toEqual([]);
    expect(seen).toEqual([]);

    await setSignedIn({ ...me(), user: me().user });
    expect(templatesShared()).toBe(true);
    expect((await listTemplates()).map((t) => t.id)).toEqual(['s1']);
    expect((await getTemplate('s1'))?.name).toBe('Template s1');
    expect((await duplicateSavedTemplate('s1')).id).toBe('s2');
    await removeTemplate('s1');
    expect(seen).toEqual(['GET /api/templates', 'GET /api/templates/s1', 'GET /api/templates/s1', 'POST /api/templates/s1/duplicate', 'DELETE /api/templates/s1']);
    await expect(putTemplate({ ...base(), id: 's1' })).rejects.toBeInstanceOf(Error);

    setSignedOut();
    expect(templatesShared()).toBe(false);
    expect(await listTemplates()).toEqual([]);
  });

  it('forgets what the server\'s templates left in the browser, and what the store knew, when the person signs out', async () => {
    vi.stubGlobal('localStorage', storageStub);
    await setSignedIn({ ...me(), user: me().user });
    const before = templateStoreFor('signed-in');
    await serverTemplateCache.put('https://tabula.example|t|a', { origin: 'https://tabula.example', value: server('a', 1) });
    expect(await serverTemplateCache.keys()).toEqual(['https://tabula.example|t|a']);
    setSignedOut();
    await vi.waitFor(async () => expect(await serverTemplateCache.keys()).toEqual([]));
    expect(templateStoreFor('signed-in')).not.toBe(before);
  });

  it('tells a subscriber when signing in or out moves the templates to the other place', async () => {
    vi.stubGlobal('localStorage', storageStub);
    const seen = vi.fn<() => void>();
    const off = onTemplatesChange(seen);
    await setSignedIn({ ...me(), user: me().user });
    expect(seen).toHaveBeenCalledTimes(1);
    await setSignedIn({ ...me(), user: me().user });
    expect(seen).toHaveBeenCalledTimes(1);
    setSignedOut();
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    await setSignedIn({ ...me(), user: me().user });
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
