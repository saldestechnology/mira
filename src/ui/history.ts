import './history.css';
import type { BoardApp } from '../app';
import type { Obj } from '../types';
import { ApiError, api, type Version } from '../api';
import { formatShortcutLabel } from '../shortcuts';
import { authState } from '../auth';
import { workspaceOf, cloudErrorMessage } from '../cloud-logic';
import { Renderer } from '../render';
import { getRelaySetting, relayUrl } from '../sync';
import {
  applyRestore, canDelete, canRename, createStateCache, filterVersions, fmtClock, fmtStamp, groupByDay, historyOffline,
  isHiddenNow, objectDeltas, openSnapshot, planRestore, restoreBlock, summaryText, versionTitle,
  type RestorePlan, type Snapshot, type VersionFilter, type Who,
} from '../history';
import { h, icon } from './dom';
import { dialog, toast } from './common';

type Status = 'loading' | 'ready' | 'error' | 'offline';

interface Preview {
  version: Version;
  snapshot: Snapshot;
  renderer: Renderer;
  stopChanges: () => void;
}

const SUMMARY_DEBOUNCE_MS = 400;
/** The restore is saved by the relay within a second or two; the list is refreshed after that. */
const REFRESH_AFTER_RESTORE_MS = 2500;
const DISARM_MS = 3000;

