import type { CreatedJoinCode, JoinCodeInfo } from '../api';
import { api } from '../api';
import { toast } from './common';
import { h } from './dom';

const labelRole = (role: 'commenter' | 'editor') => role === 'editor' ? 'Editor' : 'Commenter';
const date = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
const active = (code: JoinCodeInfo, now = Date.now()) => code.revokedAt === null && code.expiresAt > now && code.uses < code.maxUses;

/** Board scoped join-code controls for the Share dialog. The clear code stays in this tab after creation only. */
export function mountJoinCodes(boardId: string): HTMLElement {
  let codes: JoinCodeInfo[] = [];
  let recent: CreatedJoinCode | null = null;
  let failure: string | null = null;

  const list = h('div', { class: 'join-code-list' });
  const status = h('div', { class: 'share-status muted small', 'aria-live': 'polite' });
  const section = h('section', { class: 'share-join-codes', 'aria-label': 'Join code' },
    h('div', { class: 'share-label' }, 'Join code'),
    h('p', { class: 'join-code-intro muted small' }, 'Let a guest join this board without an account. Codes expire automatically.'),
    h('form', { class: 'join-code-create' }),
    list,
    status,
  );
  const form = section.querySelector('form')!;
  const role = h('select', { class: 'input', 'aria-label': 'Guest role' },
    h('option', { value: 'commenter' }, 'Commenter'),
    h('option', { value: 'editor' }, 'Editor'));
  const expiry = h('select', { class: 'input', 'aria-label': 'Expires after' },
    ...[3, 6, 12, 24].map((hours) => h('option', { value: String(hours), selected: hours === 3 }, `${hours} hours`)));
  const maxUses = h('input', { class: 'input join-code-uses', type: 'number', min: '1', max: '1000', value: '100', 'aria-label': 'Maximum uses' });
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'Create code');
  const field = (label: string, control: HTMLElement) => h('label', { class: 'join-code-field' }, h('span', null, label), control);
  form.replaceChildren(field('Guest role', role), field('Expires after', expiry), field('Maximum uses', maxUses), create);

  const setStatus = (message: string) => { status.textContent = message; };

  const render = () => {
    const rows: Node[] = [];
    if (recent) {
      const link = `${location.origin}/join?c=${encodeURIComponent(recent.code)}`;
      const codeValue = h('input', { class: 'join-code-value', value: recent.code, readonly: true, 'aria-label': 'New join code' });
      const linkInput = h('input', { class: 'input join-code-link', value: link, readonly: true, 'aria-label': 'Copyable join link' });
      const copy = (value: string, input?: HTMLInputElement) => {
        if (!navigator.clipboard?.writeText) {
          input?.select();
          return;
        }
        void navigator.clipboard.writeText(value).then(() => setStatus('Copied to clipboard'), () => input?.select());
      };
      rows.push(h('div', { class: 'join-code-created', role: 'status' },
        h('div', { class: 'join-code-created-head' },
          h('span', { class: 'muted small' }, `${labelRole(recent.role)} · expires ${date(recent.expiresAt)}`),
          h('button', { class: 'btn', type: 'button', onclick: () => copy(recent!.code, codeValue) }, 'Copy code')),
        codeValue,
        h('div', { class: 'join-code-link-row' }, linkInput,
          h('button', { class: 'btn', type: 'button', onclick: () => copy(link, linkInput) }, 'Copy link')),
        h('p', { class: 'muted small' }, 'This code is shown once. Copy it now and share it privately.')));
    }
    if (failure) rows.push(h('div', { class: 'share-error', role: 'alert' },
      h('span', null, failure), h('button', { class: 'btn', type: 'button', onclick: () => void load() }, 'Retry')));
    if (codes.length === 0 && !failure) rows.push(h('p', { class: 'muted small' }, 'No join codes yet.'));
    for (const code of codes) {
      const state = code.revokedAt !== null ? 'Revoked' : code.expiresAt <= Date.now() ? 'Expired' : code.uses >= code.maxUses ? 'Used up' : `Expires ${date(code.expiresAt)}`;
      const revoke = h('button', {
        class: 'btn', type: 'button', disabled: !active(code), 'aria-label': `Revoke ${labelRole(code.role)} join code`,
        onclick: async () => {
          revoke.disabled = true;
          try {
            await api.revokeJoinCode(boardId, code.id);
            code.revokedAt = Date.now();
            if (recent?.id === code.id) recent = null;
            setStatus('Join code revoked');
            render();
          } catch (err) {
            revoke.disabled = false;
            toast(err instanceof Error ? err.message : 'Could not revoke this join code.');
          }
        },
      }, code.revokedAt !== null ? 'Revoked' : 'Revoke');
      rows.push(h('div', { class: 'join-code-row' },
        h('div', { class: 'join-code-meta' },
          h('strong', null, labelRole(code.role)),
          h('span', { class: 'muted small' }, `${code.uses} of ${code.maxUses} uses · ${state}`)),
        revoke));
    }
    list.replaceChildren(...rows);
  };

  const load = async () => {
    failure = null;
    try {
      codes = await api.joinCodes(boardId);
    } catch (err) {
      failure = err instanceof Error ? err.message : 'Could not load join codes.';
    }
    render();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const uses = Number(maxUses.value);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
      maxUses.setAttribute('aria-invalid', 'true');
      setStatus('Maximum uses must be from 1 to 1000');
      return;
    }
    maxUses.removeAttribute('aria-invalid');
    create.disabled = true;
    create.textContent = 'Creating…';
    try {
      recent = await api.createJoinCode(boardId, {
        role: role.value as 'commenter' | 'editor',
        expiresInHours: Number(expiry.value),
        maxUses: uses,
      });
      codes = await api.joinCodes(boardId);
      setStatus('Join code created');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Could not create a join code.');
    }
    create.disabled = false;
    create.textContent = 'Create code';
    render();
    const created = section.querySelector<HTMLElement>('.join-code-created');
    const copyCode = created?.querySelector<HTMLButtonElement>('.join-code-created-head button');
    const supportsMediaQuery = typeof matchMedia === 'function';
    const phone = supportsMediaQuery && matchMedia('(max-width: 480px)').matches;
    const reducedMotion = supportsMediaQuery && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (phone) {
      // The clear code is shown once; reveal the panel inside the phone-sized dialog and make copying the next action.
      created?.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    } else {
      // Preserve the existing desktop alignment.
      created?.scrollIntoView?.({ block: 'center' });
    }
    copyCode?.focus({ preventScroll: true });
  });

  void load();
  return section;
}
