import { afterEach, describe, expect, it } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { OpsError } from '../server/board-ops.mjs';
import { refreshTicketSearch, buildFtsQuery, SEARCH_LIMITS } from '../server/tracker/search.mjs';
import { createMilestone, createProject } from '../server/tracker/projects.mjs';
import { relateTickets } from '../server/tracker/relations.mjs';
import { commentTicket, createLabel, createTicket, listTickets, searchTickets, transitionTicket, updateTicket } from '../server/tracker/tickets.mjs';

const opened: any[] = [];
const NOW = Date.UTC(2026, 9, 10, 12);
const open = (): any => {
  const directory: any = openDirectory(':memory:');
  opened.push(directory);
  return directory;
};

function fixture() {
  const directory = open();
  const owner = directory.createUser({ email: 'owner@example.com', name: 'Owner', role: 'owner' })!;
  const ada = directory.createUser({ email: 'ada@example.com', name: 'Ada', role: 'member' })!;
  const actor = { id: owner.id, role: owner.role, name: owner.name };
  return { directory, owner, ada, actor };
}

afterEach(() => {
  for (const directory of opened.splice(0)) directory.close();
});

describe('tracker search filters and ranking', () => {
  it('applies every slice 1 filter with UTC calendar dates', () => {
    const { directory, owner, ada, actor } = fixture();
    createLabel({ directory, actor, name: 'Bug' });
    const alpha = createTicket({ directory, actor, title: 'Alpha stable', assignee: 'Ada', due: '2026-10-09', labels: ['bug'], now: NOW });
    const beta = createTicket({ directory, actor, title: 'Beta stable', assignee: 'me', due: '2026-10-10', now: NOW });
    const gamma = createTicket({ directory, actor, title: 'Gamma stable', now: NOW });
    transitionTicket({ directory, actor, key: gamma.key, state: 'done', now: NOW });

    expect(listTickets({ directory, actor, filters: ['assignee:me'], now: NOW }).entries.map((t: any) => t.key)).toEqual([beta.key]);
    expect(listTickets({ directory, actor, filters: ['assignee:Ada'], now: NOW }).entries.map((t: any) => t.key)).toEqual([alpha.key]);
    expect(listTickets({ directory, actor, filters: ['assignee:ada@example.com'], now: NOW }).entries.map((t: any) => t.key)).toEqual([alpha.key]);
    expect(listTickets({ directory, actor, filters: ['state:done'], now: NOW }).entries.map((t: any) => t.key)).toEqual([gamma.key]);
    expect(listTickets({ directory, actor, filters: ['label:BUG'], now: NOW }).entries.map((t: any) => t.key)).toEqual([alpha.key]);
    expect(listTickets({ directory, actor, filters: ['due:overdue'], now: NOW }).entries.map((t: any) => t.key)).toEqual([alpha.key]);
    expect(listTickets({ directory, actor, filters: ['due:today'], now: NOW }).entries.map((t: any) => t.key)).toEqual([beta.key]);
    expect(listTickets({ directory, actor, filters: ['due:before-2026-10-11'], now: NOW }).total).toBe(2);
    expect(listTickets({ directory, actor, filters: ['has:link'], now: NOW }).total).toBe(0);
    expect(listTickets({ directory, actor, filters: ['created:after-2026-10-10'], now: NOW }).total).toBe(3);

    updateTicket({ directory, actor, key: alpha.key, patch: { archived: true }, now: NOW });
    expect(listTickets({ directory, actor, now: NOW }).entries.map((t: any) => t.key)).not.toContain(alpha.key);
    expect(listTickets({ directory, actor, filters: ['is:archived'], now: NOW }).entries.map((t: any) => t.key)).toEqual([alpha.key]);
    expect(listTickets({ directory, actor, filters: ['due:overdue'], now: NOW }).entries.map((t: any) => t.key)).toEqual([]);
    expect(owner.id).not.toBe(ada.id);
  });

  it.each([
    'state:',
    'unknown:value',
    'due:before-2026-02-30',
    'created:after-2026-1-01',
    'has:comment',
    'is:open',
    'project:Roadmap',
    'milestone:V1',
    'no-colon',
    'priority:critical',
    'category:done',
    'state:todo,',
    'state:todo,,done',
    `state:${Array.from({ length: 21 }, (_, index) => `s${index}`).join(',')}`,
    'updated:after-2026-02-30',
    'updated:before-2026-13-01',
    'created:before-not-a-date',
    'due:this-month',
    'has:comment',
    'project:Missing',
    'milestone:Missing',
    'blocks:TAB-99999',
    'parent:TAB-99999',
  ])('returns invalid_filter with the failing token %s', (token) => {
    const { directory, actor } = fixture();
    let error: any;
    try { listTickets({ directory, actor, filters: [token] }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OpsError);
    expect(error.code).toBe('invalid_filter');
    expect(error.path).toBe(token);
  });

  it('supports the expanded filter grammar with negation, lists, none values and UTC dates', () => {
    const { directory, owner, ada, actor } = fixture();
    const ownerActor = actor;
    const adaActor = { id: ada.id, role: ada.role, name: ada.name };
    const red = createProject({ directory, actor, name: 'Red' });
    const blue = createProject({ directory, actor, name: 'Blue' });
    createMilestone({ directory, actor, projectId: red.id, name: 'Launch', due: '2026-10-30' });
    createMilestone({ directory, actor, projectId: blue.id, name: 'Rollout', due: '2026-11-15' });
    createLabel({ directory, actor, name: 'Bug' });
    createLabel({ directory, actor, name: 'UX' });
    directory.db.prepare(
      `INSERT INTO ticket_states (id, workflow_id, state_key, name, category, position, is_default, created_at)
       VALUES ('st_backlog_filter_test', 'wf_default', 'backlog', 'Backlog', 'backlog', 5, 0, ?)`,
    ).run(NOW);
    const alpha = createTicket({
      directory, actor: ownerActor, title: 'Needle alpha', state: 'in_progress', priority: 'high', assignee: 'Ada',
      labels: ['bug'], due: '2026-10-05', project: 'Red', milestone: 'Launch', now: Date.UTC(2026, 9, 5, 12),
    });
    const beta = createTicket({
      directory, actor: adaActor, title: 'Needle beta', priority: 'low', labels: ['UX'], project: 'Blue', milestone: 'Rollout',
      now: Date.UTC(2026, 9, 10, 0),
    });
    const gamma = createTicket({
      directory, actor: ownerActor, title: 'Needle gamma', state: 'done', priority: 'none', assignee: 'me', labels: ['bug'],
      due: '2026-10-12', project: 'Red', now: Date.UTC(2026, 9, 9, 23),
    });
    const delta = createTicket({
      directory, actor: ownerActor, title: 'Needle delta', state: 'cancelled', priority: 'urgent', due: '2026-09-20',
      now: Date.UTC(2026, 9, 10, 0),
    });
    const epsilon = createTicket({
      directory, actor: ownerActor, title: 'Needle epsilon', state: 'backlog', priority: 'medium', assignee: 'Ada',
      due: '2026-10-11', project: 'Blue', milestone: 'Rollout', now: Date.UTC(2026, 9, 8, 12),
    });
    directory.db.prepare('UPDATE tickets SET created_at = CASE key WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? END, updated_at = CASE key WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? WHEN ? THEN ? END')
      .run(
        alpha.key, Date.UTC(2026, 9, 5, 12), beta.key, Date.UTC(2026, 9, 10, 0), gamma.key, Date.UTC(2026, 9, 9, 23),
        delta.key, Date.UTC(2026, 9, 10, 0), epsilon.key, Date.UTC(2026, 9, 8, 12),
        alpha.key, NOW, beta.key, NOW, gamma.key, Date.UTC(2026, 9, 9, 23), delta.key, NOW, epsilon.key, Date.UTC(2026, 9, 8, 12),
      );

    const cases: Array<[string, string[]]> = [
      ['state:todo,in_progress', [alpha.key, beta.key]],
      ['-state:done,cancelled', [alpha.key, beta.key, epsilon.key]],
      ['label:bug,ux', [alpha.key, beta.key, gamma.key]],
      ['-label:bug,ux', [delta.key, epsilon.key]],
      ['assignee:me,Ada', [alpha.key, gamma.key, epsilon.key]],
      ['assignee:none', [beta.key, delta.key]],
      ['-assignee:none', [alpha.key, gamma.key, epsilon.key]],
      ['-assignee:me,Ada', [beta.key, delta.key]],
      ['creator:me', [alpha.key, gamma.key, delta.key, epsilon.key]],
      ['creator:Ada', [beta.key]],
      ['-creator:me,Ada', []],
      ['priority:high,low', [alpha.key, beta.key]],
      ['-priority:low,none', [alpha.key, delta.key, epsilon.key]],
      ['category:started,unstarted', [alpha.key, beta.key]],
      ['-category:completed,canceled', [alpha.key, beta.key, epsilon.key]],
      ['project:RED,blue', [alpha.key, beta.key, gamma.key, epsilon.key]],
      ['project:none', [delta.key]],
      ['-project:Red,Blue', [delta.key]],
      ['milestone:launch,ROLLOUT', [alpha.key, beta.key, epsilon.key]],
      ['milestone:none', [gamma.key, delta.key]],
      ['-milestone:Launch,Rollout', [gamma.key, delta.key]],
      ['due:this-week', [alpha.key, epsilon.key]],
      ['-due:this-week', [beta.key, gamma.key, delta.key]],
      ['due:none', [beta.key]],
      ['-due:none', [alpha.key, gamma.key, delta.key, epsilon.key]],
      ['due:after-2026-10-10', [gamma.key, epsilon.key]],
      ['due:before-2026-10-10', [alpha.key, delta.key]],
      ['due:overdue', [alpha.key]],
      ['has:link', []],
      ['-has:link', [alpha.key, beta.key, gamma.key, delta.key, epsilon.key]],
      ['-is:archived', [alpha.key, beta.key, gamma.key, delta.key, epsilon.key]],
      ['updated:after-2026-10-10', [alpha.key, beta.key, delta.key]],
      ['updated:before-2026-10-10', [gamma.key, epsilon.key]],
      ['created:after-2026-10-10', [beta.key, delta.key]],
      ['created:before-2026-10-10', [alpha.key, gamma.key, epsilon.key]],
    ];
    for (const [filter, expected] of cases) {
      expect(
        listTickets({ directory, actor, filters: [filter], now: NOW }).entries.map((ticket: any) => ticket.key).sort(),
        `filter ${filter}`,
      ).toEqual([...expected].sort());
    }
    const dueToday = createTicket({ directory, actor, title: 'Boundary due date', due: '2026-10-10', now: NOW });
    expect(listTickets({ directory, actor, filters: ['due:after-2026-10-10'], now: NOW }).entries.map((ticket: any) => ticket.key))
      .toContain(dueToday.key);
    expect(listTickets({ directory, actor, filters: ['due:before-2026-10-10'], now: NOW }).entries.map((ticket: any) => ticket.key))
      .not.toContain(dueToday.key);
    expect(searchTickets({ directory, actor, query: 'needle', filters: ['priority:high'] }).entries.map((ticket: any) => ticket.key))
      .toEqual([alpha.key]);
    expect(owner.id).not.toBe(ada.id);
  });

  it('matches creators directly and by agent, integration, import and system type', () => {
    const { directory, owner, ada, actor } = fixture();
    const adaActor = { id: ada.id, role: ada.role, name: ada.name };
    const direct = createTicket({ directory, actor, title: 'Direct owner creator' });
    const adaDirect = createTicket({ directory, actor: adaActor, title: 'Direct Ada creator' });
    const agentActor = { type: 'mcp_token', id: 'agent-token', user: { id: owner.id, role: 'owner', name: owner.name }, tracker: 'write' };
    const agent = createTicket({ directory, actor: agentActor, title: 'Agent creator' });
    const systemActor = { type: 'system', id: 'system-importer', ticketAccess: 'write' };
    const importedBySource = createTicket({ directory, actor: systemActor, title: 'Linear import', source: 'linear-import' });
    const importedByType = createTicket({ directory, actor: systemActor, title: 'Other import' });
    const integration = createTicket({ directory, actor: systemActor, title: 'Integration creator' });
    const system = createTicket({ directory, actor: systemActor, title: 'System creator' });
    directory.db.prepare("UPDATE tickets SET created_by_type = 'import' WHERE id = ?").run(importedByType.id);
    directory.db.prepare("UPDATE tickets SET created_by_type = 'integration' WHERE id = ?").run(integration.id);
    const matches = (filter: string) => listTickets({ directory, actor, filters: [filter] }).entries.map((ticket: any) => ticket.key).sort();

    expect(matches('creator:me')).toEqual([direct.key]);
    expect(matches('creator:Owner')).toEqual([direct.key]);
    expect(matches('creator:ada@example.com')).toEqual([adaDirect.key]);
    expect(matches('creator:agent')).toEqual([agent.key]);
    expect(matches('creator:integration')).toEqual([integration.key]);
    expect(matches('creator:import')).toEqual([importedBySource.key, importedByType.key].sort());
    expect(matches('creator:system')).toEqual([importedBySource.key, system.key].sort());
    expect(matches('-creator:me')).toContain(agent.key);
    expect(matches('-creator:me')).not.toContain(direct.key);
  });

  it('filters direct parents and real relation directions with open-state blocking semantics', () => {
    const { directory, actor } = fixture();
    const parent = createTicket({ directory, actor, title: 'Parent' });
    const child = createTicket({ directory, actor, title: 'Child', parent: parent.key });
    const openBlocker = createTicket({ directory, actor, title: 'Open blocker', state: 'in_progress' });
    const doneBlocker = createTicket({ directory, actor, title: 'Done blocker', state: 'done' });
    const canceledBlocker = createTicket({ directory, actor, title: 'Canceled blocker', state: 'cancelled' });
    const openTarget = createTicket({ directory, actor, title: 'Open target' });
    const doneOnlyTarget = createTicket({ directory, actor, title: 'Done only target' });
    const canceledOnlyTarget = createTicket({ directory, actor, title: 'Canceled only target' });
    const closedTarget = createTicket({ directory, actor, title: 'Closed target', state: 'done' });
    const relatePeer = createTicket({ directory, actor, title: 'Relate peer' });
    const duplicate = createTicket({ directory, actor, title: 'Duplicate' });
    const original = createTicket({ directory, actor, title: 'Original' });
    relateTickets({ directory, actor, key: openBlocker.key, relation: 'blocks', otherKey: openTarget.key });
    relateTickets({ directory, actor, key: doneBlocker.key, relation: 'blocks', otherKey: doneOnlyTarget.key });
    relateTickets({ directory, actor, key: canceledBlocker.key, relation: 'blocks', otherKey: canceledOnlyTarget.key });
    relateTickets({ directory, actor, key: openBlocker.key, relation: 'blocks', otherKey: closedTarget.key });
    relateTickets({ directory, actor, key: openBlocker.key, relation: 'relates_to', otherKey: relatePeer.key });
    relateTickets({ directory, actor, key: duplicate.key, relation: 'duplicates', otherKey: original.key });
    const matches = (filter: string) => listTickets({ directory, actor, filters: [filter] }).entries.map((ticket: any) => ticket.key).sort();

    expect(matches(`has:parent`)).toEqual([child.key]);
    expect(matches('has:sub')).toEqual([parent.key]);
    expect(matches(`parent:${parent.key.toLowerCase()}`)).toEqual([child.key]);
    expect(matches('has:relation')).toEqual([
      openBlocker.key, doneBlocker.key, canceledBlocker.key, openTarget.key, doneOnlyTarget.key,
      canceledOnlyTarget.key, closedTarget.key, relatePeer.key, duplicate.key, original.key,
    ].sort());
    expect(matches('is:blocked')).toEqual([openTarget.key, closedTarget.key].sort());
    expect(matches('is:blocking')).toEqual([openBlocker.key, doneBlocker.key, canceledBlocker.key].sort());
    expect(matches(`blocks:${openTarget.key}`)).toEqual([openBlocker.key]);
    expect(matches(`blocked-by:${openBlocker.key}`)).toEqual([openTarget.key, closedTarget.key].sort());
    expect(matches(`relates:${relatePeer.key}`)).toEqual([openBlocker.key]);
    expect(matches(`duplicates:${original.key}`)).toEqual([duplicate.key]);
    expect(matches(`duplicated-by:${duplicate.key}`)).toEqual([original.key]);
    expect(matches(`-blocks:${openTarget.key}`)).not.toContain(openBlocker.key);
    expect(matches('-has:relation')).not.toContain(openBlocker.key);

    let invisibleError: any;
    try { listTickets({ directory, actor: {}, filters: [`blocks:${openTarget.key}`] }); } catch (error) { invisibleError = error; }
    expect(invisibleError).toMatchObject({ code: 'invalid_filter', path: `blocks:${openTarget.key}` });
  });

  it('keeps filter values parameterized and walks equal-updated_at pages with a new filter', () => {
    const { directory, actor } = fixture();
    const unsafeLabel = "widget'%; DROP TABLE tickets;--";
    createLabel({ directory, actor, name: unsafeLabel });
    const unsafeTicket = createTicket({ directory, actor, title: 'Bound value result', labels: [unsafeLabel] });
    expect(listTickets({ directory, actor, filters: [`label:${unsafeLabel}`] }).entries.map((ticket: any) => ticket.key))
      .toEqual([unsafeTicket.key]);
    expect(directory.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n).toBe(1);
    updateTicket({ directory, actor, key: unsafeTicket.key, patch: { archived: true } });

    const tickets = Array.from({ length: 5 }, (_, index) => createTicket({
      directory, actor, title: `Tie page ${index}`, state: index % 2 ? 'in_progress' : 'todo', now: NOW,
    }));
    directory.db.prepare('UPDATE tickets SET updated_at = ?').run(NOW);
    const walk: any[] = [];
    let cursor: string | null = null;
    do {
      const page = listTickets({ directory, actor, filters: ['-state:done,cancelled'], limit: 2, cursor, now: NOW });
      walk.push(...page.entries);
      cursor = page.next;
    } while (cursor);
    const expected = [...tickets].sort((a: any, b: any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((ticket: any) => ticket.key);
    expect(walk.map((ticket: any) => ticket.key)).toEqual(expected);
  });

  it('quotes FTS terms so operators and column syntax stay ordinary search text', () => {
    const { directory, actor } = fixture();
    const query = 'OR NEAR * title:secret';
    const fts = buildFtsQuery(query);
    expect(fts).toBe('"OR" AND "NEAR" AND "title" AND "secret"*');
    expect(fts).not.toContain(':');
    const ticket = createTicket({ directory, actor, title: 'OR NEAR title secret' });
    expect(searchTickets({ directory, actor, query }).entries.map((item: any) => item.key)).toEqual([ticket.key]);
  });

  it('uses keyset pagination to keep tied search rows stable across pages', () => {
    const { directory, actor } = fixture();
    const tickets = [1, 2, 3, 4, 5].map((n) => createTicket({ directory, actor, title: `Stable ticket ${n}`, now: NOW }));
    directory.db.prepare('UPDATE tickets SET updated_at = ?').run(NOW);
    const first = searchTickets({ directory, actor, query: 'stable', limit: 2, now: NOW });
    expect(first.entries).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.next).toBeTruthy();
    const second = searchTickets({ directory, actor, query: 'stable', limit: 2, cursor: first.next, now: NOW });
    expect(second.entries).toHaveLength(2);
    expect(second.next).toBeTruthy();
    const third = searchTickets({ directory, actor, query: 'stable', limit: 2, cursor: second.next, now: NOW });
    expect(third.entries).toHaveLength(1);
    expect(third.next).toBeNull();
    const expected = [...tickets].sort((a: any, b: any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((ticket: any) => ticket.key);
    expect([...first.entries, ...second.entries, ...third.entries].map((item: any) => item.key)).toEqual(expected);
  });

  it('walks every list page once with no terms, a state filter and an archived filter', () => {
    const { directory, actor } = fixture();
    const active = Array.from({ length: 6 }, (_, index) => createTicket({ directory, actor, title: `Active ${index}`, now: NOW }));
    const archived = Array.from({ length: 6 }, (_, index) => createTicket({ directory, actor, title: `Archived ${index}`, now: NOW }));
    for (const ticket of archived) updateTicket({ directory, actor, key: ticket.key, patch: { archived: true }, now: NOW });
    directory.db.prepare('UPDATE tickets SET updated_at = ?').run(NOW);

    const walk = (filters: string[] = []) => {
      const pages: any[] = [];
      let cursor: string | null = null;
      do {
        const page = listTickets({ directory, actor, filters, limit: 2, cursor, now: NOW });
        pages.push(...page.entries);
        cursor = page.next;
      } while (cursor);
      return pages;
    };
    const expected = (tickets: any[]) => [...tickets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((ticket) => ticket.key);

    const unfiltered = walk();
    expect(unfiltered.map((ticket) => ticket.key)).toEqual(expected(active));
    expect(walk().map((ticket) => ticket.key)).toEqual(expected(active));
    expect(walk(['state:todo']).map((ticket) => ticket.key)).toEqual(expected(active));
    expect(walk(['is:archived']).map((ticket) => ticket.key)).toEqual(expected(archived));
  });

  it('matches a two-character final word as a prefix while keeping earlier words whole and operators literal', () => {
    const { directory, actor } = fixture();
    const overdue = createTicket({ directory, actor, title: 'Overdue task' });
    createTicket({ directory, actor, title: 'Catfish Overdue' });
    const operatorOnly = createTicket({ directory, actor, title: 'Cats Zzzzone' });
    const operatorText = createTicket({ directory, actor, title: 'Cats AND Zzzzone' });
    const oneLetter = createTicket({ directory, actor, title: 'Orange task' });

    expect(searchTickets({ directory, actor, query: 'Overd' }).entries.map((item: any) => item.key)).toContain(overdue.key);
    expect(searchTickets({ directory, actor, query: 'O' }).entries).toEqual([]);
    expect(searchTickets({ directory, actor, query: 'Cat Overd' }).entries).toEqual([]);
    expect(searchTickets({ directory, actor, query: 'Cats AND zzzz' }).entries.map((item: any) => item.key)).toContain(operatorText.key);
    expect(searchTickets({ directory, actor, query: 'Cats AND zzzz' }).entries.map((item: any) => item.key)).not.toContain(operatorOnly.key);
    expect(searchTickets({ directory, actor, query: 'Orange task' }).entries.map((item: any) => item.key)).toContain(oneLetter.key);
  });

  it.each(['', '... ---'])('refuses a search without searchable terms, including when a cursor is supplied (%s)', (query) => {
    const { directory, actor } = fixture();
    createTicket({ directory, actor, title: 'A ticket to list' });
    createTicket({ directory, actor, title: 'Another ticket to list' });
    const first = listTickets({ directory, actor, limit: 1 });
    expect(first.next).toBeTruthy();
    let error: any;
    try { searchTickets({ directory, actor, query, limit: 1, cursor: first.next }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OpsError);
    expect(error).toMatchObject({ code: 'invalid_input', path: 'query', message: 'Enter something to search for' });
  });

  it('ranks exact keys and aliases, title prefixes, title tokens, then body and comment matches', () => {
    const { directory, actor } = fixture();
    const exact = createTicket({ directory, actor, title: 'Exact key target', description: 'legacy-22 body match', now: NOW });
    const alias = createTicket({ directory, actor, title: 'Alias target', description: 'needle body match', now: NOW });
    directory.db.prepare(
      `INSERT INTO ticket_aliases (id, ticket_id, provider, external_id, display_key, created_at)
       VALUES ('alias-row', ?, 'legacy', 'legacy-22', 'LEGACY-22', ?)`,
    ).run(alias.id, NOW);
    refreshTicketSearch(directory.db, alias.id);
    const prefix = createTicket({ directory, actor, title: 'Needle begins here', now: NOW });
    const titleToken = createTicket({ directory, actor, title: 'Place needle inside', now: NOW });
    const description = createTicket({ directory, actor, title: 'Description result', description: 'needle in description', now: NOW });
    const comment = createTicket({ directory, actor, title: 'Comment result', now: NOW });
    commentTicket({ directory, actor, key: comment.key, body: 'needle in a comment', now: NOW });

    expect(searchTickets({ directory, actor, query: exact.key, now: NOW }).entries[0].key).toBe(exact.key);
    expect(searchTickets({ directory, actor, query: 'legacy-22', now: NOW }).entries[0].key).toBe(alias.key);
    const ranked = searchTickets({ directory, actor, query: 'needle', now: NOW }).entries.map((item: any) => item.key);
    expect(ranked.slice(0, 2)).toEqual([prefix.key, titleToken.key]);
    expect(ranked.slice(2).sort()).toEqual([alias.key, description.key, comment.key].sort());
  });

  it('enforces the 512-code-point query, 20-filter and 50-row page limits', () => {
    const { directory, actor } = fixture();
    let queryError: any;
    try { searchTickets({ directory, actor, query: 'x'.repeat(513) }); } catch (error) { queryError = error; }
    expect(queryError).toBeInstanceOf(OpsError);
    expect(queryError.code).toBe('limit_exceeded');
    let filterError: any;
    try { listTickets({ directory, actor, filters: Array.from({ length: 21 }, () => 'is:archived') }); } catch (error) { filterError = error; }
    expect(filterError).toBeInstanceOf(OpsError);
    expect(filterError.code).toBe('limit_exceeded');
    let pageError: any;
    try { listTickets({ directory, actor, limit: 51 }); } catch (error) { pageError = error; }
    expect(pageError).toBeInstanceOf(OpsError);
    expect(pageError.code).toBe('invalid_input');
  });

  it('applies visibility before totals, snippets and page cursors', () => {
    const { directory, actor } = fixture();
    createTicket({ directory, actor, title: 'Hidden workspace needle' });
    directory.createUser({ email: 'alex-one@example.com', name: 'Alex', role: 'member' });
    directory.createUser({ email: 'alex-two@example.com', name: 'Alex', role: 'member' });
    const guest = directory.createUser({ email: 'guest@example.com', name: 'Guest', role: 'guest' });
    const result = searchTickets({ directory, actor: { id: guest.id, role: guest.role }, query: 'needle', filters: ['assignee:Alex'] });
    expect(result).toEqual({ entries: [], total: 0, next: null });
  });

  it('keeps FTS rows current through create, update, comment, archive and restore', () => {
    const { directory, actor } = fixture();
    const ticket = createTicket({ directory, actor, title: 'Beforeterm title' });
    expect(searchTickets({ directory, actor, query: 'beforeterm' }).total).toBe(1);
    updateTicket({ directory, actor, key: ticket.key, patch: { title: 'Afterterm title', description: 'descriptionneedle' } });
    expect(searchTickets({ directory, actor, query: 'beforeterm' }).total).toBe(0);
    const descriptionHit = searchTickets({ directory, actor, query: 'descriptionneedle' });
    expect(descriptionHit.total).toBe(1);
    expect(descriptionHit.entries[0].snippet).toContain('<mark>descriptionneedle</mark>');
    commentTicket({ directory, actor, key: ticket.key, body: 'commentneedle only in a comment' });
    const commentHit = searchTickets({ directory, actor, query: 'commentneedle' });
    expect(commentHit.total).toBe(1);
    expect(commentHit.entries[0].snippet).toContain('<mark>commentneedle</mark>');
    updateTicket({ directory, actor, key: ticket.key, patch: { archived: true } });
    expect(searchTickets({ directory, actor, query: 'commentneedle' }).total).toBe(0);
    expect(searchTickets({ directory, actor, query: 'commentneedle', filters: ['is:archived'] }).total).toBe(1);
    updateTicket({ directory, actor, key: ticket.key, patch: { archived: false } });
    expect(searchTickets({ directory, actor, query: 'commentneedle' }).total).toBe(1);
  });

  it('limits indexed comments by count and by 64 KiB while retaining recent text', () => {
    const { directory, actor } = fixture();
    const ticket = createTicket({ directory, actor, title: 'Index limits' });
    const add = directory.db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, actor_type, actor_id, author_snapshot, body, created_at)
       VALUES (?, ?, 'user', ?, 'Owner', ?, ?)`,
    );
    for (let i = 0; i <= SEARCH_LIMITS.comments; i++) {
      add.run(`count-${i}`, ticket.id, actor.id, i === 0 ? 'oldesttoken' : i === SEARCH_LIMITS.comments ? 'newesttoken' : 'x', i);
    }
    refreshTicketSearch(directory.db, ticket.id);
    let comments = directory.db.prepare('SELECT comments FROM ticket_search WHERE ticket_id = ?').get(ticket.id).comments;
    expect(comments).not.toContain('oldesttoken');
    expect(comments).toContain('newesttoken');

    directory.db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(ticket.id);
    for (let i = 0; i < 34; i++) {
      const body = `${i === 0 ? 'oldmarker ' : ''}${i === 33 ? 'newmarker ' : ''}${'a'.repeat(2000)}`;
      add.run(`bytes-${i}`, ticket.id, actor.id, body, 20_000 + i);
    }
    refreshTicketSearch(directory.db, ticket.id);
    const indexed = directory.db.prepare('SELECT title, description, comments, identifiers, aliases FROM ticket_search WHERE ticket_id = ?').get(ticket.id);
    comments = indexed.comments;
    const totalBytes = [indexed.title, indexed.description, indexed.comments, indexed.identifiers, indexed.aliases]
      .reduce((sum: number, value: string) => sum + Buffer.byteLength(value, 'utf8'), 0);
    expect(totalBytes).toBeLessThanOrEqual(SEARCH_LIMITS.textBytes);
    expect(comments).toContain('newmarker');
    expect(comments).not.toContain('oldmarker');

    const unicode = createTicket({ directory, actor, title: 'Unicode body', description: '😀'.repeat(20_000) });
    const unicodeIndex = directory.db.prepare('SELECT title, description, comments, identifiers, aliases FROM ticket_search WHERE ticket_id = ?').get(unicode.id);
    expect([unicodeIndex.title, unicodeIndex.description, unicodeIndex.comments, unicodeIndex.identifiers, unicodeIndex.aliases]
      .reduce((sum: number, value: string) => sum + Buffer.byteLength(value, 'utf8'), 0)).toBeLessThanOrEqual(SEARCH_LIMITS.textBytes);
    expect(unicode.description).toBe('😀'.repeat(20_000));
  });
});
