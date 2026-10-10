import './join.css';
import { ApiError, api, type GuestJoin } from '../api';
import { setGuest } from '../auth';
import { h } from './dom';

const INVALID = 'This code is no longer valid. Ask the board owner for a new one.';
const NETWORK = 'Could not reach the server. Check your connection and try again.';

function page(...body: (Node | null)[]): HTMLElement {
  return h('main', { class: 'signin join-page' },
    h('header', { class: 'signin-top' }, h('div', { class: 'wordmark' }, 'Tabula')),
    h('div', { class: 'signin-body' }, h('div', { class: 'signin-col' }, ...body)));
}

/** A join code as typed or pasted: no spaces, upper case, at most 8 characters. */
export function cleanCode(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase().slice(0, 8);
}

function cleanName(value: string): string {
  return value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim();
}

function clearJoinCodeFromUrl(): void {
  if (typeof window === 'undefined' || !window.location || !window.history) return;
  const { location, history } = window;
  if (typeof location.search !== 'string' || typeof history.replaceState !== 'function') return;
  const search = new URLSearchParams(location.search);
  const hasSearchCode = search.has('c');
  if (hasSearchCode) search.delete('c');

  let hash = location.hash;
  const hashQueryAt = hash.indexOf('?');
  if (hashQueryAt >= 0 && hash.slice(0, hashQueryAt) === '#/join') {
    const hashQuery = new URLSearchParams(hash.slice(hashQueryAt + 1));
    if (hashQuery.has('c')) {
      hashQuery.delete('c');
      const query = hashQuery.toString();
      hash = `${hash.slice(0, hashQueryAt)}${query ? `?${query}` : ''}`;
    }
  }

  if (!hasSearchCode && hash === location.hash) return;
  const query = search.toString();
  history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${hash}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404 || error.code === 'invalid_join_code') return INVALID;
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (error.status === 0 || error.code === 'network') return NETWORK;
    if (error.code === 'bad_request') return 'Use 1 to 40 characters';
  }
  return 'Could not join this board. Try again.';
}

export function renderJoin(root: HTMLElement, initialCode: string, done: (guest: GuestJoin) => void): void {
  document.title = 'Join a board - Tabula';
  const code = h('input', {
    class: 'input join-code-input', name: 'code', type: 'text', value: cleanCode(initialCode),
    id: 'join-code', minlength: '6', required: true, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false,
    'aria-label': 'Join code', 'aria-describedby': 'join-code-error',
  });
  const codeError = h('p', { id: 'join-code-error', class: 'signin-error', role: 'alert', hidden: true });
  // people write codes in groups ("ABCD EFGH") and paste them with spaces: drop the spaces before the length limit applies
  code.addEventListener('input', () => {
    const clean = cleanCode(code.value);
    if (clean !== code.value) code.value = clean;
  });
  const name = h('input', {
    class: 'input', id: 'join-name', name: 'name', type: 'text', maxlength: '40', minlength: '1', required: true,
    autocomplete: 'name', 'aria-label': 'Display name', 'aria-describedby': 'join-name-help join-name-error',
  });
  const nameError = h('p', { id: 'join-name-error', class: 'signin-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Join board');
  const form = h('form', { class: 'signin-form join-form', noValidate: true },
    h('div', { class: 'signin-field' }, h('label', { for: 'join-code' }, 'Join code'), code, codeError),
    h('div', { class: 'signin-field' }, h('label', { for: 'join-name' }, 'Display name'), name,
      h('span', { id: 'join-name-help', class: 'join-name-help' }, '1 to 40 characters after cleanup.'), nameError),
    submit);
  let error: HTMLElement | null = null;
  const clearInlineErrors = () => {
    codeError.hidden = true;
    nameError.hidden = true;
    code.removeAttribute('aria-invalid');
    name.removeAttribute('aria-invalid');
  };
  const showInlineError = (field: 'code' | 'name', message: string) => {
    const input = field === 'code' ? code : name;
    const target = field === 'code' ? codeError : nameError;
    target.textContent = message;
    target.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  code.addEventListener('input', () => {
    if (!codeError.hidden) {
      codeError.hidden = true;
      code.removeAttribute('aria-invalid');
    }
  });
  name.addEventListener('input', () => {
    if (!nameError.hidden) {
      nameError.hidden = true;
      name.removeAttribute('aria-invalid');
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearJoinCodeFromUrl();
    error?.remove();
    error = null;
    clearInlineErrors();
    const value = cleanCode(code.value);
    if (!value) {
      showInlineError('code', 'Enter the code you were given');
      return;
    }
    if (value.length < 6) {
      showInlineError('code', 'That code looks too short');
      return;
    }
    const cleanedName = cleanName(name.value);
    if (!cleanedName) {
      showInlineError('name', 'Enter a display name');
      return;
    }
    if ([...cleanedName].length > 40) {
      showInlineError('name', 'Use 1 to 40 characters');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Joining…';
    try {
      const joined = await api.joinWithCode(cleanCode(code.value), cleanedName);
      setGuest(joined);
      done(joined);
    } catch (err) {
      const message = errorMessage(err);
      if (err instanceof ApiError && (err.status === 404 || err.code === 'invalid_join_code')) showInlineError('code', message);
      else if (err instanceof ApiError && err.code === 'bad_request') showInlineError('name', message);
      else {
        error = h('p', { class: 'signin-error', role: 'alert' }, message);
        submit.before(error);
      }
      submit.disabled = false;
      submit.textContent = 'Join board';
    }
  });

  root.replaceChildren(page(
    h('h1', null, 'Join with a code'),
    h('p', { class: 'signin-lede' }, 'Enter the code you received and the name people will see on the board.'),
    form,
  ));
  (initialCode ? name : code).focus();
}
