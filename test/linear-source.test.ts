import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDirectory } from '../server/directory.mjs';
import { planImport } from '../server/tracker/linear-import.mjs';
import fixture from './fixtures/linear/graphql.json';
import { createReplayTransport, fetchSnapshot } from '../scripts/lib/linear-source.mjs';


/** Owner-only file modes exist on POSIX; Windows reports 0666 for every file, so the mode is only asserted elsewhere. */
function expectPrivateFile(file: string) {
  if (process.platform === 'win32') return;
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixtureTransport(request: any) {
  const value = (fixture as any)[request.operationName];
  if (!value) throw new Error(`No recorded response for ${request.operationName}`);
  return value;
}

describe('Linear GraphQL source', () => {
  it('paginates with a stable cursor, normalizes the fixture, and requests archived rows on every list', async () => {
    const requests: any[] = [];
    let issueAfterCursor: string | null = null;
    const transport = async (request: any) => {
      requests.push(request);
      const result = fixtureTransport(request);
      if (request.operationName === 'LinearIssues' && request.variables.after == null) {
        const copy = structuredClone(result);
        copy.body.data.issues.pageInfo = { endCursor: 'issue-cursor-1', hasNextPage: true };
        return copy;
      }
      if (request.operationName === 'LinearComments') {
        const copy = structuredClone(result);
        copy.body.data.comments.nodes[0].updatedAt = copy.body.data.comments.nodes[0].createdAt;
        return copy;
      }
      if (request.operationName === 'LinearIssues') {
        issueAfterCursor = request.variables.after;
        return { status: 200, body: { data: { issues: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } } } };
      }
      return result;
    };
    const checkpoints: any[] = [];
    const snapshot = await fetchSnapshot({ transport, since: '2025-01-01T00:00:00.000Z', onCheckpoint: (row: any) => checkpoints.push(row) });
    expect(snapshot.version).toBe(1);
    expect(snapshot.issues[0]).toMatchObject({ identifier: 'TAB-211', state: { type: 'started' }, assigneeEmail: 'ARI@example.com ' });
    expect(snapshot.issues[0].comments[0].editedAt).toBeNull();
    expect(snapshot.issues[0].comments[1].parentId).toBe('00000000-0000-4000-8000-000000000060');
    expect(requests.length).toBe(12);
    expect(issueAfterCursor).toBe('issue-cursor-1');
    expect(requests.every((request) => request.variables.includeArchived === true && request.query.includes('includeArchived: $includeArchived'))).toBe(true);
    expect(requests.find((request) => request.operationName === 'LinearIssues').variables.since).toBe('2025-01-01T00:00:00.000Z');
    expect(requests.find((request) => request.operationName === 'LinearComments').query).toContain('updatedAt: { gt: $since }');
    expect(checkpoints.at(-1).completed.attachments).toBe(true);
  });

  it('retries 429 and 5xx responses using response rate limits and injected sleep', async () => {
    const sleeps: number[] = [];
    let issueAttempts = 0;
    const transport = async (request: any) => {
      if (request.operationName === 'LinearIssues') {
        issueAttempts++;
        if (issueAttempts === 1) return { status: 429, headers: { 'retry-after': '0.01' }, body: {} };
        if (issueAttempts === 2) return { status: 503, headers: { 'x-ratelimit-requests-reset': String((Date.now() + 1000) / 1000) }, body: {} };
      }
      return fixtureTransport(request);
    };
    await fetchSnapshot({ transport, sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0 });
    expect(issueAttempts).toBe(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
  });

  it('resolves the issue for a changed comment when that issue is outside the since-filtered issue page', async () => {
    const requests: any[] = [];
    const transport = async (request: any) => {
      requests.push(request);
      if (request.operationName === 'LinearIssues') return { status: 200, body: { data: { issues: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } } } };
      if (request.operationName === 'LinearCommentIssueDetails') {
        const issue = (fixture as any).LinearIssues.body.data.issues.nodes[0];
        return { status: 200, body: { data: { issues: { nodes: [issue], pageInfo: { endCursor: null, hasNextPage: false } } } } };
      }
      return fixtureTransport(request);
    };
    const snapshot = await fetchSnapshot({ transport, since: '2025-01-01T00:00:00.000Z' });
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ identifier: 'TAB-211', comments: [{ id: '00000000-0000-4000-8000-000000000060' }, { id: '00000000-0000-4000-8000-000000000061' }] });
    expect(requests.some((request) => request.operationName === 'LinearCommentIssueDetails' && request.variables.includeArchived === true)).toBe(true);
  });

  it('scrubs the environment key from thrown messages, recorded responses, checkpoints, and recorder files', async () => {
    const canary = 'lin_api_canary_secret_do_not_print';
    vi.stubEnv('LINEAR_API_KEY', canary);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-source-'));
    const recordDir = path.join(root, 'recorded');
    let authorization = '';
    globalThis.fetch = (async (_url: any, init: any) => {
      authorization = init.headers.Authorization;
      return new Response(JSON.stringify({ errors: [{ message: `server echoed ${canary}` }] }), { status: 200 });
    }) as typeof fetch;
    const checkpoint: any[] = [];
    let error: Error | null = null;
    try { await fetchSnapshot({ record: recordDir, onCheckpoint: (value: any) => checkpoint.push(value) }); } catch (caught) { error = caught as Error; }
    expect(authorization).toBe(canary);
    expect(error?.message).not.toContain(canary);
    const output = `${error?.message ?? ''}${JSON.stringify(checkpoint)}${fs.readFileSync(path.join(recordDir, '000001.json'), 'utf8')}`;
    expect(output).not.toContain(canary);
    expectPrivateFile(path.join(recordDir, '000001.json'));
    expect(() => JSON.parse(fs.readFileSync(path.join(recordDir, '000001.json'), 'utf8'))).not.toThrow();
  });

  it('scrubs a canary key echoed in successful source data before snapshots and reports are produced', async () => {
    const canary = 'lin_api_canary_successful_data_do_not_print';
    vi.stubEnv('LINEAR_API_KEY', canary);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-source-success-'));
    const recordDir = path.join(root, 'recorded');
    let authorization = '';
    globalThis.fetch = (async (_url: any, init: any) => {
      authorization = init.headers.Authorization;
      const request = JSON.parse(init.body);
      const body = structuredClone((fixture as any)[request.operationName].body);
      if (request.operationName === 'LinearTeams') body.data.teams.nodes[0].name = canary;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const checkpoint: any[] = [];
    const snapshot = await fetchSnapshot({ record: recordDir, onCheckpoint: (value: any) => checkpoint.push(value) });
    const directory = openDirectory(':memory:');
    try {
      const { report } = planImport({ db: directory.db, snapshot });
      const output = JSON.stringify({ snapshot, report, checkpoint, recorded: fs.readdirSync(recordDir).map((name) => fs.readFileSync(path.join(recordDir, name), 'utf8')) });
      expect(authorization).toBe(canary);
      expect(snapshot.teams[0].name).toBe('[REDACTED]');
      expect(output).not.toContain(canary);
    } finally { directory.close(); }
  });

  it('replays recorded GraphQL responses without network access', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-replay-'));
    for (const [index, operationName] of ['LinearTeams', 'LinearUsers'].entries()) {
      fs.writeFileSync(path.join(directory, `${String(index + 1).padStart(6, '0')}.json`), JSON.stringify({
        request: { operationName }, response: (fixture as any)[operationName],
      }));
    }
    const replay = createReplayTransport(directory);
    expect(await replay({ operationName: 'LinearTeams' })).toEqual((fixture as any).LinearTeams);
    expect(await replay({ operationName: 'LinearUsers' })).toEqual((fixture as any).LinearUsers);
  });
});
