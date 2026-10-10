import './tracker.css';
import { registerTrackerRenderer } from '../../tracker-frame';
import type { TrackerApi, TrackerStore } from '../../tracker-data';
import type { BaseObj } from '../../types';
import type { BoardApp } from '../../app';
import { h } from '../../ui/dom';
import { renderTrackerSnapshot } from './frame-snapshot';
import { mountTrackerShell, type TrackerShellController } from './shell';
import type { TrackerView } from '../../tracker-types';
import { navigateTrackerPath, onTrackerRoute } from '../../route';
import type { TrackerPathRoute } from '../../tracker-route';

registerTrackerRenderer(renderTrackerSnapshot);

export type TrackerPresentation = 'snapshot' | 'work';
export interface WheelState { modified: boolean; deltaY: number; scrollTop: number; scrollHeight: number; clientHeight: number }

export function trackerPresentation(zoom: number, screenWidth: number, focused: boolean, phone = false): TrackerPresentation {
  return !phone && focused && zoom >= 0.4 && screenWidth >= 560 ? 'work' : 'snapshot';
}

export function wheelDisposition(state: WheelState): 'zoom' | 'list' | 'pan' {
  if (state.modified) return 'zoom';
  const canScrollUp = state.deltaY < 0 && state.scrollTop > 0;
  const canScrollDown = state.deltaY > 0 && state.scrollTop + state.clientHeight < state.scrollHeight - 1;
  return canScrollUp || canScrollDown ? 'list' : 'pan';
}

interface TrackerFrameUiOptions {
  app: BoardApp;
  store: TrackerStore;
  api: TrackerApi;
  viewerId: string;
  initialTrackerId?: string;
  initialTicketKey?: string;
}

interface FrameMount {
  obj: BaseObj;
  wrapper: HTMLElement;
  workHost: HTMLElement;
  open: HTMLButtonElement;
  expand: HTMLButtonElement;
  requestedWork: boolean;
  shell: TrackerShellController | null;
  drag: { pointerId: number; x: number; y: number; camX: number; camY: number } | null;
  pinchPoints: Map<number, { x: number; y: number }>;
  pinch: { distance: number; midpoint: { x: number; y: number } } | null;
}

function isTracker(obj: BaseObj): boolean {
  return obj.type === 'tracker' && typeof obj.trackerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.trackerId);
}

function isPhone(): boolean { return typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches; }

function routeForShell(shell: TrackerShellController): TrackerPathRoute {
  if (shell.state.ticketKey) return { kind: 'ticket', key: shell.state.ticketKey };
  if (shell.state.viewId) return shell.state.tab === 'projects'
    ? { kind: 'view', view: 'projects', id: shell.state.viewId }
    : { kind: 'view', view: 'views', id: shell.state.viewId };
  return { kind: 'view', view: shell.state.tab };
}

