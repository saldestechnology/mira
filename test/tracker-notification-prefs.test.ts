import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockTrackerApi } from '../src/tracker-mock';
import type { TrackerNotificationPrefs } from '../src/tracker-types';
import { mountNotificationPrefs } from '../src/tracker/ui/notification-prefs';
import { FakeElement, control, flush, need, textOf } from './fake-dom';
import { installTrackerUiBrowser, uiEvent } from './tracker-ui-test-helpers';

const preferences: TrackerNotificationPrefs = {
  kinds: ['assigned', 'mentioned', 'commented', 'status_changed', 'due_soon', 'relation_changed', 'integration_activity'],
  prefs: {
    assigned: 'both', mentioned: 'both', commented: 'app', status_changed: 'app', due_soon: 'both',
    relation_changed: 'app', integration_activity: 'app',
  },
};

let browser: ReturnType<typeof installTrackerUiBrowser> | null = null;
afterEach(() => {
  browser?.uninstall();
  browser = null;
  vi.useRealTimers();
});

function mount(api = createMockTrackerApi({ notificationPrefs: preferences })) {
  const host = browser!.document.createElement('div') as unknown as HTMLElement;
  browser!.document.body.appendChild(host as unknown as FakeElement);
  const announced: string[] = [];
  const controller = mountNotificationPrefs(host, { api, announce: (text) => announced.push(text) });
  return { api, host: host as unknown as FakeElement, controller, announced };
}

describe('tracker notification preferences UI', () => {
  it('renders all kinds, applies changes immediately and announces a successful choice', async () => {
    browser = installTrackerUiBrowser();
    const { api, host, announced } = mount();
    await flush();
    expect(textOf(host)).toContain('Email goes out two minutes after the notice, only if you have not read it.');
    expect(host.querySelectorAll('.trk-prefs-row')).toHaveLength(7);
    const radios = host.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(21);
    expect(host.querySelectorAll('[role="radiogroup"]')[0].getAttribute('aria-label')).toBe('Assigned to me');
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(7);

    host.querySelector('[data-kind="assigned"][data-choice="app"]')!.click();
    expect(host.querySelector('[data-kind="assigned"][data-choice="app"]')?.getAttribute('aria-checked')).toBe('true');
    await flush();
    expect((await api.notificationPrefs()).prefs.assigned).toBe('app');
    expect(announced).toEqual(['Assigned to me: In Tabula only']);
  });

  it('supports arrow selection within one radiogroup and leaves Tab to move between groups', async () => {
    browser = installTrackerUiBrowser();
    const { host } = mount();
    await flush();
    const group = host.querySelector('[role="radiogroup"]')!;
    const event = uiEvent('keydown', { key: 'ArrowRight' });
    group.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    await flush();
    expect(host.querySelector('[data-kind="assigned"][data-choice="app"]')?.getAttribute('aria-checked')).toBe('true');
    expect((browser.document.activeElement as unknown as FakeElement).getAttribute('data-choice')).toBe('app');

    const tab = uiEvent('keydown', { key: 'Tab' });
    group.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(tab.propagationStopped).toBe(false);
  });

  it('rolls back a failed update and retries the requested choice', async () => {
    browser = installTrackerUiBrowser();
    const api = createMockTrackerApi({ notificationPrefs: preferences });
    const save = api.updateNotificationPrefs.bind(api);
    let attempts = 0;
    api.updateNotificationPrefs = async (patch, options) => {
      attempts++;
      if (attempts === 1) throw new Error('temporary preference failure');
      return save(patch, options);
    };
    const { host, announced } = mount(api);
    await flush();

    host.querySelector('[data-kind="assigned"][data-choice="off"]')!.click();
    expect(host.querySelector('[data-kind="assigned"][data-choice="off"]')?.getAttribute('aria-checked')).toBe('true');
    await flush();
    expect(host.querySelector('[data-kind="assigned"][data-choice="both"]')?.getAttribute('aria-checked')).toBe('true');
    expect(textOf(need(host, '.trk-prefs-row-error'))).toContain('Could not save this preference.');
    control(host, 'Retry').click();
    await flush();
    expect(host.querySelector('[data-kind="assigned"][data-choice="off"]')?.getAttribute('aria-checked')).toBe('true');
    expect(textOf(host)).not.toContain('Could not save this preference.');
    expect(announced).toEqual(['Assigned to me: Off']);
  });

  it('shows a loading skeleton and a retryable load error', async () => {
    browser = installTrackerUiBrowser();
    const pendingApi = createMockTrackerApi();
    pendingApi.notificationPrefs = () => new Promise(() => undefined);
    const loading = mount(pendingApi);
    expect(loading.host.querySelectorAll('.trk-prefs-skeleton-row')).toHaveLength(3);
    expect(need(loading.host, '.trk-prefs-skeleton').getAttribute('aria-busy')).toBe('true');
    loading.controller.destroy();

    const api = createMockTrackerApi({ notificationPrefs: preferences });
    const get = api.notificationPrefs.bind(api);
    let loads = 0;
    api.notificationPrefs = async (options) => {
      loads++;
      if (loads === 1) throw new Error('settings unavailable');
      return get(options);
    };
    const retry = mount(api);
    await flush();
    expect(textOf(need(retry.host, '.trk-prefs-load-error'))).toContain('Could not load notification settings.');
    control(retry.host, 'Retry').click();
    await flush();
    expect(retry.host.querySelectorAll('[role="radiogroup"]')).toHaveLength(7);
  });
});
