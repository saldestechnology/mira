import type { TemplateContent, TemplateScope } from './custom-templates';
import { isRestoringAnswer } from './restoring-answer';

export type UserRole = 'owner' | 'admin' | 'member' | 'guest';
export type TeamRole = 'admin' | 'member';
export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer';
export type ShareRole = 'editor' | 'commenter' | 'viewer';
export type PrincipalType = 'user' | 'team';

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Present in /api/me only when a control plane runs this instance (docs/cloud.md). */
export interface Workspace {
  readOnly: boolean;
  banner: string | null;
  seatLimit: number | null;
  seatsUsed: number;
  /** False for a workspace that is provided free (education, internal): no subscription, no billing portal. Absent on older servers. */
  billing?: boolean;
  /** Whether the control plane enabled the AI credits capability; absent on older servers. */
  aiCredits?: boolean;
  /** Present only for owners and admins on cloud instances. */
  trialEndsAt?: string | null;
  /** Present only for owners and admins on cloud instances. Unknown lifecycle values are allowed. */
  state?: string | null;
}

export interface Me {
  user: ApiUser;
  teams: { id: string; name: string; role: TeamRole }[];
  workspace?: Workspace;
  /** Present (true) only when AI tool access is turned on for this server (docs/mcp.md). */
  mcp?: boolean;
  /** Present (true) when this server stores images on boards (docs/images.md). */
  images?: boolean;
  /** Present only when this person may bring their own AI key (docs/ai.md). */
  ai?: { personalKeys: true };
  /** Present (true) when team chat is on for this server (docs/chat.md). */
  chat?: boolean;
  /** Present (true) when this server enables tracker frame creation. */
  tracker?: boolean;
  /** Present only when the relay has one-board guest join codes enabled. */
  joinCodes?: true;
}

export interface JoinCodeInfo {
  id: string;
  role: 'commenter' | 'editor';
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
  revokedAt: number | null;
}

export interface CreatedJoinCode extends Omit<JoinCodeInfo, 'revokedAt'> {
  code: string;
}

export interface GuestJoin {
  boardId: string;
  role: 'commenter' | 'editor';
  name: string;
  guestId: string;
  expiresAt: number;
}

/** A chat message as the API and the /chat socket show it (docs/chat.md, API). Text is plain; never HTML. */
export interface ChatMessage {
  id: number;
  kind: string;
  ref: string;
  authorId: string | null;
  authorName: string;
  clientId: string;
  text: string;
  replyTo: number | null;
  objectId: string | null;
  mentions: { id: string; name: string | null }[];
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  deletedBy: 'author' | 'moderator' | null;
  /** Who reacted with what, in the fixed order of the set. Absent in messages saved before reactions existed. */
  reactions?: { emoji: string; userIds: string[] }[];
}

/** GET /api/chat/:kind/:ref: what the caller may do in a channel and who can read it. */
export interface ChatChannelInfo {
  kind: string;
  ref: string;
  access: { write: boolean; moderate: boolean; role: BoardRole | string | null; readOnly: boolean };
  people: { id: string; name: string }[];
}

/** One row of GET /api/chat/channels: a place to talk, for the Chat page. `member` is false for a team an admin may read. */
export interface ChatChannelEntry {
  kind: 'board' | 'team' | 'workspace';
  ref: string;
  name: string;
  write: boolean;
  unread: number;
  mentions: number;
  lastId: number;
  lastAt: number | null;
  archived?: boolean;
  member?: boolean;
}

/** GET and PUT /api/admin/chat. `retentionDays` is null for "forever". */
export interface ChatSettings {
  viewersMayPost: boolean;
  retentionDays: number | null;
  workspaceChannel: boolean;
}

/** GET and PUT /api/admin/updates (hosted workspaces only). */
export interface AdminUpdates {
  auto: boolean;
  synced: boolean;
  securityAlwaysApplied: true;
}

export interface ChatUnread { kind: string; ref: string; lastId: number; unread: number; mentions: number }

/** What the server stored for an upload. */
export interface AssetInfo { hash: string; mime: string; bytes: number; width: number; height: number }

export type AccessScope = 'read' | 'comment' | 'write';

