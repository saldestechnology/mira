import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedJoinCode, GuestJoin, JoinCodeInfo } from '../src/api';
import { ApiError } from '../src/api';
import { FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  joinCodes: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createJoinCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  revokeJoinCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  joinWithCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  setGuest: vi.fn<(...args: unknown[]) => void>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    api: {
      joinCodes: (...args: unknown[]) => mocks.joinCodes(...args),
      createJoinCode: (...args: unknown[]) => mocks.createJoinCode(...args),
      revokeJoinCode: (...args: unknown[]) => mocks.revokeJoinCode(...args),
      joinWithCode: (...args: unknown[]) => mocks.joinWithCode(...args),
    },
  };
});
vi.mock('../src/auth', () => ({ setGuest: (...args: unknown[]) => mocks.setGuest(...args) }));
vi.mock('../src/ui/common', () => ({ toast: vi.fn<(...args: unknown[]) => void>() }));

const { mountJoinCodes } = await import('../src/ui/join-codes');
const { renderJoin, cleanCode } = await import('../src/ui/join');

let browser: FakeBrowser;

beforeEach(() => {
  browser = installFakeBrowser();
  (browser.location as FakeBrowser['location'] & { origin: string }).origin = 'https://boards.example';
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } });
  mocks.joinCodes.mockReset();
  mocks.createJoinCode.mockReset();
  mocks.revokeJoinCode.mockReset();
  mocks.joinWithCode.mockReset();
  mocks.setGuest.mockReset();
  mocks.writeText.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  browser.uninstall();
  vi.unstubAllGlobals();
});