/** Mounts a live DOM surface over selected tracker frames; board paint always remains the static SVG snapshot. */
export function mountTrackerFrames(options: TrackerFrameUiOptions): () => void {
  const { app, store } = options;
  const overlay = h('div', { class: 'trk-frame-overlay', 'aria-label': 'Tracker frames' });
  app.r.root.appendChild(overlay);
  const frames = new Map<string, FrameMount>();

  const selected = (id: string) => app.selection.includes(id);
  const lookup = (id: string) => app.store.get(id) as BaseObj | undefined;

  const openFullscreenRoute = (mount: FrameMount) => {
    mount.requestedWork = true;
    app.setSelection([mount.obj.id]);
    if (!mount.shell) makeShell(mount);
    if (mount.shell) navigateTrackerPath(routeForShell(mount.shell));
  };

  const onFullscreenChange = (mount: FrameMount, value: boolean) => {
    if (!value || !mount.shell) return;
    const target = routeForShell(mount.shell);
    // The frame's embedded shell stays in frame mode while the route host takes over the viewport.
    mount.shell.setFullscreen(false);
    navigateTrackerPath(target);
  };

  const makeShell = (mount: FrameMount) => {
    if (mount.shell) return;
    const obj = lookup(mount.obj.id) ?? mount.obj;
    mount.shell = mountTrackerShell(mount.workHost, {
      store, api: options.api, viewerId: options.viewerId, trackerId: String(obj.trackerId),
      windowId: obj.id,
      initialTab: typeof obj.view === 'string' ? obj.view as TrackerView : 'inbox',
      initialViewId: typeof obj.viewId === 'string' ? obj.viewId : undefined,
      initialTicketKey: mount.obj.trackerId === options.initialTrackerId ? options.initialTicketKey ?? obj.focusKey : obj.focusKey,
      boardName: app.store.getMeta().name, layoutWidth: obj.w,
      onFullscreenChange: (value) => onFullscreenChange(mount, value),
      onSnapshot: () => app.r.invalidateAll(),
      onWorkExit: () => { mount.requestedWork = false; reposition(mount); },
      active: () => mount.requestedWork,
    });
  };

  const enterWork = (mount: FrameMount) => {
    if (isPhone()) { openFullscreenRoute(mount); return; }
    mount.requestedWork = true;
    app.setSelection([mount.obj.id]);
    makeShell(mount);
    reposition(mount);
    mount.shell?.focus();
  };

  function reposition(mount: FrameMount) {
    const obj = lookup(mount.obj.id);
    if (!obj || !isTracker(obj)) return;
    mount.obj = obj;
    const screen = app.r.toScreen({ x: obj.x, y: obj.y });
    const zoom = app.zoom;
    const width = Math.max(0, obj.w * zoom);
    const height = Math.max(0, obj.h * zoom);
    const focused = selected(obj.id) && mount.requestedWork;
    const presentation = trackerPresentation(zoom, width, focused, isPhone());
    mount.wrapper.style.left = `${screen.x}px`;
    mount.wrapper.style.top = `${screen.y}px`;
    mount.wrapper.style.width = `${width}px`;
    mount.wrapper.style.height = `${height}px`;
    mount.wrapper.classList.toggle('is-work', presentation === 'work');
    mount.wrapper.classList.toggle('is-selected', selected(obj.id));
    mount.open.hidden = !(selected(obj.id) || mount.wrapper.dataset.hovered === 'true');
    mount.expand.hidden = !(selected(obj.id) || mount.wrapper.dataset.hovered === 'true' || presentation === 'work');
    if (mount.shell) {
      const shell = mount.shell.el;
      shell.hidden = presentation !== 'work';
      shell.style.width = `${obj.w}px`;
      shell.style.height = `${obj.h}px`;
      const uiScale = zoom;
      shell.style.transformOrigin = 'top left';
      shell.style.transform = `scale(${uiScale})`;
      shell.style.fontSize = `${Math.max(14, 9 / Math.max(zoom, 0.01))}px`;
      mount.shell.updateLayout(obj.w);
    }
  };

  const createFrameMount = (obj: BaseObj): FrameMount => {
    const wrapper = h('div', { class: 'trk-frame-wrap' });
    const workHost = h('div', { class: 'trk-frame-work-host' });
    const open = h('button', { class: 'trk-frame-open', type: 'button', 'aria-label': 'Open tracker', onclick: () => enterWork(mount) }, 'Open');
    const expand = h('button', { class: 'trk-frame-expand', type: 'button', 'aria-label': 'Open full screen', onclick: () => {
      openFullscreenRoute(mount);
    } }, 'Open full screen');
    const mount: FrameMount = {
      obj, wrapper, workHost, open, expand, requestedWork: false, shell: null,
      drag: null, pinchPoints: new Map(), pinch: null,
    };
    wrapper.append(workHost, open, expand);
    overlay.appendChild(wrapper);
    wrapper.addEventListener('pointerenter', () => { wrapper.dataset.hovered = 'true'; reposition(mount); });
    wrapper.addEventListener('pointerleave', () => { wrapper.dataset.hovered = 'false'; reposition(mount); });
    wrapper.addEventListener('wheel', (event) => {
      const modified = event.ctrlKey || event.metaKey;
      const scrollArea = (event.target as HTMLElement | null)?.closest<HTMLElement>('.trk-list-host, .trk-filter-host, .trk-ticket-stub');
      const disposition = wheelDisposition({
        modified, deltaY: event.deltaY, scrollTop: scrollArea?.scrollTop ?? 0,
        scrollHeight: scrollArea?.scrollHeight ?? 0, clientHeight: scrollArea?.clientHeight ?? 0,
      });
      if (disposition === 'list') return;
      event.preventDefault();
      if (disposition === 'zoom') {
        const bounds = app.r.root.getBoundingClientRect();
        app.r.zoomAt({ x: event.clientX - bounds.left, y: event.clientY - bounds.top }, Math.exp(-event.deltaY * 0.001));
      } else app.r.setCamera({ x: app.r.cam.x + event.deltaX / app.zoom, y: app.r.cam.y + event.deltaY / app.zoom });
    }, { passive: false });
    wrapper.addEventListener('pointerdown', (event) => {
      if (!mount.requestedWork) return;
      if (event.pointerType === 'touch') {
        mount.pinchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (mount.pinchPoints.size === 2) {
          const [a, b] = [...mount.pinchPoints.values()];
          mount.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
          mount.drag = null;
        }
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest('button,input,textarea,select,[role="row"],[role="tab"],.trk-filter-bar,.trk-view-bar')) return;
      mount.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camX: app.r.cam.x, camY: app.r.cam.y };
      wrapper.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    wrapper.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch' && mount.pinchPoints.has(event.pointerId)) {
        mount.pinchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (mount.pinch && mount.pinchPoints.size === 2) {
          const [a, b] = [...mount.pinchPoints.values()];
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const bounds = app.r.root.getBoundingClientRect();
          app.r.setCamera({ x: app.r.cam.x - (midpoint.x - mount.pinch.midpoint.x) / app.zoom, y: app.r.cam.y - (midpoint.y - mount.pinch.midpoint.y) / app.zoom });
          app.r.zoomAt({ x: midpoint.x - bounds.left, y: midpoint.y - bounds.top }, distance / mount.pinch.distance);
          mount.pinch = { distance, midpoint };
        }
        return;
      }
      if (!mount.drag || mount.drag.pointerId !== event.pointerId) return;
      app.r.setCamera({ x: mount.drag.camX - (event.clientX - mount.drag.x) / app.zoom, y: mount.drag.camY - (event.clientY - mount.drag.y) / app.zoom });
    });
    const stopPan = (event: PointerEvent) => {
      if (mount.drag?.pointerId === event.pointerId) mount.drag = null;
      mount.pinchPoints.delete(event.pointerId);
      if (mount.pinchPoints.size < 2) mount.pinch = null;
    };
    wrapper.addEventListener('pointerup', stopPan);
    wrapper.addEventListener('pointercancel', stopPan);
    return mount;
  };

  const syncFrames = () => {
    const objects = [...app.store.cache.values()].map((obj) => obj as BaseObj).filter(isTracker);
    const ids = new Set(objects.map((obj) => obj.id));
    for (const [id, mount] of frames) {
      if (ids.has(id)) continue;
      mount.shell?.destroy(); mount.wrapper.remove(); frames.delete(id);
    }
    for (const obj of objects) {
      let mount = frames.get(obj.id);
      if (!mount) { mount = createFrameMount(obj); frames.set(obj.id, mount); }
      reposition(mount);
    }
  };

  const onDoubleClick = (event: MouseEvent) => {
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    const hit = [...frames.values()].find(({ obj }) => point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
    if (!hit) return;
    event.preventDefault(); event.stopImmediatePropagation();
    enterWork(hit);
  };

  const hoveredFrame = (event: PointerEvent) => {
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    for (const mount of frames.values()) {
      const obj = lookup(mount.obj.id);
      const hovering = Boolean(obj && point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
      if ((mount.wrapper.dataset.hovered === 'true') !== hovering) {
        mount.wrapper.dataset.hovered = String(hovering);
        reposition(mount);
      }
    }
  };
  const openPhoneFrame = (event: MouseEvent) => {
    if (!isPhone()) return;
    const point = app.r.clientToWorld(event.clientX, event.clientY);
    const mount = [...frames.values()].find(({ obj }) => point.x >= obj.x && point.y >= obj.y && point.x <= obj.x + obj.w && point.y <= obj.y + obj.h);
    if (!mount) return;
    enterWork(mount);
  };

  const onCanvasKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.target instanceof HTMLElement && event.target.closest('.trk')) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const id = app.selection.length === 1 ? app.selection[0] : '';
    const mount = frames.get(id);
    if (!mount) return;
    if (event.key === 'Enter') { event.preventDefault(); enterWork(mount); }
    else if (event.key.toLowerCase() === 'f') {
      event.preventDefault(); openFullscreenRoute(mount);
    }
  };

  const stopTrackerRoute = onTrackerRoute(async (target) => {
    if (target.kind !== 'board-position' || target.boardId !== app.conn.id) return;
    const mount = [...frames.values()].find((frame) => frame.obj.trackerId === target.trackerId);
    const obj = mount && (lookup(mount.obj.id) ?? mount.obj);
    if (!mount || !obj || !isTracker(obj)) return;
    mount.obj = obj;
    mount.requestedWork = true;
    app.setSelection([obj.id]);
    const size = app.r.size();
    const zoom = Math.min(1, Math.max(0.45, app.zoom));
    app.r.setCamera({
      zoom,
      x: obj.x + obj.w / 2 - size.w / (2 * zoom),
      y: obj.y + obj.h / 2 - size.h / (2 * zoom),
    });
    makeShell(mount);
    reposition(mount);
    if (!target.key) return;
    mount.shell?.setTicket(target.key);
    try {
      const detail = await store.loadTicket(target.key, true);
      return { resolvedKey: detail.resolvedKey ?? detail.ticket.key };
    } catch {
      return;
    }
  });

  const offCamera = app.r.onCamera(() => frames.forEach(reposition));
  const offSelection = app.on('selection', () => frames.forEach(reposition));
  const offObjects = app.on('objects', syncFrames);
  const onDoubleBound = onDoubleClick as EventListener;
  app.r.svg.addEventListener('dblclick', onDoubleBound, true);
  app.r.svg.addEventListener('pointermove', hoveredFrame, true);
  app.r.svg.addEventListener('click', openPhoneFrame, true);
  document.addEventListener('keydown', onCanvasKey, true);
  const onResize = () => frames.forEach(reposition);
  window.addEventListener('resize', onResize);
  syncFrames();

  return () => {
    offCamera(); offSelection(); offObjects();
    stopTrackerRoute();
    app.r.svg.removeEventListener('dblclick', onDoubleBound, true);
    app.r.svg.removeEventListener('pointermove', hoveredFrame, true);
    app.r.svg.removeEventListener('click', openPhoneFrame, true);
    document.removeEventListener('keydown', onCanvasKey, true);
    window.removeEventListener('resize', onResize);
    for (const mount of frames.values()) { mount.shell?.destroy(); mount.wrapper.remove(); }
    frames.clear(); overlay.remove();
  };
}
