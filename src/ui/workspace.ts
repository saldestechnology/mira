import './workspace.css';
import { authState, leaveGuestSession, onAuth } from '../auth';
import { bannerText, workspaceOf } from '../cloud-logic';
import { guestAccessEnded } from '../guest-access';
import { h } from './dom';

/**
 * The thin line a hosted workspace's operator can put above the app (docs/cloud.md). It follows the signed-in user's
 * /api/me, so a banner that arrives with the next refresh appears without a reload, and it stops listening once it
 * has been removed from the page. `onVisible` tells the page whether there is a banner to make room for.
 */
export function createWorkspaceBanner(onVisible?: (visible: boolean) => void, notice?: () => string | null): { el: HTMLElement; dispose: () => void } {
  const el = h('div', { class: 'workspace-banner', role: 'status' });
  const paint = () => {
    const auth = authState();
    const text = notice?.() ?? bannerText(workspaceOf(auth));
    el.replaceChildren();
    if (text) {
      el.appendChild(document.createTextNode(text));
      if (guestAccessEnded(auth, null)) {
        el.appendChild(document.createTextNode(' '));
        el.appendChild(h('a', {
          class: 'workspace-banner-signin', href: '#/signin',
          onclick: (event: MouseEvent) => {
            if (!guestAccessEnded(authState(), null)) return;
            event.preventDefault();
            leaveGuestSession();
            location.hash = '#/signin';
          },
        }, 'Sign in'));
      }
    }
    el.title = text ?? '';
    el.hidden = text === null;
    onVisible?.(text !== null);
  };
  const dispose = onAuth(() => {
    if (el.isConnected) paint();
    else dispose();
  });
  paint();
  return { el, dispose };
}
