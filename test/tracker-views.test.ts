import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import { createSavedView, deleteSavedView, getSavedView, listSavedViews, updateSavedView } from '../server/tracker/views.mjs';
import { createMilestone, createProject } from '../server/tracker/projects.mjs';
import { relateTickets } from '../server/tracker/relations.mjs';
import { createTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const open = () => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};
function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' });
  const member = directory.createUser({ email: 'member@example.com', name: 'Member', role: 'member' });
  return {
    directory,
    ownerActor: { id: owner.id, role: owner.role, name: owner.name },
    memberActor: { id: member.id, role: member.role, name: member.name },
  };
}
function expectCode(run: () => unknown, code: string) {
  let error: any;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(OpsError);
  expect(error.code).toBe(code);
  return error;
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('saved tracker views', () => {
  it('validates filters when created and applies shared filters as the runner', () => {
    const { directory, ownerActor, memberActor } = fixture();
    const ownerTicket = createTicket({ directory, actor: ownerActor, title: 'Owner assigned', assignee: 'me' });
    const memberTicket = createTicket({ directory, actor: ownerActor, title: 'Member assigned', assignee: 'Member' });
    const view = createSavedView({ directory, actor: ownerActor, name: 'My work', filter: ['assignee:me'], shared: true });
    expect(view).toMatchObject({ name: 'My work', filter: ['assignee:me'], sort: 'updated_desc', shared: true });
    expect(directory.db.prepare('SELECT query_json FROM saved_views WHERE id = ?').get(view.id).query_json)
      .toBe(JSON.stringify({ filter: ['assignee:me'], sort: 'updated_desc' }));
    expect(getSavedView({ directory, actor: ownerActor, viewId: view.id }).tickets.map((ticket: any) => ticket.key)).toEqual([ownerTicket.key]);
    expect(getSavedView({ directory, actor: memberActor, viewId: view.id }).tickets.map((ticket: any) => ticket.key)).toEqual([memberTicket.key]);
    expect(listSavedViews({ directory, actor: memberActor })).toEqual([view]);
    expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'Bad filter', filter: ['nope:value'] }), 'invalid_filter');
  });

  it('accepts the expanded grammar at create and update time and rejects bad new tokens', () => {
    const { directory, ownerActor } = fixture();
    const project = createProject({ directory, actor: ownerActor, name: 'Product' });
    createMilestone({ directory, actor: ownerActor, projectId: project.id, name: 'V1', due: '2026-12-01' });
    const parent = createTicket({ directory, actor: ownerActor, title: 'Saved view parent' });
    createTicket({ directory, actor: ownerActor, title: 'Saved view child', parent: parent.key });
    const blocker = createTicket({ directory, actor: ownerActor, title: 'Saved view blocker' });
    const blocked = createTicket({ directory, actor: ownerActor, title: 'Saved view blocked' });
    const related = createTicket({ directory, actor: ownerActor, title: 'Saved view related' });
    const duplicate = createTicket({ directory, actor: ownerActor, title: 'Saved view duplicate' });
    const original = createTicket({ directory, actor: ownerActor, title: 'Saved view original' });
    relateTickets({ directory, actor: ownerActor, key: blocker.key, relation: 'blocks', otherKey: blocked.key });
    relateTickets({ directory, actor: ownerActor, key: blocker.key, relation: 'relates_to', otherKey: related.key });
    relateTickets({ directory, actor: ownerActor, key: duplicate.key, relation: 'duplicates', otherKey: original.key });

    const initialFilter = [
      '-state:done,cancelled', 'assignee:none', 'creator:me', 'priority:none', 'category:started',
      'updated:after-2026-10-01', 'updated:before-2026-10-12', 'created:before-2026-10-12',
      'due:none', 'due:this-week', 'due:after-2026-10-10', 'project:Product', 'project:none',
      'milestone:V1', 'milestone:none', 'is:blocked', 'is:blocking', 'has:relation', 'has:parent', 'has:sub',
    ];
    const view = createSavedView({ directory, actor: ownerActor, name: 'New grammar', filter: initialFilter });
    expect(view.filter).toEqual(initialFilter);
    expect(expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'Unknown project', filter: ['project:Missing'] }), 'invalid_filter'))
      .toMatchObject({ path: 'project:Missing' });
    expect(expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'Bad category', filter: ['category:done'] }), 'invalid_filter'))
      .toMatchObject({ path: 'category:done' });

    const updatedFilter = [
      'has:link', 'is:archived', `parent:${parent.key}`, `blocks:${blocked.key}`, `blocked-by:${blocker.key}`,
      `relates:${related.key}`, `duplicates:${original.key}`, `duplicated-by:${duplicate.key}`,
    ];
    expect(updateSavedView({ directory, actor: ownerActor, viewId: view.id, patch: { filter: updatedFilter } }).filter)
      .toEqual(updatedFilter);
    expect(expectCode(() => updateSavedView({ directory, actor: ownerActor, viewId: view.id, patch: { filter: ['blocks:TAB-99999'] } }), 'invalid_filter'))
      .toMatchObject({ path: 'blocks:TAB-99999' });
    expect(getSavedView({ directory, actor: ownerActor, viewId: view.id }).view.filter).toEqual(updatedFilter);
  });

  it('supports cursor paging and keeps private views invisible to other members', () => {
    const { directory, ownerActor, memberActor } = fixture();
    const tickets = [1, 2, 3].map((index) => createTicket({ directory, actor: ownerActor, title: `Page ${index}`, now: 10 }));
    const view = createSavedView({ directory, actor: ownerActor, name: 'Pages', filter: ['state:todo'] });
    const first = getSavedView({ directory, actor: ownerActor, viewId: view.id, limit: 2 });
    expect(first.tickets).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = getSavedView({ directory, actor: ownerActor, viewId: view.id, limit: 2, cursor: first.nextCursor });
    expect(second.tickets).toHaveLength(1);
    expect([...first.tickets, ...second.tickets].map((ticket: any) => ticket.key).sort()).toEqual(tickets.map((ticket: any) => ticket.key).sort());

    const privateView = createSavedView({ directory, actor: ownerActor, name: 'Private' });
    expect(listSavedViews({ directory, actor: memberActor })).toEqual([]);
    expectCode(() => getSavedView({ directory, actor: memberActor, viewId: privateView.id }), 'not_found');
  });

  it('allows only the owner to rename, share, unshare, or delete a shared view', () => {
    const { directory, ownerActor, memberActor } = fixture();
    const view = createSavedView({ directory, actor: ownerActor, name: 'Shared', shared: true });
    expectCode(() => updateSavedView({ directory, actor: memberActor, viewId: view.id, patch: { name: 'Hijack' } }), 'forbidden');
    expectCode(() => deleteSavedView({ directory, actor: memberActor, viewId: view.id }), 'forbidden');
    const updated = updateSavedView({ directory, actor: ownerActor, viewId: view.id, patch: { name: 'Renamed', shared: false, filter: ['state:todo'] } });
    expect(updated).toMatchObject({ name: 'Renamed', shared: false, filter: ['state:todo'] });
    expectCode(() => getSavedView({ directory, actor: memberActor, viewId: view.id }), 'not_found');
    expect(deleteSavedView({ directory, actor: ownerActor, viewId: view.id })).toEqual({ id: view.id, deleted: true });
    expectCode(() => getSavedView({ directory, actor: ownerActor, viewId: view.id }), 'not_found');
  });

  it('caps query bytes and saved views per member, and blocks writes before mutation in read-only mode', () => {
    const { directory, ownerActor } = fixture();
    const wideFilter = Array.from({ length: 20 }, () => `state:${'x'.repeat(500)}`);
    expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'Too large', filter: wideFilter }), 'limit_exceeded');
    for (let index = 0; index < 100; index++) createSavedView({ directory, actor: ownerActor, name: `View ${index}` });
    expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'View 100' }), 'limit_exceeded');
    const before = directory.db.prepare('SELECT COUNT(*) AS n FROM saved_views').get().n;
    expectCode(() => createSavedView({ directory, actor: ownerActor, name: 'Read only', readOnly: () => true }), 'read_only');
    const first = listSavedViews({ directory, actor: ownerActor })[0];
    expectCode(() => updateSavedView({ directory, actor: ownerActor, viewId: first.id, patch: { name: 'Blocked' }, readOnly: () => true }), 'read_only');
    expectCode(() => deleteSavedView({ directory, actor: ownerActor, viewId: first.id, readOnly: () => true }), 'read_only');
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM saved_views').get().n).toBe(before);
  });
});
