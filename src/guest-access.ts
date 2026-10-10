import { authState, markGuestSessionEnded, onAuth, type AuthState } from './auth';
import type { BoardAccess } from './cloud-logic';
import type { DeniedReason } from './sync';
import type { Store } from './store';
import type { Comments } from './comments';

export const GUEST_ENDED_BANNER =
  'This join link has expired. You can still look around, but not edit.';
export const GUEST_ENDED_SYNC_LABEL = 'Join link expired';
export const GUEST_ENDED_SYNC_TIP = 'This join link has expired or was revoked. Comments are read only.';

export function guestSessionEnded(auth: AuthState, now = Date.now()): boolean {
  return auth.mode === 'guest' && (auth.guest.ended === true || auth.guest.expiresAt <= now);
}

export function guestDenialEnded(reason: DeniedReason): boolean {
  return reason === 'unauthenticated' || reason === 'no_access' || reason === 'access_removed';
}

export function guestAccessEnded(auth: AuthState, denied: DeniedReason | null, now = Date.now()): boolean {
  return guestSessionEnded(auth, now) || (auth.mode === 'guest' && denied !== null && guestDenialEnded(denied));
}

/** A connection's refusal belongs to the guest identity that opened it, never a later join in this tab. */
export function denialForGuestSession(guestIdAtOpen: string | null, auth: AuthState, denied: DeniedReason | null): DeniedReason | null {
  return guestIdAtOpen && auth.mode === 'guest' && auth.guest.guestId !== guestIdAtOpen ? null : denied;
}

/** A relay refusal always stops local writes too, so a refused update cannot be saved and replayed later. */
export function connectionAccess(access: BoardAccess, auth: AuthState, denied: DeniedReason | null, now = Date.now()): BoardAccess {
  const guestConnectionStopped = auth.mode === 'guest' && denied !== null && denied !== 'restoring';
  const locked = guestConnectionStopped || guestSessionEnded(auth, now);
  return {
    ...access,
    storeReadOnly: access.storeReadOnly || locked,
    commentsReadOnly: access.commentsReadOnly || locked,
  };
}

export function applyConnectionAccess(
  targets: { store: Pick<Store, 'setReadOnly'>; comments: Pick<Comments, 'setReadOnly'> },
  access: BoardAccess,
  auth: AuthState,
  denied: DeniedReason | null,
  now = Date.now(),
): BoardAccess {
  const effective = connectionAccess(access, auth, denied, now);
  targets.store.setReadOnly(effective.storeReadOnly);
  targets.comments.setReadOnly(effective.commentsReadOnly);
  return effective;
}

/** Retains a guest's terminal state across relay denials and turns a locally observed expiry into read-only auth state. */
export function watchGuestAccess(
  conn: { onDenied: (fn: (reason: DeniedReason) => void) => () => void },
  guestIdAtOpen: string | null,
  onChange: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const scheduleExpiry = () => {
    clearTimer();
    if (!guestIdAtOpen) return;
    const auth = authState();
    if (auth.mode !== 'guest' || auth.guest.guestId !== guestIdAtOpen || auth.guest.ended) return;
    if (auth.guest.expiresAt <= Date.now()) {
      markGuestSessionEnded(guestIdAtOpen);
      return;
    }
    timer = setTimeout(scheduleExpiry, Math.min(auth.guest.expiresAt - Date.now(), 2_147_483_647));
  };
  const unwatchAuth = onAuth(() => {
    scheduleExpiry();
    onChange();
  });
  const unwatchDenied = conn.onDenied((reason) => {
    const auth = authState();
    const belongsToThisGuest = denialForGuestSession(guestIdAtOpen, auth, reason) === reason;
    if (guestIdAtOpen && auth.mode === 'guest' && belongsToThisGuest && guestDenialEnded(reason)) markGuestSessionEnded(guestIdAtOpen);
    scheduleExpiry();
    onChange();
  });
  const resume = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    scheduleExpiry();
  };
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  doc?.addEventListener?.('visibilitychange', resume);
  win?.addEventListener?.('focus', resume);
  scheduleExpiry();
  return () => {
    clearTimer();
    unwatchAuth();
    unwatchDenied();
    doc?.removeEventListener?.('visibilitychange', resume);
    win?.removeEventListener?.('focus', resume);
  };
}
