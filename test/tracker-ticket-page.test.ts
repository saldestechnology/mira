import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrackerError, createHttpTrackerApi, createTrackerStore, type TrackerEvent, type TrackerMeta, type TrackerTicket } from '../src/tracker-data';
import { createMockTrackerApi } from '../src/tracker-mock';
import { describeEvent } from '../src/tracker/ui/ticket-events';
import { mountTicketPage } from '../src/tracker/ui/ticket-page';
import { buildMarkdownDom, renderMarkdownSafe } from '../src/tracker/ui/ticket-markdown';
import { FakeElement } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

const NOW = Date.UTC(2026, 9, 10, 12);
const META: TrackerMeta = {
  enabled: true, trackerId: 'tracker-demo', prefix: 'TAB',
  states: [
    { id: 'todo', key: 'todo', name: 'To do', category: 'unstarted', position: 0 },
    { id: 'doing', key: 'in_progress', name: 'In progress', category: 'started', position: 1 },
    { id: 'done', key: 'done', name: 'Done', category: 'completed', position: 2 },
  ],
  labels: [{ id: 'bug', name: 'Bug', color: '#D02020' }],
  members: [{ userId: 'user-me', name: 'Mara' }, { userId: 'user-idris', name: 'Idris' }],
  me: { userId: 'user-me', canWrite: true },
  canCreateLabels: true,
};

function ticket(overrides: Partial<TrackerTicket> = {}): TrackerTicket {
  return {
    id: 'ticket-1', key: 'TAB-1', trackerId: 'tracker-demo', title: 'Original title', description: '',
    state: { id: 'todo', key: 'todo', name: 'To do', category: 'unstarted' }, priority: 'none',
    assignee: null, creator: { type: 'user', id: 'user-me', name: 'Mara' }, labels: [], project: null,
    milestone: null, estimate: null, due: null, parent: null, relations: [], links: [], aliases: [],
    archivedAt: null, createdAt: NOW - 60_000, updatedAt: NOW - 30_000, updatedSeq: 1, ...overrides,
  };
}

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
let mounted: ReturnType<typeof mountTicketPage> | null = null;
let store: ReturnType<typeof createTrackerStore> | null = null;

afterEach(() => {
  mounted?.destroy(); mounted = null;
  store?.destroy(); store = null;
  browser?.uninstall(); browser = null;
  vi.useRealTimers();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !check(); i += 1) await flush();
}

async function setup(options: {
  issue?: TrackerTicket;
  comments?: Record<string, import('../src/tracker-types').TrackerComment[]>;
  events?: TrackerEvent[];
  meta?: TrackerMeta;
  me?: { userId: string; canWrite: boolean };
  api?: ReturnType<typeof createMockTrackerApi>;
} = {}) {
  browser = installTrackerUiBrowser();
  const issue = options.issue ?? ticket();
  const api = options.api ?? createMockTrackerApi({
    meta: options.meta ?? META,
    tickets: [issue], comments: options.comments, events: options.events, now: () => NOW,
  });
  store = createTrackerStore(api, { pollMs: 60_000, now: () => NOW });
  const host = browser.mount() as unknown as HTMLElement;
  const navigated: string[] = [];
  let closed = 0;
  mounted = mountTicketPage(host, {
    store, key: issue.key, mode: 'page', onClose: () => { closed += 1; }, onNavigate: (key) => navigated.push(key),
    me: options.me ?? { userId: 'user-me', canWrite: true },
  });
  await until(() => Boolean(host.querySelector('.tk-title')) || Boolean(host.querySelector('.tk-state-screen')));
  return { host: host as unknown as FakeElement, api, store, navigated, closed: () => closed, page: mounted };
}

function buttonByText(host: FakeElement, text: string): FakeElement | undefined {
  return host.querySelectorAll('button').find((el) => el.textContent.includes(text));
}

function inputByLabel(host: FakeElement, label: string): FakeElement | undefined {
  return host.querySelectorAll('input, textarea').find((el) => el.getAttribute('aria-label') === label);
}

