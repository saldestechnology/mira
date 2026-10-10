import { TrackerError } from '../../tracker-types';
import type { TrackerStore } from '../../tracker-data';
import type { TrackerStateCategory, TrackerLinkKanbanResult, TrackerLinkSuggestion } from '../../tracker-types';

export interface LinkDialogLane { id: string; name: string }
export interface LinkDialogStateOption { id: string; key: string; name: string; category: TrackerStateCategory }
export interface LinkDialogErrors { lanes: Record<string, string>; general: string | null }

/**
 * Mapping state uses an absent lane key for an unresolved suggestion, a state key for a mapped lane, and null only
 * after the user explicitly chooses “Skip this lane”. Skipped lanes are excluded from ticket creation in v1.
 */
export interface LinkDialogModelState {
  mapping: Partial<Record<string, string | null>>;
  skippedLanes: string[];
  createTickets: boolean;
  errors: LinkDialogErrors;
  /** Why the last submit failed: the store's error code folded to what the dialog shows. */
  errorCode: 'offline' | 'forbidden' | 'conflict' | 'other' | null;
  submitting: boolean;
  canSubmit: boolean;
}

export interface LinkDialogModel {
  readonly state: LinkDialogModelState;
  setMapping(laneId: string, stateKey: string | null): void;
  setCreateTickets(value: boolean): void;
  describeStateUse(stateKey: string): string | null;
  submit(store: Pick<TrackerStore, 'linkKanban'>, context: { boardId: string; kanbanId: string }): Promise<TrackerLinkKanbanResult | null>;
  subscribe(listener: (state: LinkDialogModelState) => void): () => void;
}

export function createLinkDialogModel(input: {
  lanes: LinkDialogLane[];
  states: LinkDialogStateOption[];
  suggestion: TrackerLinkSuggestion;
  existingCardCount: number;
}): LinkDialogModel {
  const lanes = input.lanes.map((lane) => ({ ...lane }));
  const states = input.states.map((state) => ({ ...state }));
  const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
  const statesByKey = new Map(states.map((state) => [state.key, state]));
  let mapping: Partial<Record<string, string | null>> = {};
  for (const lane of lanes) {
    const suggested = input.suggestion.map[lane.id];
    if (typeof suggested === 'string' && statesByKey.has(suggested)) mapping[lane.id] = suggested;
  }
  let createTickets = input.existingCardCount > 0;
  let generalError: string | null = null;
  let errorCode: LinkDialogModelState['errorCode'] = null;
  let submitting = false;
  const serverLaneErrors: Record<string, string> = {};
  const listeners = new Set<(state: LinkDialogModelState) => void>();

  const skipped = () => lanes.filter((lane) => mapping[lane.id] === null).map((lane) => lane.id);
  const errors = (): LinkDialogErrors => {
    const laneErrors = { ...serverLaneErrors };
    const ownerByState = new Map<string, string>();
    for (const lane of lanes) {
      const stateKey = mapping[lane.id];
      if (typeof stateKey !== 'string') continue;
      const prior = ownerByState.get(stateKey);
      if (prior) laneErrors[lane.id] = `${statesByKey.get(stateKey)?.name ?? stateKey} is already used by ${lanesById.get(prior)?.name ?? prior}.`;
      else ownerByState.set(stateKey, lane.id);
    }
    return { lanes: laneErrors, general: generalError };
  };
  const canSubmit = (currentErrors: LinkDialogErrors) => lanes.every((lane) =>
    Object.hasOwn(mapping, lane.id) && (mapping[lane.id] === null || (typeof mapping[lane.id] === 'string' && statesByKey.has(mapping[lane.id]!))),
  ) && Object.keys(currentErrors.lanes).length === 0;
  const snapshot = (): LinkDialogModelState => {
    const currentErrors = errors();
    return {
      mapping: { ...mapping }, skippedLanes: skipped(), createTickets,
      errors: currentErrors, errorCode, submitting, canSubmit: !submitting && canSubmit(currentErrors),
    };
  };
  const notify = () => {
    const current = snapshot();
    for (const listener of listeners) listener({ ...current, mapping: { ...current.mapping }, skippedLanes: [...current.skippedLanes], errors: { general: current.errors.general, lanes: { ...current.errors.lanes } } });
  };

  const model: LinkDialogModel = {
    get state() { return snapshot(); },
    setMapping(laneId, stateKey) {
      if (!lanesById.has(laneId)) return;
      delete serverLaneErrors[laneId];
      generalError = null;
      if (stateKey === null) {
        mapping[laneId] = null;
      } else if (!statesByKey.has(stateKey)) {
        delete mapping[laneId];
        serverLaneErrors[laneId] = 'Choose a valid tracker state or skip this lane.';
      } else {
        mapping[laneId] = stateKey;
      }
      notify();
    },
    setCreateTickets(value) {
      createTickets = value;
      generalError = null;
      notify();
    },
    describeStateUse(stateKey) {
      const lane = lanes.find((candidate) => candidate.id !== undefined && mapping[candidate.id] === stateKey);
      return lane ? `Used by ${lane.name}` : null;
    },
    async submit(store, context) {
      if (!snapshot().canSubmit) return null;
      submitting = true;
      errorCode = null;
      generalError = null;
      notify();
      const map = Object.fromEntries(Object.entries(mapping).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      try {
        const result = await store.linkKanban({ ...context, map, createTickets });
        generalError = null;
        errorCode = null;
        submitting = false;
        for (const laneId of Object.keys(serverLaneErrors)) delete serverLaneErrors[laneId];
        notify();
        return result;
      } catch (caught) {
        const error = caught instanceof TrackerError ? caught : caught as { code?: unknown; message?: unknown; path?: unknown };
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const path = error && typeof error === 'object' && typeof error.path === 'string' ? error.path : '';
        const laneId = path.startsWith('map.') ? path.slice(4) : path;
        if ((code === 'invalid_mapping' || code === 'invalid_input') && lanesById.has(laneId)) {
          serverLaneErrors[laneId] = error.message ? String(error.message) : 'This lane mapping was rejected.';
          generalError = null;
        } else {
          generalError = error && typeof error.message === 'string' ? error.message : 'The kanban could not be linked.';
        }
        errorCode = code === 'offline' || code === 'network' ? 'offline' : code === 'forbidden' || code === 'read_only' || code === 'board_forbidden' ? 'forbidden' : code === 'conflict' || code === 'already_linked' ? 'conflict' : 'other';
        submitting = false;
        notify();
        return null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
  return model;
}

/** The model with `submit()` bound to a store and a kanban, resolving `{ created, firstKey, lastKey }` or null (reason in `state.errorCode`). */
export function bindLinkDialogModel(model: LinkDialogModel, store: Pick<TrackerStore, 'linkKanban'>, context: { boardId: string; kanbanId: string }) {
  return {
    get state() { return model.state; },
    setMapping: model.setMapping,
    setCreateTickets: model.setCreateTickets,
    describeStateUse: model.describeStateUse,
    subscribe: model.subscribe,
    async submit(): Promise<{ created: number; firstKey?: string; lastKey?: string } | null> {
      const result = await model.submit(store, context);
      if (!result) return null;
      const keys = (result.created ?? []).map((item) => item.key);
      return { created: keys.length, firstKey: keys[0], lastKey: keys[keys.length - 1] };
    },
  };
}
