import { FakeEvent, installFakeBrowser } from './fake-dom';
import { vi } from 'vitest';

export function installTrackerUiBrowser() {
  vi.useFakeTimers();
  const browser = installFakeBrowser();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
  const win = window as unknown as {
    addEventListener: (type: string, listener: (event: FakeEvent) => void) => void;
    removeEventListener: (type: string, listener: (event: FakeEvent) => void) => void;
  };
  const listeners = new Map<string, Set<(event: FakeEvent) => void>>();
  win.addEventListener = (type, listener) => {
    const set = listeners.get(type) ?? new Set();
    set.add(listener);
    listeners.set(type, set);
  };
  win.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  return {
    ...browser,
    dispatchWindow(event: FakeEvent) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
  };
}

export function uiEvent(type: string, props: Record<string, unknown> = {}): FakeEvent {
  return Object.assign(new FakeEvent(type), {
    key: '', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, timeStamp: 0,
    ...props,
  });
}