describe('join-code sharing controls', () => {
  it('shows accessible inline errors for empty and short codes without submitting them', async () => {
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', () => undefined);
    const code = need(root, '#join-code');
    const name = need(root, '#join-name');
    name.value = 'Guest visitor';
    expect(code.getAttribute('aria-label')).toBe('Join code');
    expect(need(root, 'label[for="join-code"]').textContent).toBe('Join code');

    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(need(root, '#join-code-error').textContent).toBe('Enter the code you were given');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(browser.document.activeElement).toBe(code);
    expect(mocks.joinWithCode).not.toHaveBeenCalled();

    code.value = 'ABC';
    code.dispatchEvent(new FakeEvent('input'));
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(need(root, '#join-code-error').textContent).toBe('That code looks too short');
    expect(mocks.joinWithCode).not.toHaveBeenCalled();
  });

  it('creates a code, shows its copyable link and lets an editor revoke it', async () => {
    const code: CreatedJoinCode = {
      id: 'jc_1', code: 'ABCD2345', role: 'editor', createdAt: Date.now(), expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      maxUses: 9, uses: 0,
    };
    const row: JoinCodeInfo = { ...code, revokedAt: null };
    mocks.joinCodes.mockResolvedValueOnce([]).mockResolvedValue([row]);
    mocks.createJoinCode.mockResolvedValue(code);
    mocks.revokeJoinCode.mockResolvedValue(undefined);

    const root = browser.mount();
    const section = mountJoinCodes('board-1') as unknown as ReturnType<typeof browser.mount>;
    root.appendChild(section);
    await flush();
    expect(textOf(section)).toContain('No join codes yet.');

    const [role, expiry] = section.querySelectorAll('select');
    role.value = 'editor';
    expiry.value = '6';
    need(section, '.join-code-uses').value = '9';
    need(section, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();

    expect(mocks.createJoinCode).toHaveBeenCalledWith('board-1', { role: 'editor', expiresInHours: 6, maxUses: 9 });
    expect(need(section, '.join-code-value').value).toBe('ABCD2345');
    expect(need(section, '.join-code-link').value).toBe('https://boards.example/join?c=ABCD2345');
    expect(textOf(section)).toContain('This code is shown once');
    section.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === 'Revoke Editor join code')!.click();
    await flush();
    expect(mocks.revokeJoinCode).toHaveBeenCalledWith('board-1', 'jc_1');
    expect(textOf(section)).toContain('Revoked');
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('copies the share link from the section', async () => {
    const code: CreatedJoinCode = {
      id: 'jc_2', code: 'WXYZ5678', role: 'commenter', createdAt: Date.now(), expiresAt: Date.now() + 3 * 60 * 60 * 1000,
      maxUses: 100, uses: 0,
    };
    mocks.joinCodes.mockResolvedValueOnce([]).mockResolvedValue([]);
    mocks.createJoinCode.mockResolvedValue(code);
    const root = browser.mount();
    const section = mountJoinCodes('board-2') as unknown as ReturnType<typeof browser.mount>;
    root.appendChild(section);
    await flush();
    need(section, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    section.querySelectorAll('button').find((button) => textOf(button) === 'Copy code')!.click();
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith('WXYZ5678');
    const buttons = section.querySelectorAll('button');
    buttons.find((button) => textOf(button) === 'Copy link')!.click();
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith('https://boards.example/join?c=WXYZ5678');
  });
});

describe('join page', () => {
  it('submits the code and display name, stores the guest profile and continues to its board', async () => {
    const guest: GuestJoin = { boardId: 'board-7', role: 'commenter', name: 'Sam', guestId: 'guest_1', expiresAt: Date.now() + 100_000 };
    mocks.joinWithCode.mockResolvedValue(guest);
    const root = browser.mount();
    const done = vi.fn<(value: GuestJoin) => void>();
    renderJoin(root as unknown as HTMLElement, 'abcd2345', done);
    const code = need(root, 'input[name="code"]');
    const name = need(root, 'input[name="name"]');
    expect(code.value).toBe('ABCD2345');
    expect(browser.document.activeElement).toBe(name);
    name.value = '  Sam  ';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    // the client now sends the cleaned name, and the server cleans it as well.
    expect(mocks.joinWithCode).toHaveBeenCalledWith('ABCD2345', 'Sam');
    expect(mocks.setGuest).toHaveBeenCalledWith(guest);
    expect(done).toHaveBeenCalledWith(guest);
  });

  it('shows one plain invalid-code message for rejected codes', async () => {
    mocks.joinWithCode.mockRejectedValue(new ApiError(404, 'invalid_join_code', 'This join code is not valid. Ask the board owner for a new one.'));
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    need(root, 'input[name="code"]').value = 'AAAAAA';
    need(root, 'input[name="name"]').value = 'Rae';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(textOf(need(root, '[role="alert"]'))).toBe('This code is no longer valid. Ask the board owner for a new one.');
    expect(need(root, 'input[name="code"]').getAttribute('aria-invalid')).toBe('true');
  });

  it('drops spaces and lower case from a typed or pasted code before the length limit', async () => {
    expect(cleanCode('abcd efgh')).toBe('ABCDEFGH');
    expect(cleanCode(' abcd2345 ')).toBe('ABCD2345');
    expect(cleanCode('ABCD\u00a0EFGH23')).toBe('ABCDEFGH');
    const guest: GuestJoin = { boardId: 'b', role: 'editor', name: 'Sam', guestId: 'guest_2', expiresAt: Date.now() + 100_000 };
    mocks.joinWithCode.mockResolvedValue(guest);
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    const code = need(root, 'input[name="code"]');
    expect(code.getAttribute('maxlength')).toBeNull();
    code.value = 'k8pv fbam';
    code.dispatchEvent(new FakeEvent('input'));
    expect(code.value).toBe('K8PVFBAM');
    need(root, 'input[name="name"]').value = 'Sam';
    need(root, 'form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    expect(mocks.joinWithCode).toHaveBeenCalledWith('K8PVFBAM', 'Sam');
  });

  it('limits the name to the server limit and names the field the way the label does', () => {
    const root = browser.mount();
    renderJoin(root as unknown as HTMLElement, '', vi.fn<(value: GuestJoin) => void>());
    const name = need(root, 'input[name="name"]');
    expect(name.getAttribute('maxlength')).toBe('40');
    expect(name.getAttribute('aria-label')).toBe('Display name');
  });
});
