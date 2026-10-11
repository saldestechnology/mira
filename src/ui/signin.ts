import './signin.css';
import { ApiError, api, type InvitePreview, type Me } from '../api';
import { setSignedIn, type AuthState } from '../auth';
import { cloudErrorMessage } from '../cloud-logic';
import { h } from './dom';

interface SignInOptions {
  notice?: string;
  invite?: { token: string; teamName: string };
}

const NETWORK = 'Could not reach the server. Check your connection and try again.';
const FAILED = 'Could not sign you in. Try again.';
const GENERIC = 'Something went wrong. Try again.';

function page(...body: (Node | null)[]): HTMLElement {
  return h('main', { class: 'signin' },
    h('header', { class: 'signin-top' }, h('div', { class: 'wordmark' }, 'Tabula')),
    h('div', { class: 'signin-body' }, h('div', { class: 'signin-col' }, ...body)));
}

function describe(err: unknown): string {
  if (!(err instanceof ApiError)) return GENERIC;
  if (err.status === 429) return 'Too many sign-in requests. Try again in an hour.';
  if (err.status === 0 || err.code === 'network') return NETWORK;
  return err.code === 'unknown' ? GENERIC : err.message;
}

export function renderSignIn(root: HTMLElement, opts: SignInOptions = {}): void {
  const invite = opts.invite;
  document.title = invite ? `Join ${invite.teamName} - Tabula` : 'Sign in - Tabula';
  const heading = invite ? `Join ${invite.teamName}` : 'Sign in to Tabula';

  function showForm(notice?: string): void {
    const input = h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'email', required: true });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Email me a link');
    let error: HTMLElement | null = null;
    const setError = (msg: string | null) => {
      error?.remove();
      error = null;
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      if (msg) {
        error = h('p', { class: 'signin-error', id: 'signin-error', role: 'alert' }, msg);
        submit.before(error);
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'signin-error');
      }
    };

    const onSubmit = async (e: Event) => {
      e.preventDefault();
      const email = input.value.trim();
      setError(null);
      submit.disabled = true;
      submit.textContent = 'Sending…';
      try {
        await api.requestLogin(email, invite?.token);
      } catch (err) {
        setError(describe(err));
        submit.disabled = false;
        submit.textContent = 'Email me a link';
        return;
      }
      showSent(email);
    };

    root.replaceChildren(page(
      h('h1', null, heading),
      h('p', { class: 'signin-lede' }, 'Enter your work email and we\'ll send you a link to sign in.'),
      notice ? h('p', { class: 'signin-notice', role: 'status' }, notice) : null,
      h('form', { class: 'signin-form', onsubmit: onSubmit },
        h('label', { class: 'signin-field' }, 'Email', input),
        submit),
    ));
    input.focus();
  }

  function showSent(email: string): void {
    root.replaceChildren(page(
      h('h1', null, 'Check your email'),
      h('p', { class: 'signin-lede', role: 'status' },
        'We sent a sign-in link to ', h('b', null, email), '. It works once and expires in 15 minutes.'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => showForm() }, 'Use a different email'),
    ));
  }

  showForm(opts.notice);
}

export async function renderVerify(root: HTMLElement, token: string, done: (me: Me) => void): Promise<void> {
  document.title = 'Signing in - Tabula';
  root.replaceChildren(page(h('p', { class: 'signin-lede', role: 'status' }, 'Signing you in…')));
  try {
    await api.verifyLogin(token);
  } catch (err) {
    const expired = err instanceof ApiError && (err.code === 'invalid_token' || err.status === 400);
    renderSignIn(root, {
      notice: cloudErrorMessage(err) ?? (expired ? 'This link has expired or was already used. Request a new one.' : FAILED),
    });
    return;
  }
  let me: Me;
  try {
    me = await api.me();
  } catch {
    renderSignIn(root, { notice: FAILED });
    return;
  }
  await setSignedIn(me);
  done(me);
}

export async function renderInvite(root: HTMLElement, token: string, auth: AuthState, done: (me: Me) => void): Promise<void> {
  document.title = 'Join team - Tabula';
  root.replaceChildren(page(h('p', { class: 'signin-lede', role: 'status' }, 'Checking your invite…')));

  let preview: InvitePreview;
  try {
    preview = await api.invitePreview(token);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
      root.replaceChildren(page(
        h('h1', null, 'This invite is no longer valid'),
        h('p', { class: 'signin-lede' }, 'Ask the person who invited you for a new link.'),
        h('a', { class: 'btn', href: '#/signin' }, 'Sign in'),
      ));
    } else {
      root.replaceChildren(page(
        h('h1', null, 'Could not load this invite'),
        h('p', { class: 'signin-lede' }, 'Check your connection and try again.'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => renderInvite(root, token, auth, done) }, 'Try again'),
      ));
    }
    return;
  }

  const { team, role } = preview;
  if (auth.mode !== 'signed-in') {
    renderSignIn(root, { invite: { token, teamName: team.name } });
    return;
  }

  const joinBtn = h('button', { type: 'button', class: 'btn primary' }, 'Join team');
  let error: HTMLElement | null = null;
  const join = async () => {
    error?.remove();
    error = null;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    let me: Me;
    try {
      await api.acceptInvite(token);
      me = await api.me();
    } catch (err) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join team';
      error = h('p', { class: 'signin-error', role: 'alert' }, describe(err));
      joinBtn.before(error);
      return;
    }
    await setSignedIn(me);
    done(me);
  };
  joinBtn.addEventListener('click', join);

  root.replaceChildren(page(
    h('h1', null, `Join ${team.name}`),
    h('p', { class: 'signin-lede' }, `You've been invited to join as ${role === 'admin' ? 'an admin' : 'a member'}.`),
    joinBtn,
  ));
}