/** A personal access token for the MCP endpoint, without the secret. */
export interface AccessToken {
  id: string;
  name: string;
  scope: AccessScope;
  /** null = every board the person can access. */
  boardIds: string[] | null;
  /** The last four characters of the token, to tell tokens apart. */
  hint: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

/** The answer to creating a token: the only time the secret and the endpoint address are sent. */
export interface CreatedAccessToken extends AccessToken {
  token: string;
  url: string;
}

export interface AdminAccessToken extends AccessToken {
  userId: string;
  userName: string;
  email: string;
  userRole: UserRole;
}

export type AiFeature = 'generate' | 'summarise' | 'cluster';

/** A stored AI key as the server shows it: never the key, only its last four characters. */
export interface AiKeyInfo {
  provider: string;
  hint: string;
  baseUrl: string | null;
  model: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** The result of checking a stored AI key with its provider. */
export interface AiKeyTest {
  ok: true;
  provider: string;
  checkedAt: number;
}

/** GET /api/ai/config (docs/ai.md): what AI is available to the person who asks. */
export interface AiConfig {
  enabled: boolean;
  features: AiFeature[];
  keySource: 'user' | 'workspace' | null;
  provider: string | null;
  model: string;
  /** Whether this person may add a key of their own. */
  personalKeys: boolean;
  /** Whether this hosted workspace advertises the AI credits capability for keyless availability. */
  credits: boolean;
  /** Whether the server can store keys (TABULA_AI_SECRET is set). */
  hasSecret: boolean;
  myKey: AiKeyInfo | null;
}

/** GET and PUT /api/admin/ai: the workspace's AI settings and its key. */
export interface AdminAi {
  enabled: boolean;
  features: AiFeature[];
  model: string;
  personalKeys: boolean;
  membersOnly: boolean;
  limits: { perPersonHour: number; perWorkspaceHour: number };
  hasSecret: boolean;
  /** Whether runs without a saved workspace key will use hosted AI credits. */
  creditsActive: boolean;
  /** `readable` is false when the key was written under a secret this server no longer has. */
  key: (AiKeyInfo & { readable: boolean }) | null;
}

export interface AdminAiPatch {
  enabled?: boolean;
  features?: AiFeature[];
  model?: string;
  personalKeys?: boolean;
  membersOnly?: boolean;
  limits?: { perPersonHour?: number; perWorkspaceHour?: number };
  apiKey?: string;
  provider?: string;
  baseUrl?: string;
  /** The model of the key being saved (an OpenAI-compatible provider); `model` above is the workspace's Anthropic model. */
  keyModel?: string;
}

export interface Team {
  id: string;
  name: string;
  role: TeamRole | null;
  memberCount: number;
  archived: boolean;
}

export interface TeamMember {
  userId: string;
  name: string;
  email: string;
  role: TeamRole;
}

export interface Invite {
  id: string;
  role: TeamRole;
  expiresAt: number;
  uses: number;
  maxUses: number | null;
}

export interface CreatedInvite {
  id: string;
  url: string;
  token: string;
  expiresAt: number;
}

export interface InvitePreview {
  team: { id: string; name: string };
  role: TeamRole;
}

export interface ServerBoard {
  id: string;
  title: string;
  teamId: string | null;
  ownerId: string | null;
  role: BoardRole;
  createdAt: number;
  updatedAt: number;
}

export interface Share {
  principalType: PrincipalType;
  principalId: string;
  name: string;
  role: ShareRole;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  teams: { id: string; name: string; role: TeamRole }[];
}

export interface AdminOverview {
  members: { total: number; active: number; disabled: number; byRole: Record<UserRole, number> };
  teams: { total: number; archived: number };
  boards: { total: number; deleted: number };
  sessions: { active: number };
  signIns7d: number;
  live: { rooms: number; connections: number };
  instance: { authEnabled: true; baseUrl: string; mail: 'log' | 'file' | 'webhook' | 'smtp'; version: string };
  /** Present only when a control plane runs this instance. */
  trialEndsAt?: string | null;
  /** Present only when a control plane runs this instance. */
  state?: string | null;
}

export interface AdminMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  activeSessions: number;
  boardCount: number;
  teams: { id: string; name: string; role: TeamRole }[];
}

export interface AdminSession {
  id: string;
  userId: string;
  userName: string;
  email: string;
  createdAt: number;
  lastSeen: number;
  /** The browser the session signed in from; null for sessions older than this field. */
  userAgent: string | null;
  expiresAt: number;
  current: boolean;
}

export interface AdminBoard {
  id: string;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  teamId: string | null;
  teamName: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  shareCount: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  entries: AuditEntry[];
  next: number | null;
}

// Backups and restore (docs/backups.md, "Routes" and "In the app"). Owner only.

/** One backup in the list. A backup that cannot be read has `readable: false` and `error`, and no counts. */
export interface BackupSummary {
  name: string;
  createdAt: number | null;
  protected: boolean;
  protectedUntil: number | null;
  readable: boolean;
  files?: number;
  bytes?: number;
  keyId?: string;
  error?: string;
}

/** The backup engine's own status, as the owner sees it: times in ms since the epoch, null when not known yet. */
export interface BackupEngineStatus {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureError: string | null;
  consecutiveFailures: number | null;
  nextRunAt: number | null;
  running: boolean | null;
  intervalMinutes: number | null;
  keyId: string | null;
  bytesStored: number | null;
  objects: number | null;
  manifests: number | null;
}

export interface RestoreRecord {
  kind: 'workspace' | 'board';
  result: 'done' | 'failed';
  at: number | null;
  manifest: string | null;
  error?: string;
  files?: number;
  bytes?: number;
  boards?: number;
  keepOldFor?: string;
}

export interface RestoreStatus {
  inProgress: null | 'workspace' | 'board';
  maintenance: boolean;
  last: RestoreRecord | null;
  protectedBackups: { manifest: string; until: number }[];
  oldData: { name: string; restoredAt: number; keepOldFor: string }[];
}

export interface BackupList {
  backups: BackupSummary[];
  truncated: boolean;
  status: BackupEngineStatus;
  restore: RestoreStatus;
}

/** What restoring one backup would do, before anything is downloaded. */
export interface BackupPreview {
  name: string;
  createdAt: number | null;
  appVersion: string | null;
  keyId: string;
  files: number;
  bytes: number;
  boards: number;
  protected: boolean;
  confirmWord: string;
  keepOldFor: string;
  reason: string;
  space: { needed: number; free: number; enough: boolean };
}

export interface BackupBoard {
  id: string;
  title: string;
  teamId: string | null;
  teamName: string | null;
  deleted: boolean;
}

export interface BackupBoards {
  boards: BackupBoard[];
  truncated: boolean;
}

export interface BoardCopy {
  ok: true;
  boardId: string;
  title: string;
  teamId: string | null;
  fallback?: 'personal';
  message?: string;
}

export type VersionKind = 'auto' | 'named' | 'pre-restore' | 'restore';

/** One saved version of a board (docs/history.md). */
export interface Version {
  id: string;
  createdAt: number;
  kind: VersionKind;
  label: string | null;
  by: string | null;
  byName: string | null;
  objects: number;
  bytes: number;
  from: string | null;
}

/** A saved template as the server lists it: everything but the content (docs/custom-templates.md, "Accounts mode"). */
export interface ServerTemplateInfo {
  id: string;
  version: 1;
  name: string;
  category: string;
  description: string;
  scope: TemplateScope;
  teamId: string | null;
  teamName: string | null;
  /** The owner's account id; empty when the owner has been removed. */
  createdBy: string;
  ownerName: string | null;
  createdAt: number;
  updatedAt: number;
  objectCount: number;
  stepCount: number;
  /** Whether this person may rename, edit and delete it. Everybody who can see a template may duplicate it. */
  canChange: boolean;
}

/** A template with its content, as one template is fetched, created, changed or duplicated. */
export interface ServerTemplate extends ServerTemplateInfo {
  content: TemplateContent;
}

export interface TemplateInput {
  name: string;
  category: string;
  description?: string;
  scope?: TemplateScope;
  teamId?: string;
  content: TemplateContent;
}

export class ApiError extends Error {
  status: number;
  code: string;
  /** The plain facts an error answer carries besides its code and message (`needed` and `free` bytes, `retryAfter` seconds). */
  facts: Record<string, unknown>;