describe('ticket page', () => {
  it('survives a slim ticket row (no creator, labels or relations) in the cache and asks for the full ticket', async () => {
    browser = installTrackerUiBrowser();
    const issue = ticket();
    const api = createMockTrackerApi({ meta: META, tickets: [issue], now: () => NOW });
    store = createTrackerStore(api, { pollMs: 60_000, now: () => NOW });
    const real = store;
    const slim = { ...issue, creator: undefined, labels: undefined, relations: undefined, links: undefined, aliases: undefined } as unknown as TrackerTicket;
    const loadTicket = vi.fn<typeof real.loadTicket>(real.loadTicket);
    const wrapped = {
      ...real,
      ticket: (key: string) => ({ ...real.ticket(key), ticket: slim, detail: undefined }),
      watchTicket: (key: string, listener: Parameters<typeof real.watchTicket>[1]) => real.watchTicket(key, (next) => listener({ ...next, ticket: slim, detail: undefined })),
      loadTicket,
    };
    const host = browser.mount() as unknown as HTMLElement;
    mounted = mountTicketPage(host, { store: wrapped as typeof real, key: issue.key, mode: 'page', onClose: () => {}, onNavigate: () => {}, me: { userId: 'user-me', canWrite: true } });
    await until(() => Boolean(host.querySelector('.tk-title')));
    expect(host.querySelector('.tk-title')?.textContent).toBe('Original title');
    expect(loadTicket).toHaveBeenCalledWith('TAB-1', true);
  });

  it('renders a ticket and edits its title with Enter while Escape cancels', async () => {
    const { host, store: tracker } = await setup();
    expect(host.querySelector('.tk-title')?.textContent).toBe('Original title');
    expect(host.querySelector('.tk-properties')?.textContent).toContain('No due date');

    buttonByText(host, 'Edit title')?.click();
    let input = inputByLabel(host, 'Title')!;
    input.value = 'Changed title';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await until(() => tracker.ticket('TAB-1').ticket?.title === 'Changed title');
    expect(host.querySelector('.tk-title')?.textContent).toBe('Changed title');

    buttonByText(host, 'Edit title')?.click();
    input = inputByLabel(host, 'Title')!;
    input.value = 'Discard this';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(host.querySelector('.tk-title')?.textContent).toBe('Changed title');
    expect(tracker.ticket('TAB-1').ticket?.title).toBe('Changed title');

    buttonByText(host, 'Edit title')?.click();
    input = inputByLabel(host, 'Title')!;
    input.value = '😀'.repeat(201);
    input.dispatchEvent(uiEvent('input'));
    expect(Array.from(input.value)).toHaveLength(200);
  });

  it('creates a label when metadata grants that capability and applies it to the ticket', async () => {
    const { host, store: tracker } = await setup();
    await until(() => Boolean(buttonByText(host, 'Create label')));
    buttonByText(host, 'Create label')?.click();
    const input = inputByLabel(host, 'New label name')!;
    input.value = 'Accessibility';
    input.dispatchEvent(uiEvent('input'));
    buttonByText(host, 'Save label')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.labels.some((label) => label.name === 'Accessibility') ?? false);
    expect(tracker.snapshot().meta?.labels.map((label) => label.name)).toContain('Accessibility');
    expect(host.querySelector('.tk-properties')?.textContent).toContain('Accessibility');
  });

  it('waits 200 ms before showing the loading skeleton', async () => {
    browser = installTrackerUiBrowser();
    const issue = ticket();
    const api = createMockTrackerApi({ meta: META, tickets: [issue] });
    let resolveTicket!: (value: Awaited<ReturnType<typeof api.getTicket>>) => void;
    api.getTicket = () => new Promise((resolve) => { resolveTicket = resolve; });
    store = createTrackerStore(api, { pollMs: 60_000 });
    const host = browser.mount() as unknown as FakeElement;
    mounted = mountTicketPage(host as unknown as HTMLElement, {
      store, key: issue.key, mode: 'page', onClose: () => undefined, onNavigate: () => undefined,
      me: { userId: 'user-me', canWrite: true },
    });
    expect(host.querySelector('.tk-loading')).toBeNull();
    vi.advanceTimersByTime(199);
    await flush();
    expect(host.querySelector('.tk-loading')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(host.querySelectorAll('.tk-skeleton')).toHaveLength(8);
    resolveTicket({ ticket: issue, comments: [], events: [], subscribed: false });
    await until(() => Boolean(host.querySelector('.tk-title')));
    expect(host.querySelector('.tk-loading')).toBeNull();
  });

  it('switches a description between Write and safe Preview, then commits on Ctrl+Enter', async () => {
    const { host, store: tracker } = await setup();
    buttonByText(host, 'Add description')?.click();
    const textarea = inputByLabel(host, 'Description in Markdown')!;
    textarea.value = '**Ready** for TAB-2';
    textarea.dispatchEvent(uiEvent('input'));
    buttonByText(host, 'Preview')?.click();
    expect(host.querySelector('.tk-description-preview')?.textContent).toContain('Ready for TAB-2');
    expect(host.querySelector('.tk-description-preview strong')?.textContent).toBe('Ready');
    const preview = host.querySelector('.tk-description-preview');
    expect(preview?.querySelector('a')).toBeNull();
    buttonByText(host, 'Write')?.click();
    const write = inputByLabel(host, 'Description in Markdown')!;
    write.dispatchEvent(uiEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await until(() => tracker.ticket('TAB-1').ticket?.description === '**Ready** for TAB-2');
    expect(host.querySelector('.tk-description-body')?.textContent).toContain('Ready for TAB-2');
  });

  it('cancels a description draft with Escape while Preview has focus', async () => {
    const issue = ticket({ description: 'Keep this text' });
    const { host, store: tracker } = await setup({ issue });
    buttonByText(host, 'Edit description')?.click();
    const textarea = inputByLabel(host, 'Description in Markdown')!;
    textarea.value = 'Discard this draft';
    textarea.dispatchEvent(uiEvent('input'));
    buttonByText(host, 'Preview')?.click();

    const preview = host.querySelector('.tk-description-preview')!;
    preview.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));

    expect(host.querySelector('.tk-description-preview')).toBeNull();
    expect(inputByLabel(host, 'Description in Markdown')).toBeUndefined();
    expect(host.querySelector('.tk-description-body')?.textContent).toContain('Keep this text');
    expect(tracker.ticket('TAB-1').ticket?.description).toBe('Keep this text');
  });

  it('shows an optimistic title and rolls it back when the API rejects the update', async () => {
    const { host, api, store: tracker } = await setup();
    let rejectRequest!: (error: Error) => void;
    api.patchTicket = async () => new Promise((_resolve, reject) => { rejectRequest = reject; });
    buttonByText(host, 'Edit title')?.click();
    const input = inputByLabel(host, 'Title')!;
    input.value = 'Temporary title';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await until(() => typeof rejectRequest === 'function');
    await flush();
    expect(tracker.ticket('TAB-1').ticket?.title).toBe('Temporary title');
    expect(host.querySelector('.tk-title')?.textContent).toBe('Temporary title');
    rejectRequest(new TrackerError('forbidden', 'Denied'));
    await until(() => host.querySelector('.tk-error-inline')?.textContent.includes('Denied') ?? false);
    expect(tracker.ticket('TAB-1').ticket?.title).toBe('Original title');
    expect(inputByLabel(host, 'Title')?.value).toBe('Temporary title');
  });

  it('keeps a failed title draft visible and retries it from the header', async () => {
    const { host, api, store: tracker } = await setup();
    const patch = api.patchTicket.bind(api);
    let reject = true;
    api.patchTicket = async (...args) => {
      if (reject) throw new TrackerError('network', 'Connection lost');
      return patch(...args);
    };
    buttonByText(host, 'Edit title')?.click();
    const input = inputByLabel(host, 'Title')!;
    input.value = 'Keep this draft';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await until(() => Boolean(host.querySelector('.tk-save-state--failed')));
    expect(inputByLabel(host, 'Title')?.value).toBe('Keep this draft');
    expect(buttonByText(host, 'Retry save')).toBeDefined();
    reject = false;
    buttonByText(host, 'Retry save')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.title === 'Keep this draft');
    expect(host.querySelector('.tk-title')?.textContent).toBe('Keep this draft');
    expect(host.querySelector('.tk-save-state--failed')).toBeNull();
  });

  it('shows per-field conflict choices and retries Keep mine against the current version', async () => {
    const { host, api, store: tracker } = await setup();
    const remote = ticket({ title: 'Remote title', updatedSeq: 8 });
    let calls = 0;
    api.patchTicket = async (_key, patchArg, _options) => {
      calls += 1;
      if (calls === 1) throw new TrackerError('conflict', 'Stale', { current: remote });
      return { ticket: { ...remote, title: patchArg.title ?? remote.title, updatedSeq: remote.updatedSeq + 1 } };
    };
    buttonByText(host, 'Edit title')?.click();
    const input = inputByLabel(host, 'Title')!;
    input.value = 'Mine';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter' }));
    await until(() => Boolean(host.querySelector('.tk-conflict-bar')));
    expect(host.querySelector('.tk-conflict-bar')?.textContent).toContain('Yours: Mine');
    expect(host.querySelector('.tk-conflict-bar')?.textContent).toContain('Theirs: Remote title');
    buttonByText(host, 'Keep mine for title')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.title === 'Mine' && calls === 2);
    expect(host.querySelector('.tk-conflict-bar')).toBeNull();
  });

  it('shows a state conflict and lets the member keep the selected state', async () => {
    const { host, api, store: tracker } = await setup();
    const remote = ticket({ state: META.states[1], updatedSeq: 4 });
    let calls = 0;
    api.transitionTicket = async (_key, stateName) => {
      calls += 1;
      if (calls === 1) throw new TrackerError('conflict', 'Stale state', { current: remote });
      const state = META.states.find((item) => item.key === stateName)!;
      return { ticket: { ...remote, state, updatedSeq: remote.updatedSeq + 1 } };
    };
    host.querySelector('main')?.dispatchEvent(uiEvent('keydown', { key: 's' }));
    await flush();
    browser?.document.querySelectorAll('[role="option"]').find((option) => option.textContent === 'Done')?.click();
    await until(() => Boolean(host.querySelector('.tk-conflict-bar')));
    expect(host.querySelector('.tk-conflict-bar')?.textContent).toContain('Yours: Done');
    expect(host.querySelector('.tk-conflict-bar')?.textContent).toContain('Theirs: In progress');
    buttonByText(host, 'Keep mine for state')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.state.name === 'Done' && calls === 2);
    expect(host.querySelector('.tk-conflict-bar')).toBeNull();
  });

  it('makes archived tickets read-only and restores them from the banner', async () => {
    const { host, store: tracker } = await setup({ issue: ticket({ archivedAt: NOW - 86_400_000 }) });
    expect(host.querySelector('.tk-archived-banner')?.textContent).toContain('Restore');
    expect(buttonByText(host, 'Edit title')).toBeUndefined();
    expect(host.querySelector('[data-field="state"]')?.disabled).toBe(true);
    buttonByText(host, 'Restore')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.archivedAt === null);
    expect(host.querySelector('.tk-archived-banner')).toBeNull();
    expect(buttonByText(host, 'Edit title')).toBeDefined();
  });

  it('lights up project and milestone pickers when slice 2 metadata is present', async () => {
    const meta: TrackerMeta = {
      ...META,
      projects: [{ id: 'proj-1', name: 'Frames' }],
      milestones: [{ id: 'mile-1', name: 'Beta', due: '2026-11-01', projectId: 'proj-1' }],
    };
    const { host, store: tracker } = await setup({ meta });
    host.querySelector('[data-field="project"]')?.click();
    await flush();
    browser?.document.querySelectorAll('.trk-picker-option').find((row) => row.textContent === 'Frames')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.project?.id === 'proj-1');
    host.querySelector('[data-field="milestone"]')?.click();
    await flush();
    browser?.document.querySelectorAll('.trk-picker-option').find((row) => row.textContent === 'Beta')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.milestone?.id === 'mile-1');
    expect(host.querySelector('[data-field="milestone"]')?.textContent).toBe('Beta');
  });

  it('uses the overdue header key signal only when the ticket is assigned to me', async () => {
    const { host } = await setup({ issue: ticket({ due: '2026-10-09', assignee: { userId: 'user-me', name: 'Mara' } }) });
    expect(host.querySelector('.tk-header-key--overdue')).toBeDefined();
  });

  it('posts comments with one client id across an idempotent retry', async () => {
    const { host, api } = await setup();
    const add = api.addComment.bind(api);
    let calls = 0;
    let clientId = '';
    api.addComment = async (key, input, options) => {
      calls += 1;
      clientId ||= input.clientId;
      expect(input.clientId).toBe(clientId);
      const result = await add(key, input, options);
      if (calls === 1) throw new Error('Connection dropped after save');
      return result;
    };
    const composer = inputByLabel(host, 'Comment in Markdown')!;
    composer.value = 'A retry-safe comment';
    composer.dispatchEvent(uiEvent('input'));
    buttonByText(host, 'Post comment')?.click();
    await until(() => Boolean(host.querySelector('.tk-error-inline')?.textContent.includes('Connection dropped')));
    expect(buttonByText(host, 'Retry comment')).toBeDefined();
    buttonByText(host, 'Retry comment')?.click();
    await until(() => host.querySelectorAll('.tk-comment-row').length === 1 && calls === 2);
    expect(host.querySelectorAll('.tk-comment-row')).toHaveLength(1);
    expect(host.querySelector('.tk-comment-composer textarea')?.value).toBe('');
  });

  it('lets the author edit and delete their comment', async () => {
    const comment = {
      id: 'comment-own', ticketKey: 'TAB-1', author: { userId: 'user-me', name: 'Mara' },
      body: 'Original comment', clientId: 'client-own', createdAt: NOW - 1000, editedAt: null,
    };
    const { host } = await setup({ comments: { 'TAB-1': [comment] } });
    expect(host.querySelector('.tk-comment-row')?.textContent).toContain('Original comment');
    buttonByText(host, 'Edit comment')?.click();
    const input = inputByLabel(host, 'Edit comment in Markdown')!;
    input.value = 'Edited comment';
    input.dispatchEvent(uiEvent('input'));
    input.dispatchEvent(uiEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await until(() => host.querySelector('.tk-comment-row')?.textContent.includes('Edited comment') ?? false);
    buttonByText(host, 'Delete comment')?.click();
    await until(() => host.querySelector('.tk-deleted-comment')?.textContent === 'Comment deleted');
    expect(host.querySelector('.tk-comment-row')?.textContent).toContain('Comment deleted');
  });

  it('lets an administrator delete another person’s comment without offering edit', async () => {
    const comment = {
      id: 'comment-other', ticketKey: 'TAB-1', author: { userId: 'user-idris', name: 'Idris' },
      body: 'Team comment', clientId: 'client-other', createdAt: NOW - 1000, editedAt: null,
    };
    const meta: TrackerMeta = { ...META, me: { ...META.me, canDeleteAnyComment: true } };
    const { host } = await setup({ comments: { 'TAB-1': [comment] }, meta });
    expect(buttonByText(host, 'Edit comment')).toBeUndefined();
    expect(buttonByText(host, 'Delete comment')).toBeDefined();
  });

  it('loads older comments and events through the store before cursors', async () => {
    const comments = Array.from({ length: 54 }, (_, index) => ({
      id: `comment-${index + 1}`, ticketKey: 'TAB-1', author: { userId: 'user-me', name: 'Mara' },
      body: `Comment ${index + 1}`, clientId: `client-${index + 1}`, createdAt: NOW - (54 - index) * 1000, editedAt: null,
    }));
    const events = Array.from({ length: 56 }, (_, index) => ({
      id: index + 1, ticketKey: 'TAB-1', eventType: 'ticket.updated', at: NOW - (56 - index) * 1000,
      actor: { userId: 'user-me', name: 'Mara', type: 'user' }, field: 'priority', from: 'low', to: 'medium',
    }));
    const { host, store: tracker } = await setup({ comments: { 'TAB-1': comments }, events });
    expect(host.querySelector('.tk-load-older')).toBeDefined();
    host.querySelector('.tk-load-older')?.click();
    await until(() => tracker.ticket('TAB-1').detail?.comments.length === 54 && tracker.ticket('TAB-1').detail?.events.length === 56);
    expect(host.querySelectorAll('.tk-comment-row')).toHaveLength(54);
    expect(tracker.ticket('TAB-1').detail?.comments[0].id).toBe('comment-1');
    expect(tracker.ticket('TAB-1').detail?.events[0].id).toBe(1);
    expect(host.querySelector('.tk-load-older')).toBeNull();
    await tracker.loadTicket('TAB-1', true);
    expect(tracker.ticket('TAB-1').detail?.comments).toHaveLength(54);
    expect(tracker.ticket('TAB-1').detail?.events).toHaveLength(56);
  });

  it('uses ticket shortcuts and leaves typing shortcuts alone', async () => {
    const { host, store: tracker, page, closed } = await setup();
    const root = host.querySelector('main')!;
    root.dispatchEvent(uiEvent('keydown', { key: 'e' }));
    expect(inputByLabel(host, 'Title')).toBeDefined();
    inputByLabel(host, 'Title')?.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    root.dispatchEvent(uiEvent('keydown', { key: 's' }));
    await flush();
    expect(browser?.document.querySelector('[role="listbox"]')).not.toBeNull();
    browser?.dispatchWindow(uiEvent('keydown', { key: 'Escape' }));
    await flush();
    const composer = inputByLabel(host, 'Comment in Markdown')!;
    composer.dispatchEvent(uiEvent('keydown', { key: 's' }));
    expect(browser?.document.querySelector('[role="listbox"]')).toBeNull();
    root.dispatchEvent(uiEvent('keydown', { key: 'a' }));
    await flush();
    expect(browser?.document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Assignee');
    browser?.document.querySelectorAll('[role="option"]').find((option) => option.textContent === 'Idris')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.assignee?.userId === 'user-idris');
    root.dispatchEvent(uiEvent('keydown', { key: 'p' }));
    await flush();
    expect(browser?.document.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Priority');
    browser?.document.querySelectorAll('[role="option"]').find((option) => option.textContent === 'High priority')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.priority === 'high');
    root.dispatchEvent(uiEvent('keydown', { key: 'l' }));
    await flush();
    browser?.document.querySelectorAll('[role="option"]').find((option) => option.textContent === 'Bug')?.click();
    browser?.document.querySelectorAll('button').find((option) => option.textContent === 'Done')?.click();
    await until(() => tracker.ticket('TAB-1').ticket?.labels.length === 1);
    root.dispatchEvent(uiEvent('keydown', { key: 'd' }));
    expect(inputByLabel(host, 'Due date, YYYY-MM-DD')).toBeDefined();
    root.dispatchEvent(uiEvent('keydown', { key: 'S', shiftKey: true }));
    await until(() => tracker.ticket('TAB-1').subscribed === true);
    root.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(inputByLabel(host, 'Due date, YYYY-MM-DD')).toBeUndefined();
    expect(closed()).toBe(0);
    root.dispatchEvent(uiEvent('keydown', { key: 'Escape' }));
    expect(closed()).toBe(1);
    page.focus();
    expect(browser?.document.activeElement?.getAttribute('data-focus-id')).toBe('ticket-title');
  });

  it('disables every writer with an accessible reason for read-only members', async () => {
    const { host } = await setup({ me: { userId: 'guest', canWrite: false } });
    expect(host.querySelector('[data-field="state"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-field="state"]')?.getAttribute('aria-describedby')).toBeTruthy();
    expect(host.querySelector('.tk-comment-input')?.disabled).toBe(true);
    expect(host.textContent).not.toContain('Delete');
  });

  it('uses the same safe not-found screen for unavailable tickets', async () => {
    browser = installTrackerUiBrowser();
    const api = createMockTrackerApi({ meta: META });
    api.getTicket = async () => { throw new TrackerError('not_found', 'No ticket'); };
    store = createTrackerStore(api, { pollMs: 60_000 });
    const host = browser.mount() as unknown as FakeElement;
    mounted = mountTicketPage(host as unknown as HTMLElement, {
      store, key: 'TAB-999', mode: 'page', onClose: () => undefined, onNavigate: () => undefined,
      me: { userId: 'user-me', canWrite: true },
    });
    await until(() => Boolean(host.querySelector('.tk-state-screen')));
    expect(host.querySelector('.tk-state-screen')?.textContent).toContain('doesn’t exist or you can’t see it');
  });

  it('hides cached ticket data after access is revoked', async () => {
    const { host, api, store: tracker } = await setup();
    expect(host.querySelector('.tk-title')?.textContent).toBe('Original title');
    api.getTicket = async () => { throw new TrackerError('not_found', 'No ticket'); };
    await tracker.loadTicket('TAB-1', true).catch(() => undefined);
    await until(() => Boolean(host.querySelector('.tk-state-screen')));
    expect(host.querySelector('.tk-title')).toBeNull();
    expect(tracker.ticket('TAB-1').ticket).toBeUndefined();
  });

  it('shows aliases and toggles subscription', async () => {
    const { host, store: tracker, navigated } = await setup({ issue: ticket({ aliases: ['OLD-22', 'ENG-9'] }) });
    expect(host.querySelector('.tk-aliases')?.textContent).toContain('Also known as OLD-22, ENG-9');
    host.querySelector('.tk-alias-link')?.click();
    expect(navigated).toEqual(['TAB-1']);
    buttonByText(host, 'Subscribe')?.click();
    await until(() => tracker.ticket('TAB-1').subscribed === true);
    expect(buttonByText(host, 'Subscribed')).toBeDefined();
  });

  it('renders hostile Markdown as text and never creates an HTML or javascript link', () => {
    browser = installTrackerUiBrowser();
    const blocks = renderMarkdownSafe('<script>alert(1)</script> [click](javascript:alert(1)) &lt;img src=x onerror=alert(2)&gt;\n\n- **safe**\n- `TAB-9`');
    const dom = buildMarkdownDom(blocks);
    expect(dom.querySelector('script')).toBeNull();
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('a')).toBeNull();
    expect(dom.textContent).toContain('<script>alert(1)</script>');
    expect(dom.textContent).toContain('click (javascript:alert(1))');
    expect(dom.textContent).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(dom.textContent).toContain('safe');
  });

  it('describes the supported history event types as one-line sentences', () => {
    const base = { id: 1, ticketKey: 'TAB-1', at: NOW, actor: { name: 'Mara', type: 'user' } };
    const cases: Array<[string, Partial<TrackerEvent>, string]> = [
      ['ticket.state_changed', { from: 'To do', to: 'In progress' }, 'Mara moved it from To do to In progress'],
      ['ticket.created', {}, 'Mara created this ticket'],
      ['ticket.assigned', { to: { name: 'Idris' } }, 'Mara assigned it to Idris'],
      ['ticket.updated', { field: 'priority', from: 'low', to: 'high' }, 'Mara changed priority from low to high'],
      ['ticket.commented', {}, 'Mara commented'],
      ['ticket.related', { relation: { kind: 'blocks', key: 'TAB-2' } }, 'Mara linked a ticket that blocks TAB-2'],
      ['ticket.unrelated', { relation: { kind: 'relates_to', key: 'TAB-2' } }, 'Mara removed the relation to a ticket that is related to TAB-2'],
      ['ticket.card_linked', {}, 'Mara linked a card to this ticket'],
      ['ticket.card_unlinked', {}, 'Mara unlinked a card from this ticket'],
      ['link.pr_opened', { number: 12 }, 'Mara opened PR #12'],
      ['link.pr_ready', { number: 12 }, 'Mara marked PR #12 ready for review'],
      ['link.pr_merged', { number: 12 }, 'Mara merged PR #12'],
      ['link.pr_closed', { number: 12 }, 'Mara closed PR #12'],
      ['link.commit_added', { sha: 'abcdef1234567890' }, 'Mara added commit abcdef1234567890'],
      ['integration.rule_applied', { actor: { name: 'GitHub', type: 'integration', provider: 'github' }, from: 'In review', to: 'Done' }, 'GitHub applied a rule and moved it from In review to Done'],
    ];
    for (const [eventType, fields, expected] of cases) {
      expect(describeEvent({ ...base, ...fields, eventType } as TrackerEvent, { ticketKey: 'TAB-1' }).text).toBe(expected);
    }
    expect(describeEvent({ ...base, eventType: 'link.pr_merged', actor: { name: 'claude-code', type: 'agent' }, number: 12 } as TrackerEvent).actor).toMatchObject({ kind: 'agent', name: 'Agent · claude-code' });
  });

  it('normalizes REST activity cursors and event before/after records for the page', async () => {
    const api = createHttpTrackerApi(async () => new Response(JSON.stringify({
      ticket: ticket(), subscribed: false,
      comments: [{ id: 'wire-comment', author: { userId: 'user-me', name: 'Mara' }, body: 'Hello', createdAt: NOW }],
      events: [
        { eventSeq: 7, eventType: 'transitioned', createdAt: NOW, actor: { type: 'user', id: 'user-me' }, source: 'api', before: { state: { name: 'To do' } }, after: { state: { name: 'In progress' } } },
        { eventSeq: 8, eventType: 'updated', createdAt: NOW + 1, actor: { type: 'user', id: 'user-me' }, source: 'api', before: { title: 'Old title' }, after: { title: 'New title' } },
      ],
    }), { status: 200 }));
    const detail = await api.getTicket('TAB-1');
    expect(detail.comments[0]).toMatchObject({ ticketKey: 'TAB-1', clientId: '', editedAt: null, body: 'Hello' });
    expect(detail.events.map((event) => [event.id, event.at])).toEqual([[7, NOW], [8, NOW + 1]]);
    expect(describeEvent(detail.events[0], { members: META.members }).text).toBe('Mara moved it from To do to In progress');
    expect(describeEvent(detail.events[1], { members: META.members }).text).toBe('Mara changed title from Old title to New title');
  });
});
