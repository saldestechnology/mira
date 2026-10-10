import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me, Share } from '../src/api';
import { FakeElement, FakeEvent, flush, installFakeBrowser, need, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  shares: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  teams: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  teamMembers: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  members: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  share: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  toast: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      shares: (...args: Parameters<typeof actual.api.shares>) => mocks.shares(...args),
      teams: (...args: Parameters<typeof actual.api.teams>) => mocks.teams(...args),
      teamMembers: (...args: Parameters<typeof actual.api.teamMembers>) => mocks.teamMembers(...args),
      members: (...args: Parameters<typeof actual.api.members>) => mocks.members(...args),
      share: (...args: Parameters<typeof actual.api.share>) => mocks.share(...args),
    },
  };
});
vi.mock('../src/auth', () => ({ cachedServerBoards: () => [] }));
vi.mock('../src/ui/common', () => ({ toast: (...args: unknown[]) => mocks.toast(...args) }));

const { mountSharePeople } = await import('../src/ui/share');

let browser: FakeBrowser;

beforeEach(() => {
  browser = installFakeBrowser();
  mocks.shares.mockReset().mockResolvedValue([
    { principalType: 'user', principalId: 'u2', name: 'Ben', role: 'viewer' } satisfies Share,
  ]);
  mocks.teams.mockReset().mockResolvedValue([]);
  mocks.teamMembers.mockReset().mockResolvedValue([]);
  mocks.members.mockReset().mockResolvedValue([]);
  mocks.share.mockReset().mockRejectedValue(new Error('Permission denied'));
  mocks.toast.mockReset();
});

afterEach(() => {
  browser.uninstall();
  vi.unstubAllGlobals();
});

describe('share role rollback', () => {
  it('restores the displayed role and shows no success status after a rejected update', async () => {
    const root = browser.mount();
    const me = { user: { id: 'owner', name: 'Owner', role: 'owner' } } as unknown as Me;
    root.appendChild(mountSharePeople('board-1', me) as unknown as FakeElement);
    await flush();

    const role = root.querySelectorAll('select')[0]!;
    expect(role.getAttribute('aria-label')).toBe('Role for Ben');
    const status = need(root, '.share-status');
    role.value = 'editor';
    role.dispatchEvent(new FakeEvent('change'));
    await flush();

    expect(mocks.share).toHaveBeenCalledWith('board-1', {
      principalType: 'user',
      principalId: 'u2',
      role: 'editor',
    });
    expect(role.value).toBe('viewer');
    expect(status.textContent).toBe('');
    expect(mocks.toast).toHaveBeenCalledWith('Permission denied');
  });
});
