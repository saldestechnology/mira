import type { TrackerApi } from '../../tracker-data';
import type { TrackerNotificationKind, TrackerNotificationPrefs, TrackerNotifyChoice } from '../../tracker-types';
import { h } from '../../ui/dom';
import { choiceLabel, kindLabel } from './inbox-model';
import './tracker.css';
import './inbox.css';

export interface NotificationPrefsDependencies {
  api: TrackerApi;
  announce?: (text: string) => void;
}

export interface NotificationPrefsController {
  refresh(): Promise<void>;
  destroy(): void;
}

const CHOICES: TrackerNotifyChoice[] = ['both', 'app', 'off'];

/** Mounts the notification delivery controls inside the supplied host. */
export function mountNotificationPrefs(host: HTMLElement, deps: NotificationPrefsDependencies): NotificationPrefsController {
  const root = h('section', { class: 'trk trk-prefs', 'aria-label': 'Notifications' });
  let preferences: TrackerNotificationPrefs | null = null;
  let loading = false;
  let loadError = false;
  let destroyed = false;
  let loadController: AbortController | null = null;
  let requestSerial = 0;
  const controllers = new Set<AbortController>();
  const latestRequest = new Map<TrackerNotificationKind, number>();
  const rowErrors = new Map<TrackerNotificationKind, { choice: TrackerNotifyChoice; previous: TrackerNotifyChoice }>();

  const title = h('h2', { class: 'trk-prefs-title' }, 'Notifications');
  const explanation = h('p', { class: 'trk-prefs-explanation' },
    'Choose where each kind of notice reaches you. Email goes out two minutes after the notice, only if you have not read it.',
  );

  const setChoice = (kind: TrackerNotificationKind, choice: TrackerNotifyChoice, focus = false): void => {
    if (!preferences || destroyed) return;
    const previous = preferences.prefs[kind];
    if (previous === choice && !rowErrors.has(kind)) return;
    const serial = ++requestSerial;
    latestRequest.set(kind, serial);
    rowErrors.delete(kind);
    preferences = { ...preferences, prefs: { ...preferences.prefs, [kind]: choice } };
    render();
    if (focus) root.querySelector<HTMLElement>(`.trk-prefs-radio[data-kind="${kind}"][data-choice="${choice}"]`)?.focus();

    const controller = new AbortController();
    controllers.add(controller);
    void deps.api.updateNotificationPrefs({ prefs: { [kind]: choice } }, { signal: controller.signal })
      .then((result) => {
        if (destroyed || controller.signal.aborted || latestRequest.get(kind) !== serial) return;
        preferences = result;
        rowErrors.delete(kind);
        render();
        deps.announce?.(`${kindLabel(kind)}: ${choiceLabel(choice)}`);
        if (focus) root.querySelector<HTMLElement>(`.trk-prefs-radio[data-kind="${kind}"][data-choice="${choice}"]`)?.focus();
      })
      .catch(() => {
        if (destroyed || controller.signal.aborted || latestRequest.get(kind) !== serial) return;
        preferences = { ...preferences!, prefs: { ...preferences!.prefs, [kind]: previous } };
        rowErrors.set(kind, { choice, previous });
        render();
      })
      .finally(() => controllers.delete(controller));
  };

  const renderRows = (kinds: TrackerNotificationKind[]) => kinds.map((kind) => {
    const current = preferences!.prefs[kind];
    const group = h('div', {
      class: 'trk-prefs-options', role: 'radiogroup', 'aria-label': kindLabel(kind),
      onkeydown: (event: KeyboardEvent) => {
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (!direction) return;
        const from = CHOICES.indexOf(current);
        const next = CHOICES[(from + direction + CHOICES.length) % CHOICES.length];
        event.preventDefault();
        event.stopPropagation();
        setChoice(kind, next, true);
      },
    }, ...CHOICES.map((choice) => h('button', {
      class: 'trk-prefs-radio', type: 'button', role: 'radio',
      'aria-checked': String(current === choice),
      tabindex: current === choice ? '0' : '-1',
      'data-kind': kind,
      'data-choice': choice,
      onclick: () => setChoice(kind, choice),
    }, choiceLabel(choice))));
    const rowError = rowErrors.get(kind);
    return h('div', { class: 'trk-prefs-row' },
      h('h3', { class: 'trk-prefs-kind' }, kindLabel(kind)),
      group,
      rowError ? h('div', { class: 'trk-prefs-row-error', role: 'alert' },
        h('span', null, 'Could not save this preference.'),
        h('button', { class: 'trk-prefs-retry', type: 'button', onclick: () => setChoice(kind, rowError.choice) }, 'Retry'),
      ) : null,
    );
  });

  function render(): void {
    if (destroyed) return;
    const children: Array<HTMLElement | null> = [title, explanation];
    if (loadError) children.push(h('div', { class: 'trk-prefs-load-error', role: 'alert' },
      h('span', null, 'Could not load notification settings.'),
      h('button', { class: 'trk-prefs-retry', type: 'button', onclick: () => { void refresh(); } }, 'Retry'),
    ));
    if (!preferences && loading) {
      children.push(h('div', { class: 'trk-prefs-skeleton', 'aria-label': 'Loading notification settings', 'aria-busy': 'true' },
        ...Array.from({ length: 3 }, () => h('div', { class: 'trk-prefs-skeleton-row', 'aria-hidden': 'true' },
          h('span', null), h('span', null),
        )),
      ));
    } else if (preferences) {
      children.push(h('div', { class: 'trk-prefs-rows' }, ...renderRows(preferences.kinds)));
    }
    root.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    loadController?.abort();
    loadController = new AbortController();
    const controller = loadController;
    loading = true;
    loadError = false;
    render();
    try {
      const result = await deps.api.notificationPrefs({ signal: controller.signal });
      if (destroyed || controller.signal.aborted) return;
      preferences = result;
      loading = false;
      loadError = false;
      render();
    } catch {
      if (destroyed || controller.signal.aborted) return;
      loading = false;
      loadError = true;
      render();
    }
  }

  host.replaceChildren(root);
  void refresh();
  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loadController?.abort();
      for (const controller of controllers) controller.abort();
      controllers.clear();
      host.replaceChildren();
    },
  };
}
