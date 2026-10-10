import './tracker.css';
import { buildTrackerPath } from '../../tracker-route';
import { chipModel } from '../../tracker-chips';
import type { TrackerTicket } from '../../tracker-types';
import { h } from '../../ui/dom';
import { stateGlyph } from './glyphs';

export interface TicketChipValue {
  key: string;
  title: string;
  stateName: string;
  stateKey: string;
  stateCategory: TrackerTicket['state']['category'];
  href: string;
}

/** DOM-facing projection of the shared tracker chip model. */
export function ticketChipValue(ticket: Pick<TrackerTicket, 'key' | 'title' | 'state'>): TicketChipValue {
  const model = chipModel(ticket.key, () => ticket as TrackerTicket);
  return {
    key: model.key,
    title: model.title,
    stateName: model.state?.name ?? ticket.state.name,
    stateKey: ticket.state.key,
    stateCategory: model.state?.category ?? ticket.state.category,
    href: buildTrackerPath({ kind: 'ticket', key: model.key }) ?? '/t/' + encodeURIComponent(model.key),
  };
}

/** DOM builder over the shared chip model; ticket text stays in text nodes. */
export function ticketChip(ticket: Pick<TrackerTicket, 'key' | 'title' | 'state'>): HTMLAnchorElement {
  const value = ticketChipValue(ticket);
  return h('a', {
    class: 'trk-ticket-chip', href: value.href,
    'aria-label': `${value.key}, ${value.stateName}: ${value.title}`,
  }, stateGlyph(value.stateCategory, value.stateKey), h('strong', null, value.key), h('span', null, value.title));
}
