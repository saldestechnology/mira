import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { BoardApp } from '../src/app';
import { setSignedIn, setSignedOut } from '../src/auth';
import type { AiRunsMessage } from '../src/sync';
import { mountAiLive } from '../src/ui/ai-live';
import { FakeElement, installFakeBrowser, type FakeBrowser } from './fake-dom';

// docs/ai.md "Live runs" (TAB-141 Q21): someone else's AI preview may repaint ghosts and labels, but must never move your view.

type Camera = { x: number; y: number; zoom: number };
type BoardObject = { id: string; type: 'sticky'; x: number; y: number; w: number; h: number; text: string; fill: string };
type Proposal = { kind: 'create'; objects: { text: string }[] } | { kind: 'group'; groups: { title: string; ids: string[] }[] };
type Overlay = { ai: string };
type MoveSpy = Mock<(source: string) => void>;

const MOVE_NAME = /pan|zoom|fit|center|scroll|camera|view|follow|animate|goto|set(?!Overlay)/i;
const FAR_OBJECTS: BoardObject[] = [
  { id: 'far_a', type: 'sticky', x: 10_000, y: 10_000, w: 192, h: 192, text: 'first', fill: '#FFE16B' },
  { id: 'far_b', type: 'sticky', x: 10_216, y: 10_000, w: 192, h: 192, text: 'second', fill: '#FFE16B' },
];

let browser: FakeBrowser;
let pendingFrames: Map<number, FrameRequestCallback>;
let frameId: number;
let activeViolations: string[] | null;
let elementScrollMocks: Map<string, MoveSpy>;
let prototypeDescriptors: Map<string, PropertyDescriptor | undefined>;
let mounted: (() => void)[];
let resetSignedIn = false;

beforeEach(() => {
  browser = installFakeBrowser();
  pendingFrames = new Map();
  frameId = 0;
  activeViolations = null;
  elementScrollMocks = new Map();
  prototypeDescriptors = new Map();
  mounted = [];
  resetSignedIn = false;

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    pendingFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id);
  });
  vi.stubGlobal('Element', FakeElement);

  const proto = FakeElement.prototype as unknown as object;
  prototypeDescriptors.set('offsetWidth', Object.getOwnPropertyDescriptor(proto, 'offsetWidth'));
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 140 });
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy']) {
    prototypeDescriptors.set(name, Object.getOwnPropertyDescriptor(proto, name));
    const spy = vi.fn<() => void>(() => { activeViolations?.push(`Element.${name}`); });
    elementScrollMocks.set(name, spy);
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: spy });
  }
});

afterEach(() => {
  for (const destroy of mounted) destroy();
  mounted = [];
  if (resetSignedIn) setSignedOut();
  activeViolations = null;

  const proto = FakeElement.prototype as unknown as object;
  for (const [name, descriptor] of prototypeDescriptors) {
    if (descriptor) Object.defineProperty(proto, name, descriptor);
    else delete (proto as Record<string, unknown>)[name];
  }
  browser.uninstall();
});

/** Run all queued animation frames, including any frame scheduled by a frame callback. */
function frames() {
  let count = 0;
  while (pendingFrames.size) {
    if (++count > 100) throw new Error('animation frame loop did not settle');
    const batch = [...pendingFrames.values()];
    pendingFrames.clear();
    for (const callback of batch) callback(0);
  }
}

function strictProxy<T extends object>(target: T, allowed: Set<string>, prefix: string, violations: string[], cameraSetter: MoveSpy): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(object, property, receiver);
      if (allowed.has(property)) return Reflect.get(object, property, receiver);
      const name = String(property);
      if (MOVE_NAME.test(name)) violations.push(`${prefix}.${name}`);
      return (..._args: unknown[]) => {
        violations.push(`${prefix}.${name}`);
        if (MOVE_NAME.test(name)) cameraSetter(`${prefix}.${name}`);
      };
    },
    set(object, property, value, receiver) {
      const name = String(property);
      violations.push(`${prefix}.${name}`);
      if (MOVE_NAME.test(name)) cameraSetter(`${prefix}.${name}`);
      return Reflect.set(object, property, value, receiver);
    },
    deleteProperty(object, property) {
      const name = String(property);
      violations.push(`${prefix}.${name}`);
      if (MOVE_NAME.test(name)) cameraSetter(`${prefix}.${name}`);
      return Reflect.deleteProperty(object, property);
    },
  });
}

