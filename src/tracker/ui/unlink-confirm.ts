import './unlink-confirm.css';
import { dialog, toast } from '../../ui/common';
import { h } from '../../ui/dom';
import { registerUnlinkConfirm } from './link-seam';

export function confirmUnlink(opts: { cardCount: number }): Promise<boolean> {
  const count = Number.isFinite(opts.cardCount) ? Math.max(0, Math.floor(opts.cardCount)) : 0;
  const singular = count === 1;
  const bodyText = singular
    ? 'The card stays on this board with its title and lane. The ticket stays in the tracker. The card will no longer follow ticket changes.'
    : `The ${count} cards stay on this board with their titles and lanes. The tickets stay in the tracker. The cards will no longer follow ticket changes.`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = dialog('Unlink from tracker?', h('p', { class: 'trk-unlink-copy' }, bodyText), [
      { label: 'Unlink', primary: true, onClick: () => { settle(true); } },
      { label: 'Cancel', onClick: () => { settle(false); } },
    ], { className: 'trk trk-unlink-back', onClose: () => settle(false) });
    requestAnimationFrame(() => {
      const cancel = Array.from(modal.box.querySelectorAll<HTMLButtonElement>('.modal-actions button')).find((button) => button.textContent === 'Cancel');
      cancel?.focus({ preventScroll: true });
    });
  });
}

export function installTrackerUnlinkConfirm(): () => void {
  return registerUnlinkConfirm(async (context) => {
    const count = Number.isFinite(context.link.ticketCount) ? Math.max(0, Math.floor(context.link.ticketCount)) : 0;
    if (!await confirmUnlink({ cardCount: count })) return;
    try {
      await context.store.unlinkKanban(context.link.id);
      toast(`Unlinked. ${count} ${count === 1 ? 'card' : 'cards'} are plain cards again.`);
    } catch {
      toast("Couldn't unlink. Try again.");
    }
  });
}
