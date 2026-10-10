import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestJoin } from '../src/api';
import { ApiError } from '../src/api';
import { FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  joinWithCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  setGuest: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    api: { ...actual.api, joinWithCode: (...args: unknown[]) => mocks.joinWithCode(...args) },
  };
});
vi.mock('../src/auth', () => ({ setGuest: (...args: unknown[]) => mocks.setGuest(...args) }));

const { renderJoin } = await import('../src/ui/join');

let browser: FakeBrowser;

beforeEach(() => {
  browser = installFakeBrowser();
  mocks.joinWithCode.mockReset();
  mocks.setGuest.mockReset();
});

afterEach(() => {
  browser.uninstall();
  vi.unstubAllGlobals();
});

function stubJoinHistory(search: string, hash = '#section') {
  const state = { page: 'join', preserved: true };
  const replaceState = vi.fn<(nextState: unknown, title: string, url?: string | URL) => void>();
  const history = { state, replaceState };
  Object.assign(browser.location, { pathname: '/join', search, hash, hostname: 'boards.example' });
  vi.stubGlobal('history', history);
  Object.assign(window, { location: browser.location, history });
  return { state, replaceState };
}

describe('join page validation', () => {
  it('keeps pasted codes intact through normalization and exposes the visible field names', async () => {
    const guest: GuestJoin = { boardId: 'board-1', role: 'commenter', name: 'Rae', guestId: 'guest-1', expiresAt: 1 };
    mocks.joinWithCode.mockResolvedValue(guest);
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    const code = need(root, 'input[name="code"]');
    const name = need(root, 'input[name="name"]');

    expect(code.getAttribute('maxlength')).toBeNull();
    expect(need(root, 'label[for="join-code"]').textContent).toBe('Join code');
    expect(code.getAttribute('aria-label')).toBe('Join code');
    expect(need(root, 'label[for="join-name"]').textContent).toBe('Display name');
    expect(name.getAttribute('aria-label')).toBe('Display name');

    code.value = ' abc ';
    code.dispatchEvent(new FakeEvent('input'));
    name.value = '  Rae  ';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    const codeError = need(root, '#join-code-error');
    expect(codeError.textContent).toBe('That code looks too short');
    expect(codeError.hidden).toBe(false);
    expect(codeError.getAttribute('role')).toBe('alert');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(code);
    expect(mocks.joinWithCode).not.toHaveBeenCalled();

    code.value = '  abcd efghijkl  ';
    code.dispatchEvent(new FakeEvent('input'));
    expect(code.value).toBe('ABCDEFGH');
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    // the client now sends the cleaned name, and the server cleans it as well.
    expect(mocks.joinWithCode).toHaveBeenCalledWith('ABCDEFGH', 'Rae');
  });

  it('sets the name limit and gives friendly feedback for cleaned empty and overlong names', async () => {
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, 'ABCDEF', vi.fn<(value: GuestJoin) => void>());
    const name = need(root, 'input[name="name"]');
    expect(name.getAttribute('maxlength')).toBe('40');

    name.value = '\u0000\u200B\u2060\uFEFF';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    const nameError = need(root, '#join-name-error');
    expect(nameError.textContent).toBe('Enter a display name');
    expect(nameError.hidden).toBe(false);
    expect(nameError.getAttribute('role')).toBe('alert');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(name);

    name.value = '\u200B' + 'A'.repeat(41);
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(nameError.textContent).toBe('Use 1 to 40 characters');
    expect(nameError.hidden).toBe(false);
    expect(nameError.getAttribute('role')).toBe('alert');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(name);
    expect(mocks.joinWithCode).not.toHaveBeenCalled();
  });

  it('sends the cleaned display name to the API', async () => {
    const guest: GuestJoin = { boardId: 'board-clean-name', role: 'commenter', name: 'Ada Lovelace', guestId: 'guest-clean-name', expiresAt: 1 };
    mocks.joinWithCode.mockResolvedValue(guest);
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, 'ABCDEF', vi.fn<(value: GuestJoin) => void>());
    need(root, 'input[name="name"]').value = '  Ada\u200B   Lovelace  ';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    // the client now sends the cleaned name, and the server cleans it as well.
    expect(mocks.joinWithCode).toHaveBeenCalledWith('ABCDEF', 'Ada Lovelace');
    expect(mocks.setGuest).toHaveBeenCalledWith(guest);
  });

  it('sends forty cleaned NFC characters to the API', async () => {
    const guest: GuestJoin = { boardId: 'board-2', role: 'commenter', name: 'Élodie', guestId: 'guest-2', expiresAt: 1 };
    mocks.joinWithCode.mockResolvedValue(guest);
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, 'ABCDEF', vi.fn<(value: GuestJoin) => void>());
    const rawName = '\u200B' + 'e\u0301'.repeat(40);
    const cleanedName = 'é'.repeat(40);
    need(root, 'input[name="name"]').value = rawName;
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    expect(rawName.length).toBeGreaterThan(40);
    // the client now sends the cleaned name, and the server cleans it as well.
    expect(mocks.joinWithCode).toHaveBeenCalledWith('ABCDEF', cleanedName);
    expect(mocks.setGuest).toHaveBeenCalledWith(guest);
  });

  it('clears duplicate outer and hash-route codes on local validation failure and preserves the rest of history', async () => {
    const { state, replaceState } = stubJoinHistory('?c=outer&outer=kept&c=duplicate', '#/join?c=short&source=invite&c=hash-copy');
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    need(root, 'input[name="code"]').value = 'short';
    need(root, 'input[name="name"]').value = 'Rae';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    const codeError = need(root, '#join-code-error');
    expect(codeError.textContent).toBe('That code looks too short');
    expect(codeError.hidden).toBe(false);
    expect(codeError.getAttribute('role')).toBe('alert');
    expect(need(root, 'input[name="code"]').getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(need(root, 'input[name="code"]'));
    expect(replaceState).toHaveBeenCalledWith(state, '', '/join?outer=kept#/join?source=invite');
    expect(mocks.joinWithCode).not.toHaveBeenCalled();
  });

  it('leaves unrelated hash query codes alone when no join query contains a code', async () => {
    const { replaceState } = stubJoinHistory('?outer=kept', '#/b/board-1?c=keep&source=board');
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    need(root, 'input[name="code"]').value = 'short';
    need(root, 'input[name="name"]').value = 'Rae';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    expect(need(root, '#join-code-error').textContent).toBe('That code looks too short');
    expect(replaceState).not.toHaveBeenCalled();
    expect(browser.location.hash).toBe('#/b/board-1?c=keep&source=board');
    expect(mocks.joinWithCode).not.toHaveBeenCalled();
  });

  it('clears a search code on API failure and hides raw sanitizer errors', async () => {
    const { state, replaceState } = stubJoinHistory('?c=ABCD2345&from=mail', '#/join?source=invite');
    mocks.joinWithCode.mockRejectedValue(new ApiError(400, 'bad_request', 'RAW sanitizer error: control character rejected'));
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    const code = need(root, 'input[name="code"]');
    const name = need(root, 'input[name="name"]');
    code.value = 'ABCD2345';
    name.value = '  Alex\u0000  ';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    // the client now sends the cleaned name, and the server cleans it as well.
    expect(mocks.joinWithCode).toHaveBeenCalledWith('ABCD2345', 'Alex');
    const nameError = need(root, '#join-name-error');
    expect(nameError.textContent).toBe('Use 1 to 40 characters');
    expect(nameError.hidden).toBe(false);
    expect(nameError.getAttribute('role')).toBe('alert');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(name);
    expect(textOf(root)).not.toContain('RAW sanitizer error');
    expect(replaceState).toHaveBeenCalledWith(state, '', '/join?from=mail#/join?source=invite');
  });
});
