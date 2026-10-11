import { ApiError, type BoardRole, type Me, type Workspace } from './api';
import type { AuthState } from './auth';

// Hosted workspaces (docs/cloud.md): the rules the screens share, kept free of the DOM so they can be tested.

export const READ_ONLY_BADGE = 'Workspace is read-only';
export const DELETED_BADGE = 'Deleted board';
export const ME_REFRESH_MS = 5 * 60 * 1000;
/** Hints that arrive this close together (the board and comments sockets get one each) become one refresh. */
export const HINT_COALESCE_MS = 150;

const READ_ONLY_BANNER = 'This workspace is read-only.';

/** Said where Manage billing would be on a workspace provided free (`billing: false`). */
export const FREE_WORKSPACE_TEXT = "This workspace is provided free (education or internal). There's nothing to bill.";

const ERROR_TEXT = new Map([
  ['seat_limit', 'All seats are in use. Remove or disable someone, or ask the workspace owner to add seats.'],
  ['read_only', 'This workspace is read-only right now. Ask the workspace owner to check billing.'],
  ['no_billing', FREE_WORKSPACE_TEXT],
]);

/** The workspace limits the server reported for the signed-in user; null in open mode and on plain accounts servers. */
export function workspaceOf(auth: AuthState): Workspace | null {
  return auth.mode === 'signed-in' || auth.mode === 'offline' ? (auth.me?.workspace ?? null) : null;
}

/** The line to show above the app: the operator's banner, or a plain notice for a read-only workspace without one. */
export function bannerText(workspace: Workspace | null | undefined): string | null {
  if (!workspace) return null;
  return workspace.banner?.trim() || (workspace.readOnly ? READ_ONLY_BANNER : null);
}

export interface BoardAccess {
  storeReadOnly: boolean;
  commentsReadOnly: boolean;
  /** Text of the badge next to the board name; null when the board is editable. */
  badge: string | null;
}

/**
 * What the person may do on a board: their role, and nothing at all while the workspace is read-only or the board is
 * deleted (only workspace admins can open a deleted board, and the relay refuses its writes until it is restored).
 * `newer` is a board that needs features this client lacks: nobody edits it from here, but comments still work.
 */
export function boardAccess(role: BoardRole | null | undefined, workspace: Workspace | null | undefined, deleted = false, newer = false): BoardAccess {
  if (deleted) return { storeReadOnly: true, commentsReadOnly: true, badge: DELETED_BADGE };
  const locked = workspace?.readOnly === true;
  const viewer = role === 'viewer';
  const commenter = role === 'commenter';
  return {
    storeReadOnly: newer || locked || viewer || commenter,
    commentsReadOnly: locked || viewer,
    badge: locked ? READ_ONLY_BADGE : commenter ? 'Can comment' : viewer ? 'View only' : null,
  };
}

/** Only the owner of a workspace that a control plane runs has a billing portal, and not when the workspace is provided free. */
export function canManageBilling(me: Me | null | undefined): boolean {
  return me?.workspace !== undefined && me.workspace.billing !== false && me.user.role === 'owner';
}

/** What the owner of a workspace provided free (`billing: false`) reads where Manage billing would be; null otherwise. */
export function freeWorkspaceNote(me: Me | null | undefined): string | null {
  return me?.workspace?.billing === false && me.user.role === 'owner' ? FREE_WORKSPACE_TEXT : null;
}

const TRIAL_ENDS_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/** The trial date label for the billing panel; invalid dates, and states other than `trialing`, stay hidden. */
export function trialStatusText(state: unknown, trialEndsAt: unknown): string | null {
  if (state !== 'trialing' || typeof trialEndsAt !== 'string' || trialEndsAt.length > 40) return null;
  const match = TRIAL_ENDS_AT_RE.exec(trialEndsAt);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 2000 || year > 2100) return null;
  const timestamp = Date.parse(trialEndsAt);
  if (Number.isNaN(timestamp)) return null;
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return `Free trial until ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
}

/** A readable text for the errors that only hosted workspaces produce; null for any other error. */
export function cloudErrorMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const fallback = ERROR_TEXT.get(error.code);
  if (fallback === undefined) return null;
  return error.message && error.message !== error.code ? error.message : fallback;
}

/** The portal address, if it is one the app may navigate to. */
export function portalTarget(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export const meChanged = (before: Me | null, after: Me): boolean => JSON.stringify(before) !== JSON.stringify(after);

export interface MeRefreshDeps {
  /** Only a signed-in person on a hosted workspace has anything to refresh. */
  active: () => boolean;
  /** Background tabs wait until they are seen again, so an idle workspace can sleep. */
  visible: () => boolean;
  fetchMe: () => Promise<Me>;
  apply: (me: Me) => void | Promise<void>;
  /** The server no longer knows this session. */
  expired: () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** The real timers when left out. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Asks the server who the user is every few minutes, so a banner or a read-only switch shows up without a reload. */
export function createMeRefresher(deps: MeRefreshDeps, ms = ME_REFRESH_MS) {
  const startTimer = deps.setTimeout ?? ((fn, delay) => setTimeout(fn, delay));
  const stopTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let busy = false;
  let missed = false;
  let hintTimer: unknown = null;
  let again = false;

  async function run(afterHint = false) {
    if (busy) {
      // The answer on its way may have been read before the change the hint is about, so ask once more when it lands.
      again ||= afterHint;
      return;
    }
    if (!deps.active()) return;
    if (!deps.visible()) {
      missed = true;
      return;
    }
    busy = true;
    missed = false;
    try {
      const me = await deps.fetchMe();
      // The person may have signed out while the request was in flight.
      if (deps.active()) await deps.apply(me);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) deps.expired();
    } finally {
      busy = false;
      if (again) {
        again = false;
        void run();
      }
    }
  }

  const handle = deps.setInterval(() => void run(), ms);
  return {
    /** Call when the tab is seen again: runs the refresh a hidden tab skipped. */
    resume: () => {
      if (missed) void run();
    },
    /**
     * The relay says the workspace changed. The hint is not trusted: it only brings the refresh forward, and hints that
     * come in a burst are one request.
     */
    hint: () => {
      if (hintTimer !== null) return;
      hintTimer = startTimer(() => {
        hintTimer = null;
        void run(true);
      }, HINT_COALESCE_MS);
    },
    stop: () => {
      deps.clearInterval(handle);
      if (hintTimer !== null) stopTimer(hintTimer);
      hintTimer = null;
    },
  };
}

/**
 * Reports the moment a workspace goes from read-only back to writable. `onUnlock` is where a board reconnects, so that
 * what was typed while the relay dropped updates is sent in a fresh sync. Nothing else counts: turning read-only, a
 * change of banner and a missing workspace (open mode, signed out) all leave it quiet. Call it with the first known
 * workspace to set the starting point, then on every change of the signed-in state.
 */
export function createUnlockWatcher(onUnlock: () => void): (workspace: Workspace | null | undefined) => void {
  let locked = false;
  return (workspace) => {
    if (!workspace) return;
    const unlocked = locked && !workspace.readOnly;
    locked = workspace.readOnly;
    if (unlocked) onUnlock();
  };
}