  constructor(status: number, code: string, message: string, facts: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.facts = facts;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A hung server must not freeze the app: a timeout rejects like any other network failure. */
const REQUEST_TIMEOUT_MS = 8000;
/** A version's state can be a few hundred kilobytes on a slow link. */
const BYTES_TIMEOUT_MS = 30000;
/** A template can be a megabyte, and it travels in both directions. */
const TEMPLATE_TIMEOUT_MS = 30000;
/** Reading a bucket (a listing, a preview, the boards of a backup, a board copy) is many requests behind one. */
const BACKUP_TIMEOUT_MS = 60000;
/** A whole restore answers only after the safety backup, the download and the checks. */
const RESTORE_TIMEOUT_MS = 10 * 60000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

type Body = { valid: true; data: unknown } | { valid: false };

/** The shared mapping of an error response to an ApiError. */
function failure(res: Response, body: Body): ApiError {
  const fields: Record<string, unknown> = body.valid && isRecord(body.data) ? body.data : {};
  const code = typeof fields.error === 'string' ? fields.error : 'unknown';
  const message = typeof fields.message === 'string' ? fields.message : code;
  const facts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'error' || key === 'message') continue;
    if (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 200)) facts[key] = value;
  }
  const wait = Number(res.headers?.get('retry-after'));
  if (Number.isFinite(wait) && wait > 0) facts.retryAfter = wait;
  return new ApiError(res.status, code, message, facts);
}

