import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedJoinCode, JoinCodeInfo } from '../src/api';
import { FakeElement, FakeEvent, flush, installFakeBrowser, need, textOf, type FakeBrowser } from './fake-dom';

const mocks = vi.hoisted(() => ({
  joinCodes: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createJoinCode: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return {
    ...actual,
    api: {
      joinCodes: (...args: unknown[]) => mocks.joinCodes(...args),
      createJoinCode: (...args: unknown[]) => mocks.createJoinCode(...args),
    },
  };
});
vi.mock('../src/ui/common', () => ({ toast: vi.fn<(...args: unknown[]) => void>() }));

const { mountJoinCodes } = await import('../src/ui/join-codes');

let browser: FakeBrowser;
let scrollCalls: { target: FakeElement; options?: ScrollIntoViewOptions }[];
let priorScrollIntoView: PropertyDescriptor | undefined;

beforeEach(() => {
  browser = installFakeBrowser();
  scrollCalls = [];
  priorScrollIntoView = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'scrollIntoView');
  Object.defineProperty(FakeElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: FakeElement, options?: ScrollIntoViewOptions) {
      scrollCalls.push({ target: this, options });
    },
  });
  mocks.joinCodes.mockReset();
  mocks.createJoinCode.mockReset();
});

afterEach(() => {
  browser.uninstall();
  if (priorScrollIntoView) Object.defineProperty(FakeElement.prototype, 'scrollIntoView', priorScrollIntoView);
  else delete (FakeElement.prototype as FakeElement & { scrollIntoView?: unknown }).scrollIntoView;
});

async function createCodeAndCheckScroll({ phone = true, reducedMotion = false } = {}) {
  const code: CreatedJoinCode = {
    id: 'jc_mobile', code: 'ABCD2345', role: 'commenter', createdAt: Date.now(), expiresAt: Date.now() + 3 * 60 * 60 * 1000,
    maxUses: 100, uses: 0,
  };
  const row: JoinCodeInfo = { ...code, revokedAt: null };
  mocks.joinCodes.mockResolvedValueOnce([]).mockResolvedValue([row]);
  mocks.createJoinCode.mockResolvedValue(code);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: (phone && query === '(max-width: 480px)') || (reducedMotion && query === '(prefers-reduced-motion: reduce)') }));

  const root = browser.mount();
  const section = mountJoinCodes('board-mobile') as unknown as FakeElement;
  root.appendChild(section);
  await flush();
  need(section, 'form').dispatchEvent(new FakeEvent('submit'));
  await flush();

  const panel = need(section, '.join-code-created');
  const copyCode = need(panel, 'button');
  return {
    calls: scrollCalls,
    panel,
    copyCode,
    copyText: textOf(copyCode),
    activeElement: browser.document.activeElement,
    expectedOptions: phone ? { block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' } : { block: 'center' },
  };
}

describe('join-code mobile creation scroll', () => {
  it('scrolls the new panel smoothly and focuses Copy code when motion is allowed', async () => {
    const result = await createCodeAndCheckScroll();
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.target).toBe(result.panel);
    expect(result.calls[0]?.options).toEqual(result.expectedOptions);
    expect(result.copyText).toBe('Copy code');
    expect(result.activeElement).toBe(result.copyCode);
  });

  it('keeps the new panel scroll from being smooth when reduced motion is enabled', async () => {
    const result = await createCodeAndCheckScroll({ reducedMotion: true });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.target).toBe(result.panel);
    expect(result.calls[0]?.options).toEqual(result.expectedOptions);
    expect(result.copyText).toBe('Copy code');
    expect(result.activeElement).toBe(result.copyCode);
  });

  it('preserves the existing centered scroll behavior on desktop', async () => {
    const result = await createCodeAndCheckScroll({ phone: false });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.target).toBe(result.panel);
    expect(result.calls[0]?.options).toEqual(result.expectedOptions);
    expect(result.copyText).toBe('Copy code');
    expect(result.activeElement).toBe(result.copyCode);
  });
});