function errorText(error: unknown, fallback: string): string {
  const cloud = cloudErrorMessage(error);
  if (cloud) return cloud;
  if (error instanceof ApiError && error.code !== 'network' && error.message && error.message !== error.code) return error.message;
  return fallback;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function restoreSuccessToast(platform: string): string {
  return `Version restored. Press ${formatShortcutLabel('Ctrl/Cmd+Z', platform)} to undo.`;
}

/** Version history: a panel with the saved versions and a read-only preview of one (docs/history.md). */
export function mountHistory(app: BoardApp, chrome: HTMLElement): { open: () => void } {
  const boardId = app.conn.id;
  const cache = createStateCache();

  let panelOpen = false;
  let status: Status = 'loading';
  let failure = '';
  let versions: Version[] = [];
  let filter: VersionFilter = 'all';
  let selected: string | null = null;
  let armed: string | null = null;
  let armTimer = 0;
  let preview: Preview | null = null;
  let seq = 0;
  let summaryTimer = 0;
  let busy = false;

  const who = (): Who => {
    const auth = authState();
    return { role: app.role, userId: auth.mode === 'signed-in' ? auth.me.user.id : null };
  };
  const by = () => (app.role === null ? app.user.name : undefined);
  const workspaceReadOnly = () => workspaceOf(authState())?.readOnly === true;
  const mutable = () => !app.store.readOnly;
  const lockedText = () => (workspaceReadOnly() ? 'This workspace is read-only.' : 'You can only view this board.');

  // ---------------------------------------------------------------- elements

  const panel = h('aside', { class: 'history-panel', 'aria-label': 'Version history', tabindex: '-1' });
  chrome.appendChild(panel);

  const stage = h('div', { class: 'history-stage' });
  const banner = h('div', { class: 'history-banner' });
  const overlay = h('section', { class: 'history-preview', 'aria-label': 'Version preview', tabindex: '-1' }, banner, stage);
  chrome.parentElement?.appendChild(overlay);

  // Neither the panel nor the preview may reach the board's own shortcuts: Delete and Ctrl+Z belong to the live board.
  for (const el of [panel, overlay]) {
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && preview) {
        e.preventDefault();
        closePreview();
      }
    });
    el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  // ---------------------------------------------------------------- list

  async function load() {
    if (historyOffline(getRelaySetting(), relayUrl())) {
      status = 'offline';
      paintPanel();
      return;
    }
    status = 'loading';
    paintPanel();
    try {
      versions = (await api.versions(boardId)).versions;
      status = 'ready';
    } catch (e) {
      const network = e instanceof ApiError && e.code === 'network';
      status = network ? 'offline' : 'error';
      failure = errorText(e, 'Could not load the versions.');
    }
    paintPanel();
  }

  function stateLine(): HTMLElement | null {
    if (status === 'loading') return h('p', { class: 'history-state' }, 'Loading versions…');
    if (status === 'offline') return h('p', { class: 'history-state' }, 'Version history is stored on the server and needs a connection.');
    if (status === 'error') {
      return h('div', { class: 'history-state' }, h('p', { role: 'alert' }, failure), h('button', { class: 'history-btn', onclick: () => void load() }, 'Retry'));
    }
    return null;
  }

  function actionsFor(v: Version): HTMLElement | null {
    const w = who();
    const rename = canRename(v, w);
    const remove = canDelete(v, w);
    if (!rename && !remove) return null;
    const off = !mutable();
    const buttons: HTMLElement[] = [];
    if (rename) {
      buttons.push(h('button', {
        class: 'history-link', disabled: off, title: off ? lockedText() : null,
        onclick: () => void nameDialog(v),
      }, v.kind === 'named' ? 'Rename' : 'Name'));
    }
    if (remove) {
      const sure = armed === v.id;
      buttons.push(h('button', {
        class: `history-link${sure ? ' armed' : ''}`, disabled: off, title: off ? lockedText() : null,
        onclick: () => (sure ? void removeVersion(v) : arm(v.id)),
      }, sure ? 'Confirm delete' : 'Delete'));
    }
    return h('div', { class: 'history-row-actions' }, buttons);
  }

  function arm(id: string) {
    armed = id;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => {
      armed = null;
      paintPanel();
    }, DISARM_MS);
    paintPanel();
  }

  function row(v: Version, delta: number | null | undefined): HTMLElement {
    const on = selected === v.id;
    const meta = [plural(v.objects, 'object') + (delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''), v.kind === 'named' || v.kind === 'restore' || v.kind === 'pre-restore' ? v.byName : null]
      .filter(Boolean).join(' · ');
    const button = h('button', {
      class: `history-row${on ? ' on' : ''}`, 'data-key': `row:${v.id}`, 'aria-current': on ? 'true' : null, onclick: () => void select(v),
    },
      h('span', { class: 'history-time' }, fmtClock(v.createdAt)),
      h('span', { class: 'history-main' },
        h('span', { class: `history-title${v.kind === 'named' ? ' named' : ''}` }, versionTitle(v)),
        h('span', { class: 'history-meta' }, meta)));
    return h('div', { class: 'history-item' }, button, on ? actionsFor(v) : null);
  }

  function paintPanel() {
    panel.classList.toggle('show', panelOpen);
    if (!panelOpen) return;
    // A repaint replaces the focused control; keep focus in the panel so keys never fall through to the board.
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && panel.contains(active) ? (active.dataset.key ?? '') : null;
    const closeBtn = h('button', { class: 'history-icon', 'data-tip': 'Close', 'aria-label': 'Close version history', onclick: () => close() }, icon('close', 18));
    const save = h('button', {
      class: 'history-btn primary', disabled: status !== 'ready' || !mutable(), title: !mutable() ? lockedText() : null,
      onclick: () => void saveVersion(),
    }, 'Save version');
    const tab = (value: VersionFilter, label: string) => h('button', {
      class: `history-tab${filter === value ? ' on' : ''}`, 'data-key': `tab:${value}`, role: 'tab', 'aria-selected': String(filter === value),
      onclick: () => {
        filter = value;
        paintPanel();
      },
    }, label);
    const head = h('div', { class: 'history-head' }, h('h2', null, 'Version history'), closeBtn);
    const bar = h('div', { class: 'history-bar' }, h('div', { class: 'history-tabs', role: 'tablist', 'aria-label': 'Filter versions' }, tab('all', 'All'), tab('named', 'Named')), save);
    const current = h('div', { class: 'history-item' },
      h('button', { class: `history-row current${selected === null ? ' on' : ''}`, 'data-key': 'current', 'aria-current': selected === null ? 'true' : null, onclick: () => closePreview() },
        h('span', { class: 'history-time' }, 'Now'),
        h('span', { class: 'history-main' }, h('span', { class: 'history-title' }, 'Current board'), h('span', { class: 'history-meta' }, 'Live, as everyone sees it'))));
    const body = h('div', { class: 'history-body' }, current);
    const state = stateLine();
    if (state) {
      body.appendChild(state);
    } else {
      const deltas = objectDeltas(versions);
      const shown = filterVersions(versions, filter);
      if (!shown.length) {
        body.appendChild(h('p', { class: 'history-state' },
          filter === 'named' ? 'No named versions yet. Use Save version to keep a milestone.' : 'No earlier versions yet. Versions are saved automatically while people edit.'));
      }
      for (const g of groupByDay(shown, Date.now())) {
        body.appendChild(h('div', { class: 'history-day' }, g.label));
        for (const v of g.items) body.appendChild(row(v, deltas.get(v.id)));
      }
    }
    panel.replaceChildren(head, bar, body);
    if (focusKey !== null) {
      const same = focusKey ? [...panel.querySelectorAll<HTMLElement>('[data-key]')].find((el) => el.dataset.key === focusKey) : undefined;
      (same ?? panel).focus();
    }
  }

  panel.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...panel.querySelectorAll<HTMLElement>('.history-row')];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });

  // ---------------------------------------------------------------- preview

  const isHidden = (o: Obj) => isHiddenNow(o, app.user.id, app.store.getFlow().reveal);

  async function select(v: Version) {
    const mine = ++seq;
    selected = v.id;
    paintPanel();
    let bytes = cache.get(v.id);
    if (!bytes) {
      try {
        bytes = await api.versionState(boardId, v.id);
        cache.set(v.id, bytes);
      } catch (e) {
        if (mine !== seq) return;
        toast(errorText(e, 'Could not load this version. Check your connection and try again.'));
        selected = preview?.version.id ?? null;
        paintPanel();
        return;
      }
    }
    if (mine !== seq) return;
    let snapshot: Snapshot;
    try {
      snapshot = openSnapshot(bytes);
    } catch {
      toast('This version could not be read.');
      selected = preview?.version.id ?? null;
      paintPanel();
      return;
    }
    showPreview(v, snapshot);
  }

  function showPreview(version: Version, snapshot: Snapshot) {
    disposePreview();
    const renderer = new Renderer(snapshot.store, stage);
    const meta = snapshot.store.getMeta();
    renderer.readOnly = true;
    renderer.gridType = meta.gridType;
    renderer.gridSize = meta.gridSize;
    renderer.isHidden = isHidden;
    renderer.setCamera({ ...app.r.cam });
    const stopChanges = app.store.onChange(() => {
      clearTimeout(summaryTimer);
      summaryTimer = window.setTimeout(paintBanner, SUMMARY_DEBOUNCE_MS);
    });
    preview = { version, snapshot, renderer, stopChanges };
    chrome.classList.add('history-previewing');
    overlay.classList.add('show');
    paintBanner();
    paintPanel();
    // The preview's area differs from the board's (banner, panel), so it opens fitted rather than at the live camera.
    fitPreview();
  }

  function disposePreview() {
    if (!preview) return;
    clearTimeout(summaryTimer);
    preview.stopChanges();
    preview.renderer.destroy();
    preview.snapshot.doc.destroy();
    preview = null;
  }

  function closePreview() {
    seq++;
    disposePreview();
    selected = null;
    chrome.classList.remove('history-previewing');
    overlay.classList.remove('show');
    paintPanel();
  }

  function planNow(p: Preview): RestorePlan {
    return planRestore(app.store, p.snapshot.store, { isHidden });
  }

  function blockNow(p: Preview) {
    return restoreBlock({
      readOnly: app.store.readOnly,
      workspaceReadOnly: workspaceReadOnly(),
      sessionActive: app.store.getFlow().active >= 0,
      snapshotSchema: p.snapshot.schemaVersion,
    });
  }

  function paintBanner() {
    const p = preview;
    if (!p) return;
    const v = p.version;
    const block = blockNow(p);
    const plan = planNow(p);
    const w = who();
    const summary = block ? block.message : plan.empty ? 'This version matches the board as it is now.' : summaryText(plan.summary);
    const restore = h('button', {
      class: 'history-btn primary', disabled: block !== null || plan.empty || busy, title: block?.message ?? null,
      onclick: () => void restoreVersion(),
    }, 'Restore this version');
    const naming = canRename(v, w)
      ? h('button', { class: 'history-btn', disabled: !mutable(), title: !mutable() ? lockedText() : null, onclick: () => void nameDialog(v) }, v.kind === 'named' ? 'Rename' : 'Name this version')
      : null;
    banner.replaceChildren(
      h('div', { class: 'history-banner-text' },
        h('div', { class: 'history-label' }, 'Viewing version'),
        h('h2', { class: 'history-banner-title' }, versionTitle(v)),
        h('div', { class: 'history-banner-sub' }, `${fmtStamp(v.createdAt)} · ${plural(v.objects, 'object')}`),
        h('div', { class: 'history-banner-sum', role: 'status' }, summary)),
      h('div', { class: 'history-banner-actions' },
        restore,
        naming,
        h('button', { class: 'history-btn', onclick: () => fitPreview() }, 'Fit to content'),
        h('button', { class: 'history-btn', onclick: () => closePreview() }, 'Back to current board')));
  }

  function fitPreview() {
    const r = preview?.renderer;
    const b = r?.contentBounds();
    if (r && b) r.fit(b, 48, 1);
  }

  // Drag to pan, wheel to zoom: the preview has none of the board's own pointer handling.
  let panning: { x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !preview) return;
    panning = { x: e.clientX, y: e.clientY };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
  });
  stage.addEventListener('pointermove', (e) => {
    const r = preview?.renderer;
    if (!panning || !r) return;
    r.setCamera({ x: r.cam.x - (e.clientX - panning.x) / r.cam.zoom, y: r.cam.y - (e.clientY - panning.y) / r.cam.zoom });
    panning = { x: e.clientX, y: e.clientY };
  });
  const stopPanning = () => {
    panning = null;
    stage.classList.remove('panning');
  };
  stage.addEventListener('pointerup', stopPanning);
  stage.addEventListener('pointercancel', stopPanning);
  stage.addEventListener('wheel', (e) => {
    const r = preview?.renderer;
    if (!r) return;
    e.preventDefault();
    const box = r.root.getBoundingClientRect();
    const sx = e.clientX - box.left, sy = e.clientY - box.top;
    const at = r.toWorld(sx, sy);
    r.setCamera({ zoom: r.cam.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)) });
    r.setCamera({ x: at.x - sx / r.cam.zoom, y: at.y - sy / r.cam.zoom });
  }, { passive: false });

  // ---------------------------------------------------------------- actions

  function askName(title: string, initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      const input = h('input', { class: 'input', maxlength: '80', value: initial, 'aria-label': 'Version name', placeholder: 'For example: Before the workshop' });
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      const submit = () => {
        const text = input.value.trim();
        if (!text) return false;
        finish(text);
        return true;
      };
      const dlg = dialog(title, h('div', null, input), [
        { label: 'Cancel', onClick: () => finish(null) },
        { label: 'Save', primary: true, onClick: () => (submit() ? undefined : false) },
      ]);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && submit()) dlg.close();
      });
    });
  }

  async function saveVersion() {
    const label = await askName('Save version', '');
    if (label === null) return;
    try {
      await api.saveVersion(boardId, label, by());
      toast('Version saved');
      await load();
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'empty' ? 'Nothing to save yet. Add something to the board first.' : errorText(e, 'Could not save the version. Check your connection and try again.'));
    }
  }

  async function nameDialog(v: Version) {
    const label = await askName(v.kind === 'named' ? 'Rename version' : 'Name this version', v.label ?? '');
    if (label === null) return;
    try {
      await api.nameVersion(boardId, v.id, label, by());
      toast('Version named');
      await load();
      if (preview?.version.id === v.id) {
        const fresh = versions.find((x) => x.id === v.id);
        if (fresh) preview.version = fresh;
        paintBanner();
      }
    } catch (e) {
      toast(errorText(e, 'Could not name the version. Check your connection and try again.'));
    }
  }

  async function removeVersion(v: Version) {
    armed = null;
    try {
      await api.deleteVersion(boardId, v.id);
      if (preview?.version.id === v.id) closePreview();
      toast('Version deleted');
      await load();
    } catch (e) {
      toast(errorText(e, 'Could not delete the version. Check your connection and try again.'));
      paintPanel();
    }
  }

  function confirmRestore(plan: RestorePlan): Promise<boolean> {
    return new Promise((resolve) => {
      dialog('Restore this version?', h('div', { class: 'history-confirm' },
        h('p', null, summaryText(plan.summary) + '.'),
        h('p', null, 'Everyone on the board will see it change. The board as it is now is saved first as a version, and you can undo this with Ctrl+Z.')), [
        { label: 'Cancel', onClick: () => resolve(false) },
        { label: 'Restore', primary: true, onClick: () => resolve(true) },
      ]);
    });
  }

  async function restoreVersion() {
    const p = preview;
    if (!p || busy) return;
    const block = blockNow(p);
    if (block) {
      toast(block.message);
      return;
    }
    const first = planNow(p);
    if (first.empty) {
      toast('This version matches the board as it is now.');
      return;
    }
    if (!(await confirmRestore(first))) return;
    busy = true;
    paintBanner();
    try {
      // The server saves the board as it is now and records who restored what, before anything changes.
      await api.beginRestore(boardId, p.version.id, by());
    } catch (e) {
      busy = false;
      paintBanner();
      toast(errorText(e, 'Could not restore the version. Check your connection and try again.'));
      return;
    }
    busy = false;
    if (preview !== p) return;
    // Rebuilt against the board as it is by now, so edits made while the dialog was open are neither lost nor duplicated.
    applyRestore(app.store, planNow(p));
    closePreview();
    (document.activeElement as HTMLElement | null)?.blur();
    toast(restoreSuccessToast(typeof navigator === 'undefined' ? '' : navigator.platform));
    window.setTimeout(() => {
      if (panelOpen) void load();
    }, REFRESH_AFTER_RESTORE_MS);
  }

  // ---------------------------------------------------------------- open and close

  function open() {
    if (panelOpen) return;
    panelOpen = true;
    paintPanel();
    void load();
  }

  function close() {
    closePreview();
    panelOpen = false;
    paintPanel();
  }

  app.store.onReadOnly(() => {
    if (panelOpen) paintPanel();
    paintBanner();
  });
  app.lifetime.signal.addEventListener('abort', () => disposePreview());

  return { open };
}