export interface ApiOptions {
  /** Called when the server answers 503 `{error: 'restoring'}`: a restore has taken the workspace over. */
  onRestoring?: () => void;
}

const restoringListeners = new Set<() => void>();

/** Hears of every answer, from the shared client, that says a restore is running (the app shows its restoring screen). */
export function onRestoring(fn: () => void): () => void {
  restoringListeners.add(fn);
  return () => {
    restoringListeners.delete(fn);
  };
}

function announceRestoring(): void {
  for (const fn of restoringListeners) {
    try {
      fn();
    } catch (err) {
      console.error('restoring listener failed:', err);
    }
  }
}

async function readBody(res: Response): Promise<Body> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { valid: false };
  }
  if (!text) return { valid: true, data: undefined };
  try {
    return { valid: true, data: JSON.parse(text) };
  } catch {
    return { valid: false };
  }
}

// A 10 MB image on a slow connection.
const ASSET_TIMEOUT_MS = 120_000;


export function createApi(fetchFn: typeof fetch = (...a) => fetch(...a), options: ApiOptions = {}) {
  const restoring = options.onRestoring ?? announceRestoring;

  /** An error answer as an ApiError. Only the code `restoring` on a 503 tells the app a restore is running. */
  function reject(res: Response, body: Body): ApiError {
    if (body.valid && isRestoringAnswer(res.status, body.data)) {
      try {
        restoring();
      } catch {
        /* the listener must not change the error the caller sees */
      }
    }
    return failure(res, body);
  }

  async function call<T>(method: Method, path: string, payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (method !== 'GET') headers['x-tabula'] = '1';
    const init: RequestInit = { method, credentials: 'same-origin', headers };
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(timeoutMs);
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }

    let res: Response;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new ApiError(0, 'network', 'network');
    }
    const body = await readBody(res);
    if (!res.ok) throw reject(res, body);
    if (!body.valid) throw new ApiError(res.status, 'unknown', 'unknown');
    return body.data as T;
  }

  /** Raw bytes in, JSON out (an image upload). The server decides the type from the bytes; `type` is only what we declare. */
  async function sendBytes<T>(path: string, bytes: Blob, type: string, timeoutMs = ASSET_TIMEOUT_MS): Promise<T> {
    const init: RequestInit = { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json', 'x-tabula': '1', 'content-type': type }, body: bytes };
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new ApiError(0, 'network', 'network');
    }
    // A manual cross-origin redirect can be opaque (status 0); keep it in the upload failure path as a redirect.
    if (res.type === 'opaqueredirect') throw new ApiError(307, 'redirect', 'redirect');
    if (res.redirected) throw new ApiError(res.status || 307, 'redirect', 'redirect');
    const body = await readBody(res);
    if (!res.ok) throw failure(res, body);
    if (!body.valid) throw new ApiError(res.status, 'unknown', 'unknown');
    return body.data as T;
  }

  /** A binary GET (a version's state). The shared call() parses every body as JSON. */
  async function callBytes(path: string): Promise<Uint8Array> {
    const init: RequestInit = { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/octet-stream' } };
    if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(BYTES_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(path, init);
    } catch {
      throw new ApiError(0, 'network', 'network');
    }
    if (!res.ok) throw reject(res, await readBody(res));
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new ApiError(0, 'network', 'network');
    }
  }

  const seg = (s: string) => encodeURIComponent(s);
  const qs = (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  return {
    config: () => call<{ authEnabled: boolean; images?: boolean; joinCodes?: boolean }>('GET', '/api/config'),
    me: () => call<Me>('GET', '/api/me'),
    updateMe: (name: string) => call<ApiUser>('PATCH', '/api/me', { name }),
    requestLogin: (email: string, invite?: string) =>
      call<{ ok: true }>('POST', '/api/auth/request', { email, invite }),
    verifyLogin: (token: string) => call<{ user: ApiUser }>('POST', '/api/auth/verify', { token }),
    logout: () => call<void>('POST', '/api/auth/logout'),
    logoutAll: () => call<void>('POST', '/api/auth/logout-all'),

    teams: () => call<Team[]>('GET', '/api/teams'),
    createTeam: (name: string) => call<Team>('POST', '/api/teams', { name }),
    updateTeam: (id: string, patch: { name?: string; archived?: boolean }) =>
      call<Team>('PATCH', `/api/teams/${seg(id)}`, patch),
    teamMembers: (id: string) => call<TeamMember[]>('GET', `/api/teams/${seg(id)}/members`),
    setTeamRole: (teamId: string, userId: string, role: TeamRole) =>
      call<TeamMember>('PATCH', `/api/teams/${seg(teamId)}/members/${seg(userId)}`, { role }),
    removeTeamMember: (teamId: string, userId: string) =>
      call<void>('DELETE', `/api/teams/${seg(teamId)}/members/${seg(userId)}`),
    createInvite: (teamId: string, opts: { role?: TeamRole; days?: number } = {}) =>
      call<CreatedInvite>('POST', `/api/teams/${seg(teamId)}/invites`, opts),
    listInvites: (teamId: string) => call<Invite[]>('GET', `/api/teams/${seg(teamId)}/invites`),
    revokeInvite: (teamId: string, inviteId: string) =>
      call<void>('DELETE', `/api/teams/${seg(teamId)}/invites/${seg(inviteId)}`),
    invitePreview: (token: string) => call<InvitePreview>('GET', `/api/invites/${seg(token)}`),
    acceptInvite: (token: string) => call<InvitePreview>('POST', `/api/invites/${seg(token)}/accept`),

    boards: () => call<ServerBoard[]>('GET', '/api/boards'),
    createBoard: (board: { id: string; title?: string; teamId?: string }) =>
      call<ServerBoard>('POST', '/api/boards', board),
    updateBoard: (id: string, patch: { title?: string; teamId?: string | null }) =>
      call<ServerBoard>('PATCH', `/api/boards/${seg(id)}`, patch),
    deleteBoard: (id: string) => call<void>('DELETE', `/api/boards/${seg(id)}`),
    /** Uploads an image for a board; answers with the stored hash and the type and size the server read from the bytes. */
    uploadAsset: (boardId: string, bytes: Blob, type: string) => sendBytes<AssetInfo>(`/api/boards/${seg(boardId)}/assets`, bytes, type),
    /** Asks for a file another board of the caller's already holds, without sending bytes. */
    claimAsset: (boardId: string, hash: string) => call<AssetInfo>('POST', `/api/boards/${seg(boardId)}/assets/claim`, { hash }),
    shares: (boardId: string) => call<Share[]>('GET', `/api/boards/${seg(boardId)}/shares`),
    share: (boardId: string, grant: { principalType: PrincipalType; principalId: string; role: ShareRole }) =>
      call<void>('POST', `/api/boards/${seg(boardId)}/shares`, grant),
    unshare: (boardId: string, principalType: PrincipalType, principalId: string) =>
      call<void>('DELETE', `/api/boards/${seg(boardId)}/shares/${seg(principalType)}/${seg(principalId)}`),
    joinWithCode: (code: string, name: string) => call<GuestJoin>('POST', '/api/join', { code, name }),
    joinCodes: (boardId: string) => call<JoinCodeInfo[]>('GET', `/api/boards/${seg(boardId)}/join-codes`),
    createJoinCode: (boardId: string, input: { role: 'commenter' | 'editor'; expiresInHours?: number; maxUses?: number }) =>
      call<CreatedJoinCode>('POST', `/api/boards/${seg(boardId)}/join-codes`, input),
    revokeJoinCode: (boardId: string, id: string) => call<void>('DELETE', `/api/boards/${seg(boardId)}/join-codes/${seg(id)}`),

    listTemplates: () => call<ServerTemplateInfo[]>('GET', '/api/templates', undefined, TEMPLATE_TIMEOUT_MS),
    getTemplate: (id: string) => call<ServerTemplate>('GET', `/api/templates/${seg(id)}`, undefined, TEMPLATE_TIMEOUT_MS),
    createTemplate: (input: TemplateInput) => call<ServerTemplate>('POST', '/api/templates', input, TEMPLATE_TIMEOUT_MS),
    updateTemplate: (id: string, patch: Partial<TemplateInput> & { teamId?: string | null }) =>
      call<ServerTemplate>('PATCH', `/api/templates/${seg(id)}`, patch, TEMPLATE_TIMEOUT_MS),
    duplicateTemplate: (id: string) => call<ServerTemplate>('POST', `/api/templates/${seg(id)}/duplicate`, undefined, TEMPLATE_TIMEOUT_MS),
    deleteTemplate: (id: string) => call<void>('DELETE', `/api/templates/${seg(id)}`),

    members: () => call<Member[]>('GET', '/api/members'),
    updateMember: (id: string, patch: { role?: UserRole; disabled?: boolean }) =>
      call<Member>('PATCH', `/api/members/${seg(id)}`, patch),
    eraseMemberChat: (id: string) => call<{ removed: number }>('POST', `/api/admin/members/${seg(id)}/chat-erase`),
    memberChatExport: (id: string) => call<unknown>('GET', `/api/admin/members/${seg(id)}/chat-export`),
    removeMember: (id: string) => call<void>('DELETE', `/api/members/${seg(id)}`),

    billingPortal: () => call<{ url: string }>('POST', '/api/billing/portal'),

    versions: (boardId: string) => call<{ versions: Version[] }>('GET', `/api/boards/${seg(boardId)}/versions`),
    versionState: (boardId: string, id: string) => callBytes(`/api/boards/${seg(boardId)}/versions/${seg(id)}/state`),
    saveVersion: (boardId: string, label: string, by?: string) =>
      call<Version>('POST', `/api/boards/${seg(boardId)}/versions`, { label, by }),
    nameVersion: (boardId: string, id: string, label: string, by?: string) =>
      call<Version>('PATCH', `/api/boards/${seg(boardId)}/versions/${seg(id)}`, { label, by }),
    deleteVersion: (boardId: string, id: string) => call<void>('DELETE', `/api/boards/${seg(boardId)}/versions/${seg(id)}`),
    beginRestore: (boardId: string, id: string, by?: string) =>
      call<{ preRestore: Version | null }>('POST', `/api/boards/${seg(boardId)}/versions/${seg(id)}/begin-restore`, { by }),
    accessTokens: () => call<AccessToken[]>('GET', '/api/me/tokens'),
    createAccessToken: (input: { name: string; scope: AccessScope; boardIds?: string[]; days?: number }) =>
      call<CreatedAccessToken>('POST', '/api/me/tokens', input),
    revokeAccessToken: (id: string) => call<void>('DELETE', `/api/me/tokens/${seg(id)}`),
    revokeAllAccessTokens: () => call<{ revoked: number }>('POST', '/api/me/tokens/revoke-all'),
    adminAccessTokens: () => call<AdminAccessToken[]>('GET', '/api/admin/tokens'),
    adminRevokeAccessToken: (id: string) => call<void>('DELETE', `/api/admin/tokens/${seg(id)}`),

    aiConfig: () => call<AiConfig>('GET', '/api/ai/config'),
    saveMyAiKey: (input: { provider: string; apiKey: string; baseUrl?: string; model?: string }) =>
      call<{ provider: string; hint: string; baseUrl: string | null; model: string | null }>('PUT', '/api/ai/keys/me', input),
    testMyAiKey: () => call<AiKeyTest>('POST', '/api/ai/keys/me/test', {}),
    deleteMyAiKey: () => call<void>('DELETE', '/api/ai/keys/me'),
    adminAi: () => call<AdminAi>('GET', '/api/admin/ai'),
    updateAdminAi: (patch: AdminAiPatch) => call<AdminAi>('PUT', '/api/admin/ai', patch),
    testAdminAiKey: () => call<AiKeyTest>('POST', '/api/admin/ai/key/test', {}),
    deleteAdminAiKey: () => call<void>('DELETE', '/api/admin/ai/key'),

    adminOverview: () => call<AdminOverview>('GET', '/api/admin/overview'),
    adminMembers: () => call<AdminMember[]>('GET', '/api/admin/members'),
    revokeMemberSessions: (id: string) => call<void>('POST', `/api/admin/members/${seg(id)}/revoke-sessions`),
    adminSessions: () => call<AdminSession[]>('GET', '/api/admin/sessions'),
    revokeSession: (id: string) => call<void>('DELETE', `/api/admin/sessions/${seg(id)}`),
    adminBoards: (deleted = false) => call<AdminBoard[]>('GET', `/api/admin/boards${qs({ deleted: deleted ? 1 : undefined })}`),
    adminBoard: (id: string) => call<AdminBoard>('GET', `/api/admin/boards/${seg(id)}`),
    restoreBoard: (id: string) => call<void>('POST', `/api/admin/boards/${seg(id)}/restore`),
    chatChannel: (kind: string, ref: string) => call<ChatChannelInfo>('GET', `/api/chat/${seg(kind)}/${seg(ref)}`),
    chatMessages: (kind: string, ref: string, opts: { before?: number; limit?: number } = {}) =>
      call<{ messages: ChatMessage[]; next: number | null }>('GET', `/api/chat/${seg(kind)}/${seg(ref)}/messages${qs({ before: opts.before, limit: opts.limit })}`),
    chatSend: (kind: string, ref: string, body: { clientId: string; text: string; replyTo?: number | null; objectId?: string | null }) =>
      call<{ message: ChatMessage }>('POST', `/api/chat/${seg(kind)}/${seg(ref)}/messages`, body),
    chatEdit: (id: number, text: string) => call<{ message: ChatMessage }>('PATCH', `/api/chat/messages/${id}`, { text }),
    chatDelete: (id: number) => call<void>('DELETE', `/api/chat/messages/${id}`),
    chatRead: (kind: string, ref: string, lastId: number) =>
      call<{ kind: string; ref: string; lastId: number }>('PUT', `/api/chat/${seg(kind)}/${seg(ref)}/read`, { lastId }),
    chatUnread: () => call<{ channels: ChatUnread[] }>('GET', '/api/chat/unread'),
    chatReact: (id: number, emoji: string, on: boolean) =>
      call<{ id: number; reactions: { emoji: string; userIds: string[] }[] }>(on ? 'PUT' : 'DELETE', `/api/chat/messages/${id}/reactions/${encodeURIComponent(emoji)}`),
    chatPrefs: () => call<{ emailMentions: boolean }>('GET', '/api/me/prefs'),
    setChatPrefs: (patch: { emailMentions: boolean }) => call<{ emailMentions: boolean }>('PUT', '/api/me/prefs', patch),
    chatChannels: () => call<{ channels: ChatChannelEntry[] }>('GET', '/api/chat/channels'),
    adminChat: () => call<ChatSettings>('GET', '/api/admin/chat'),
    setAdminChat: (patch: Partial<ChatSettings>) => call<ChatSettings>('PUT', '/api/admin/chat', patch),
    adminUpdates: () => call<AdminUpdates>('GET', '/api/admin/updates'),
    setAdminUpdates: (auto: boolean) => call<AdminUpdates>('PUT', '/api/admin/updates', { auto }),

    adminAudit: (opts: { limit?: number; before?: number; action?: string } = {}) =>
      call<AuditPage>('GET', `/api/admin/audit${qs({ limit: opts.limit, before: opts.before, action: opts.action })}`),

    adminBackups: () => call<BackupList>('GET', '/api/admin/backups', undefined, BACKUP_TIMEOUT_MS),
    adminBackup: (name: string) => call<BackupPreview>('GET', `/api/admin/backups/${seg(name)}`, undefined, BACKUP_TIMEOUT_MS),
    adminBackupBoards: (name: string) => call<BackupBoards>('GET', `/api/admin/backups/${seg(name)}/boards`, undefined, BACKUP_TIMEOUT_MS),
    restoreBackupBoard: (manifest: string, boardId: string) =>
      call<BoardCopy>('POST', '/api/admin/backups/restore-board', { manifest, boardId }, BACKUP_TIMEOUT_MS),
    restoreBackup: (manifest: string, confirm: string) =>
      call<{ ok: true; restarting: true; keepOldFor: string }>('POST', '/api/admin/backups/restore', { manifest, confirm }, RESTORE_TIMEOUT_MS),
  };
}

export const api = createApi();
