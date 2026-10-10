import type { TrackerMeta, TrackerTicket } from '../../tracker-types';
import type { TrackerMockSeed } from '../../tracker-mock';

const states = [
  { id: 'state-todo', key: 'todo', name: 'To do', category: 'unstarted' as const, position: 0 },
  { id: 'state-progress', key: 'in_progress', name: 'In progress', category: 'started' as const, position: 1 },
  { id: 'state-review', key: 'in_review', name: 'In review', category: 'started' as const, position: 2 },
  { id: 'state-done', key: 'done', name: 'Done', category: 'completed' as const, position: 3 },
  { id: 'state-cancelled', key: 'cancelled', name: 'Cancelled', category: 'canceled' as const, position: 4 },
];
const labels = [
  { id: 'label-platform', name: 'Platform', color: '#2F6FED' },
  { id: 'label-accessibility', name: 'Accessibility', color: '#1E9A6A' },
  { id: 'label-bug', name: 'Bug', color: '#D64545' },
];
const members = [
  { userId: 'user-me', name: 'Johan', initials: 'JO' },
  { userId: 'user-mara', name: 'Mara', initials: 'MA' },
  { userId: 'user-ana', name: 'Ana', initials: 'AN' },
];
const projects = [
  { id: 'project-foundation', name: 'Foundation' },
  { id: 'project-canvas', name: 'Canvas' },
  { id: 'project-mobile', name: 'Mobile' },
];
const titles = [
  'Keep selection anchored while the camera moves',
  'Expose a compact state picker in the issue row',
  'Make the filter bar easier to scan at narrow widths',
  'Restore the previous camera after opening a tracker',
  'Reduce duplicate refreshes after an inline edit',
  'Use a two-line layout for phone issue rows',
  'Add keyboard focus to grouped section headers',
  'Preserve draft text when the create dialog closes',
  'Align due dates to the workspace calendar',
  'Show the current assignee beside the issue key',
  'Keep snapshot text readable at overview scale',
  'Make archive undo available from the selection bar',
];

const meta: TrackerMeta = {
  enabled: true, trackerId: 'tracker-demo', prefix: 'TAB', states, labels, members,
  me: { userId: 'user-me', canWrite: true },
};

function ticket(index: number, now: number): TrackerTicket {
  const state = states[index % states.length];
  const member = members[index % members.length];
  const project = projects[index % projects.length];
  const priority: TrackerTicket['priority'] = ['urgent', 'high', 'medium', 'low', 'none'][index % 5] as TrackerTicket['priority'];
  return {
    id: `ticket-${index + 1}`, key: `TAB-${index + 101}`, trackerId: meta.trackerId, title: titles[index],
    description: `A seeded example issue for the tracker visual review.\n\n- Row ${index + 1}\n- ${state.name}`,
    state: { id: state.id, key: state.key, name: state.name, category: state.category }, priority,
    assignee: index % 4 === 0 ? null : { userId: member.userId, name: member.name },
    creator: { type: 'user', id: member.userId, name: member.name },
    labels: [labels[index % labels.length]], project,
    milestone: null, estimate: null, due: index % 4 === 0 ? null : new Date(now + (index - 3) * 86_400_000).toISOString().slice(0, 10),
    parent: null, relations: [], links: [], aliases: [], archivedAt: null,
    createdAt: now - (index + 2) * 86_400_000, updatedAt: now - index * 7_200_000, updatedSeq: index + 1,
  };
}

export function createTrackerVisualSeed(): TrackerMockSeed {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  return { meta, tickets: titles.map((_, index) => ticket(index, now)), now: () => now };
}