function makeRig(initialCamera: Camera = { x: 0, y: 0, zoom: 1 }) {
  const violations: string[] = [];
  activeViolations = violations;
  const initial = { ...initialCamera };
  const cameraState = { ...initialCamera };
  const cameraSetter = vi.fn<(source: string) => void>((_source) => undefined);
  const cam = new Proxy(cameraState, {
    set(object, property, value) {
      violations.push(`cam.${String(property)}`);
      cameraSetter(`cam.${String(property)}`);
      return Reflect.set(object, property, value);
    },
    deleteProperty(object, property) {
      violations.push(`cam.${String(property)}`);
      cameraSetter(`cam.${String(property)}`);
      return Reflect.deleteProperty(object, property);
    },
  });

  const root = browser.mount();
  const cursorLayer = browser.document.createElement('div');
  root.appendChild(cursorLayer);
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) as DOMRect,
  });
  const objects = new Map(FAR_OBJECTS.map((object) => [object.id, object]));
  const store = {
    get: vi.fn<(id: string) => BoardObject | undefined>((id) => objects.get(id)),
    getMeta: vi.fn<() => { bodyFont: string; headingFont: string }>(() => ({ bodyFont: 'system', headingFont: 'system' })),
    undo: { undo: vi.fn<() => void>(), stopCapturing: vi.fn<() => void>() },
    transact: vi.fn<(fn?: () => void) => void>((fn) => fn?.()),
  };
  const bounds = vi.fn<(object: BoardObject) => { x: number; y: number; w: number; h: number }>((object) => ({ x: object.x, y: object.y, w: object.w, h: object.h }));
  const contentBounds = vi.fn<() => { x: number; y: number; w: number; h: number } | null>(() => {
    const all = [...objects.values()];
    if (!all.length) return null;
    const left = Math.min(...all.map((o) => o.x));
    const top = Math.min(...all.map((o) => o.y));
    const right = Math.max(...all.map((o) => o.x + o.w));
    const bottom = Math.max(...all.map((o) => o.y + o.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
  });
  const overlayWrites: Overlay[] = [];
  const setOverlay = vi.fn<(overlay: Overlay) => void>((overlay) => { overlayWrites.push(overlay); });
  let cameraListener: (() => void) | null = null;
  const renderer = {
    root,
    cursorLayer,
    cam,
    bounds,
    isHidden: vi.fn<(_object: BoardObject) => boolean>(() => false),
    contentBounds,
    toScreen: vi.fn<(point: { x: number; y: number }) => { x: number; y: number }>((point) => ({
      x: (point.x - cam.x) * cam.zoom,
      y: (point.y - cam.y) * cam.zoom,
    })),
    setOverlay,
    onCamera: vi.fn<(listener: () => void) => () => void>((listener) => {
      cameraListener = listener;
      return () => { if (cameraListener === listener) cameraListener = null; };
    }),
  };
  const r = strictProxy(renderer, new Set(['root', 'cursorLayer', 'cam', 'bounds', 'isHidden', 'contentBounds', 'toScreen', 'setOverlay', 'onCamera']), 'r', violations, cameraSetter);

  let relay: ((message: AiRunsMessage) => void) | null = null;
  const conn = {
    onAiRuns: vi.fn<(callback: (message: AiRunsMessage) => void) => () => void>((callback) => {
      relay = callback;
      return () => { if (relay === callback) relay = null; };
    }),
  };
  const eventNames: string[] = [];
  const eventListeners = new Map<string, Set<() => void>>();
  const on = vi.fn<(name: string, listener: () => void) => () => void>((name, listener) => {
    eventNames.push(name);
    const listeners = eventListeners.get(name) ?? new Set<() => void>();
    listeners.add(listener);
    eventListeners.set(name, listeners);
    return () => { listeners.delete(listener); };
  });
  const destroyCallbacks: (() => void)[] = [];
  const appValue = {
    r,
    conn,
    store,
    readOnly: false,
    user: { id: 'viewer', name: 'Johan', color: '#2F6FED' },
    on,
    onDestroy: vi.fn<(callback: () => void) => void>((callback) => { destroyCallbacks.push(callback); }),
  };
  const app = strictProxy(appValue, new Set(['r', 'conn', 'store', 'readOnly', 'user', 'on', 'onDestroy']), 'app', violations, cameraSetter) as unknown as BoardApp;
  const windowScrollTo = vi.fn<() => void>(() => { violations.push('window.scrollTo'); });
  (window as unknown as { scrollTo: () => void }).scrollTo = windowScrollTo;

  let isDestroyed = false;
  const destroy = () => {
    if (isDestroyed) return;
    isDestroyed = true;
    for (const callback of destroyCallbacks.splice(0)) callback();
  };
  mountAiLive(app);
  mounted.push(destroy);

  return {
    app,
    cam,
    cameraState,
    initial,
    cameraSetter,
    violations,
    layer: root.querySelector('.ailive') as FakeElement,
    overlayWrites,
    setOverlay,
    windowScrollTo,
    eventNames,
    eventListeners,
    send(message: AiRunsMessage) {
      if (!relay) throw new Error('AI run relay listener is not mounted');
      relay(message);
    },
    cameraEvent() { cameraListener?.(); },
    destroy,
  };
}

function remoteRun(id: string, status: 'running' | 'ready', options: { proposal?: Proposal; byId?: string; startedAt?: number; target?: { ids: string[] } } = {}) {
  return {
    id,
    feature: 'generate',
    status,
    by: { id: options.byId ?? 'remote-ana', name: 'Ana', color: '#7A5AF8' },
    private: false,
    startedAt: options.startedAt ?? 1,
    readyAt: status === 'ready' ? 2 : null,
    target: options.target ?? { ids: ['far_a', 'far_b'] },
    proposal: status === 'ready' ? options.proposal ?? { kind: 'create', objects: [{ text: 'AI preview text' }] } : null,
    cut: false,
  };
}

function patch(rig: ReturnType<typeof makeRig>, run: unknown) {
  rig.send({ kind: 'patch', run });
  frames();
}

function snapshot(rig: ReturnType<typeof makeRig>, runs: unknown[]) {
  rig.send({ kind: 'snapshot', runs });
  frames();
}

function expectNoMovement(rig: ReturnType<typeof makeRig>) {
  expect(rig.violations).toEqual([]);
  expect({ x: rig.cam.x, y: rig.cam.y, zoom: rig.cam.zoom }).toEqual(rig.initial);
  expect(rig.cameraSetter).not.toHaveBeenCalled();
  expect(rig.windowScrollTo).not.toHaveBeenCalled();
  for (const spy of elementScrollMocks.values()) expect(spy).not.toHaveBeenCalled();
}

describe('the live AI preview camera guard', () => {
  it('keeps an off-screen remote preview hidden through its ready update and resolution', () => {
    const rig = makeRig();
    snapshot(rig, [remoteRun('offscreen', 'running')]);
    expect(rig.layer.querySelectorAll('.ailive-run')).toHaveLength(1);
    expect(rig.layer.querySelector('.ailive-run')!.hidden).toBe(true);

    const ready = remoteRun('offscreen', 'ready', {
      proposal: { kind: 'create', objects: [{ text: 'first draft' }, { text: 'second draft' }, { text: 'third draft' }] },
    });
    patch(rig, ready);
    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(1);
    expect(rig.layer.querySelector('.ailive-row')!.hidden).toBe(true);

    patch(rig, {
      ...ready,
      proposal: { kind: 'create', objects: [{ text: 'updated first' }, { text: 'updated second' }] },
      readyAt: 3,
    });
    expect(rig.layer.querySelector('.ailive-row')!.hidden).toBe(true);

    patch(rig, {
      id: 'offscreen', feature: 'generate', status: 'accepted',
      by: { id: 'remote-ana', name: 'Ana', color: '#7A5AF8' },
      resolvedBy: { id: 'viewer', name: 'Johan' }, error: null,
    });
    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(0);
    expect(rig.layer.querySelectorAll('.ailive-run')).toHaveLength(0);
    expect(rig.overlayWrites.some((overlay) => overlay.ai.length > 0)).toBe(true);

    rig.destroy();
    expectNoMovement(rig);
  });

  it('draws a late-join snapshot preview that is already on screen', () => {
    // The content is far from the board origin, and this initial camera already shows it.
    const rig = makeRig({ x: 10_000, y: 10_000, zoom: 1 });
    snapshot(rig, [remoteRun('late-ready', 'ready', {
      proposal: { kind: 'create', objects: [{ text: 'visible preview text' }, { text: 'another sticky' }] },
    })]);

    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(1);
    expect(rig.layer.querySelector('.ailive-row')!.hidden).toBe(false);
    expect(rig.overlayWrites.some((overlay) => overlay.ai.trim().length > 0)).toBe(true);

    rig.destroy();
    expectNoMovement(rig);
  });

  it('keeps two remote previews in place as one is accepted and the other expires', () => {
    const rig = makeRig({ x: 10_000, y: 10_000, zoom: 1 });
    snapshot(rig, [
      remoteRun('preview-a', 'ready', { startedAt: 1, proposal: { kind: 'create', objects: [{ text: 'preview A' }] } }),
      remoteRun('preview-b', 'ready', { startedAt: 2, proposal: { kind: 'create', objects: [{ text: 'preview B' }] }, byId: 'remote-ben' }),
    ]);
    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(2);

    patch(rig, {
      id: 'preview-a', feature: 'generate', status: 'accepted',
      by: { id: 'remote-ana', name: 'Ana', color: '#7A5AF8' },
      resolvedBy: { id: 'viewer', name: 'Johan' }, error: null,
    });
    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(1);
    expect(rig.overlayWrites.at(-1)?.ai).toContain('preview B');

    patch(rig, {
      id: 'preview-b', feature: 'generate', status: 'expired',
      by: { id: 'remote-ben', name: 'Ben', color: '#E0559B' }, resolvedBy: null, error: null,
    });
    expect(rig.layer.querySelectorAll('.ailive-row')).toHaveLength(0);
    expect(rig.overlayWrites.at(-1)?.ai).toBe('');

    rig.destroy();
    expectNoMovement(rig);
  });

  it('only repaints when the camera event arrives during a remote run', () => {
    const rig = makeRig();
    snapshot(rig, [remoteRun('camera-event', 'running')]);
    expect(rig.layer.querySelectorAll('.ailive-run')).toHaveLength(1);
    expect(rig.eventNames).toContain('objects');

    rig.cameraEvent();
    frames();
    patch(rig, remoteRun('camera-event', 'ready', { proposal: { kind: 'create', objects: [{ text: 'after user pan' }] } }));

    rig.destroy();
    expectNoMovement(rig);
  });

  it('allows the signed-in user run to arrive over the relay without moving the view', async () => {
    await setSignedIn({ user: { id: 'viewer' } } as Parameters<typeof setSignedIn>[0]);
    resetSignedIn = true;
    const rig = makeRig();
    snapshot(rig, [remoteRun('my-run', 'running', { byId: 'viewer' })]);

    rig.destroy();
    expect(rig.violations).toEqual([]);
    expectNoMovement(rig);
  });

  it('keeps the view still when every sticky of a remote cluster preview changes and its short row takes the place of the ghosts (TAB-221)', () => {
    const rig = makeRig({ x: 10_000, y: 10_000, zoom: 1 });
    const saved = FAR_OBJECTS.map((o) => ({ ...o }));
    try {
      snapshot(rig, [remoteRun('all-changed', 'ready', { proposal: { kind: 'group', groups: [{ title: 'Together', ids: ['far_a', 'far_b'] }] } })]);
      expect(rig.layer.querySelector('.ailive-row')!.classList.contains('changed')).toBe(false);
      // someone else edits one sticky and moves the other: nothing is left to draw
      FAR_OBJECTS[0].text = 'edited elsewhere';
      FAR_OBJECTS[1].x += 40;
      rig.eventListeners.get('objects')?.forEach((fn) => fn());
      frames();
      const row = rig.layer.querySelector('.ailive-row')!;
      expect(row.classList.contains('changed')).toBe(true);
      expect(row.querySelectorAll('button').map((b) => b.textContent)).toEqual(['Discard']);
      rig.destroy();
      expectNoMovement(rig);
    } finally {
      FAR_OBJECTS.forEach((o, i) => Object.assign(o, saved[i]));
    }
  });

  it('records deliberate camera moves so the guard is not vacuous', () => {
    const rig = makeRig();
    const renderer = rig.app.r as unknown as { setCamera?: (next: { x: number }) => void; cam: Camera };
    renderer.setCamera?.({ x: 5 });
    renderer.cam.x = 5;

    expect(rig.violations).toContain('r.setCamera');
    expect(rig.violations).toContain('cam.x');
    expect(rig.cameraSetter).toHaveBeenCalled();
    rig.destroy();
  });
});
