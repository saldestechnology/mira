import { loadSourcePolicy } from './source-policy.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLegacyEnv } from './env.mjs';
import { DEFAULT_MODEL, MODELS } from './ai/anthropic.mjs';
import { checkBaseUrl, checkModelId } from './ai/base-url.mjs';
import { PROVIDERS } from './ai/providers.mjs';
import { parseSecret } from './ai/keys.mjs';
import { CLIENT_IP_HEADERS } from './client-ip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const MAIL_MODES = ['log', 'file', 'webhook', 'smtp'];
const CLOUD_VARS = ['TABULA_CLOUD_TOKEN', 'TABULA_CLOUD_URL', 'TABULA_CLOUD_WORKSPACE_ID'];
const CLOUD_TOKEN_MIN = 32;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const WORKSPACE_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || /[\s\p{Cc},;<>()[\]\\":]/u.test(email)) return null;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

// MCP endpoint (docs/mcp.md). The old MIRA_ spelling is mapped to TABULA_ by withLegacyEnv, not here.
const MCP_SCOPES = ['read', 'comment', 'write'];
const MCP_TOKEN_MIN = 32;
const mcpVar = (env, name) => (env[`TABULA_${name}`] ?? '').trim();

// null when off. Accounts mode: per-user access tokens. Open mode: one shared token with a fixed scope.
function loadMcp(env, authEnabled, url) {
  const mode = mcpVar(env, 'MCP') || 'off';
  if (mode !== 'on' && mode !== 'off') throw new Error(`TABULA_MCP must be on or off (got "${mode.slice(0, 20)}")`);
  if (mode === 'off') return null;
  if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('TABULA_MCP=on needs an https:// base URL (http:// is only allowed for localhost), because access tokens must not cross the network in clear text');
  }
  const token = mcpVar(env, 'MCP_TOKEN');
  const scope = mcpVar(env, 'MCP_SCOPE');
  if (authEnabled) {
    return { mode: 'accounts', ignored: [token && 'TABULA_MCP_TOKEN', scope && 'TABULA_MCP_SCOPE'].filter(Boolean) };
  }
  if (token.length < MCP_TOKEN_MIN || /\s/.test(token)) {
    throw new Error(`TABULA_MCP_TOKEN must be set, at least ${MCP_TOKEN_MIN} characters without spaces, when TABULA_MCP=on in open mode`);
  }
  if (scope && !MCP_SCOPES.includes(scope)) throw new Error(`TABULA_MCP_SCOPE must be one of ${MCP_SCOPES.join(', ')} (got "${scope.slice(0, 20)}")`);
  return { mode: 'open', token, scope: scope || 'read', ignored: [] };
}

// Images on a board (docs/images.md). Sizes are bytes, with an optional K, M or G suffix (powers of 1024).
const SIZE_RE = /^(\d+)\s*([kmg])?b?$/i;
export function parseSize(text, name) {
  const m = SIZE_RE.exec(String(text).trim());
  const value = m ? Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? '').toLowerCase()] : NaN;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a size in bytes, such as 10485760 or 10M (got "${String(text).slice(0, 20)}")`);
  return value;
}

// null when off. The per-board quota is 100 MB with accounts and 50 MB without: in open mode anyone with a link can upload.
function loadAssets(env, authEnabled) {
  const mode = (env.TABULA_ASSETS ?? '').trim() || 'on';
  if (mode !== 'on' && mode !== 'off') throw new Error(`TABULA_ASSETS must be on or off (got "${mode.slice(0, 20)}")`);
  if (mode === 'off') return null;
  const size = (name, fallback) => (env[name] != null && String(env[name]).trim() !== '' ? parseSize(env[name], name) : fallback);
  const maxBytes = size('TABULA_ASSET_MAX_BYTES', 10 * 1024 * 1024);
  if (maxBytes < 1) throw new Error('TABULA_ASSET_MAX_BYTES must be at least 1');
  return {
    maxBytes,
    boardQuota: size('TABULA_ASSET_BOARD_QUOTA', (authEnabled ? 100 : 50) * 1024 * 1024),
    totalQuota: size('TABULA_ASSET_TOTAL_QUOTA', 0),
  };
}

// Team chat (docs/chat.md). On wherever accounts exist (TABULA_AUTH=on); TABULA_CHAT=off is the operator's opt-out. Never in open
// mode: chat needs an identity the server trusts, which open mode does not have.
function loadChat(env, authEnabled, warn) {
  const mode = (env.TABULA_CHAT ?? '').trim() || (authEnabled ? 'on' : 'off');
  if (mode !== 'on' && mode !== 'off') throw new Error(`TABULA_CHAT must be on or off (got "${mode.slice(0, 20)}")`);
  if (mode === 'on' && !authEnabled) {
    // an explicit TABULA_CHAT=on in open mode still says why nothing happens
    if ((env.TABULA_CHAT ?? '').trim()) warn('TABULA_CHAT=on is ignored: chat needs accounts mode (TABULA_AUTH=on)');
    return false;
  }
  return mode === 'on';
}

// Tracker tools (docs/mcp.md). The directory migration runs independently; this switch only exposes the feature.
function loadTracker(env) {
  const mode = (env.TABULA_TRACKER ?? '').trim() || 'off';
  if (mode !== 'on' && mode !== 'off') throw new Error(`TABULA_TRACKER must be on or off (got "${mode.slice(0, 20)}")`);
  return mode === 'on';
}

// AI features (docs/ai.md). The secrets are not enumerable, so printing or serialising the config never shows them.
// Open mode has no accounts to own a key, so it needs both the operator's key and the explicit TABULA_AI_OPEN=1: a key
// alone never turns AI on, because anyone with a board link would then spend it.
const AI_KEY_RE = /^\S{8,512}$/;

function hide(object, names) {
  for (const name of names) Object.defineProperty(object, name, { value: object[name], enumerable: false, writable: true, configurable: true });
  return object;
}

function loadAi(env, authEnabled, warn) {
  const provider = (env.TABULA_AI_PROVIDER || '').trim() || 'anthropic';
  if (!PROVIDERS.includes(provider)) throw new Error(`TABULA_AI_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${provider.slice(0, 20)}")`);
  // An OpenAI-compatible provider has no fixed list of models and no fixed address: the operator names both (docs/ai.md).
  let model;
  let baseUrl = null;
  if (provider === 'openai-compatible' && !authEnabled) {
    const url = checkBaseUrl(env.TABULA_AI_BASE_URL, { trusted: true });
    if (url.error) throw new Error(`TABULA_AI_BASE_URL is required with TABULA_AI_PROVIDER=openai-compatible: ${url.error.replace(/^baseUrl /, '')}`);
    baseUrl = url.baseUrl;
    const id = checkModelId(env.TABULA_AI_MODEL);
    if (id.error) throw new Error(`TABULA_AI_MODEL is required with TABULA_AI_PROVIDER=openai-compatible: ${id.error.replace(/^model /, '')}`);
    model = id.model;
  } else if (provider === 'openai-compatible') {
    // accounts mode: each key carries its own provider, address and model, so these variables are ignored, not even checked
    model = DEFAULT_MODEL;
  } else {
    if ((env.TABULA_AI_BASE_URL || '').trim() && !authEnabled) throw new Error('TABULA_AI_BASE_URL applies to TABULA_AI_PROVIDER=openai-compatible only');
    model = (env.TABULA_AI_MODEL || '').trim() || DEFAULT_MODEL;
    if (!MODELS.includes(model)) throw new Error(`TABULA_AI_MODEL must be one of ${MODELS.join(', ')} (got "${model.slice(0, 40)}")`);
  }

  const secret = parseSecret(env.TABULA_AI_SECRET, 'TABULA_AI_SECRET');
  const previous = parseSecret(env.TABULA_AI_SECRET_PREVIOUS, 'TABULA_AI_SECRET_PREVIOUS');
  if (previous && !secret) throw new Error('TABULA_AI_SECRET_PREVIOUS needs TABULA_AI_SECRET too');

  const rawProxyUrl = (env.TABULA_AI_PROXY_URL || '').trim();
  let proxyUrl = null;
  if (rawProxyUrl) {
    let url;
    try {
      url = new URL(rawProxyUrl);
    } catch {
      throw new Error('TABULA_AI_PROXY_URL is not a valid URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
      throw new Error('TABULA_AI_PROXY_URL must be an https:// URL (http:// is only allowed for loopback tests)');
    }
    if (url.username || url.password || url.search || url.hash || rawProxyUrl.includes('?') || rawProxyUrl.includes('#')) {
      throw new Error('TABULA_AI_PROXY_URL must not contain credentials, a query or a fragment');
    }
    proxyUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }
  const proxyToken = (env.TABULA_AI_PROXY_TOKEN || '').trim() || null;

  const apiKey = (env.TABULA_AI_API_KEY || '').trim();
  if (apiKey && !AI_KEY_RE.test(apiKey)) throw new Error('TABULA_AI_API_KEY must be 8 to 512 characters without spaces');
  const flag = (env.TABULA_AI_OPEN || '').trim();
  if (flag !== '' && flag !== '0' && flag !== '1') throw new Error('TABULA_AI_OPEN must be 1 or 0');

  let open = null;
  if (authEnabled) {
    if (apiKey || flag === '1') warn('TABULA_AI_API_KEY and TABULA_AI_OPEN are ignored in accounts mode: the workspace key is set in the admin dashboard');
  } else if (apiKey && flag === '1') {
    open = hide({ apiKey }, ['apiKey']);
  } else if (apiKey) {
    warn('AI is off: TABULA_AI_API_KEY is set but TABULA_AI_OPEN is not 1. Anyone with a board link would spend this key, so it is not used until you set TABULA_AI_OPEN=1');
  } else if (flag === '1') {
    warn('TABULA_AI_OPEN=1 does nothing without TABULA_AI_API_KEY');
  }
  if (authEnabled && (provider === 'openai-compatible' || (env.TABULA_AI_BASE_URL || '').trim())) warn('TABULA_AI_PROVIDER, TABULA_AI_BASE_URL and TABULA_AI_MODEL are ignored for OpenAI-compatible providers in accounts mode: each key carries its own provider, address and model');
  return hide({ provider, model, baseUrl, secret, previous, open, proxyUrl, proxyToken }, ['secret', 'previous', 'open', 'proxyToken']);
}

// Hosted workspaces (docs/cloud.md). All three variables or none; the result is null unless accounts mode is on too.
function loadCloud(env, authEnabled) {
  const values = CLOUD_VARS.map((name) => (env[name] || '').trim());
  if (values.every((v) => !v)) return null;
  const missing = CLOUD_VARS.filter((_, i) => !values[i]);
  if (missing.length) throw new Error(`${CLOUD_VARS.join(', ')} must be set together (missing ${missing.join(', ')})`);
  const [token, rawUrl, workspaceId] = values;

  if (token.length < CLOUD_TOKEN_MIN || /\s/.test(token)) {
    throw new Error(`TABULA_CLOUD_TOKEN must be at least ${CLOUD_TOKEN_MIN} characters without spaces`);
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('TABULA_CLOUD_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('TABULA_CLOUD_URL must be an https:// URL (http:// is only allowed for localhost)');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('TABULA_CLOUD_URL must not contain credentials, a query or a fragment');
  }
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    throw new Error('TABULA_CLOUD_WORKSPACE_ID must be 1 to 128 letters, digits, . - or _');
  }
  if (!authEnabled) return null;
  return { token, url: `${url.origin}${url.pathname}`.replace(/\/+$/, ''), workspaceId };
}

/**
 * Which header holds the client's address behind a proxy (server/client-ip.mjs, docs/cloud.md "Client addresses"):
 * `x-forwarded-for` (the default, its rightmost entry) or `fly-client-ip`. Read only with TABULA_TRUST_PROXY=1.
 */
function loadClientIpHeader(env, warn) {
  const raw = (env.TABULA_CLIENT_IP_HEADER ?? '').trim().toLowerCase();
  if (!raw) return 'x-forwarded-for';
  if (!CLIENT_IP_HEADERS.includes(raw)) throw new Error(`TABULA_CLIENT_IP_HEADER must be one of ${CLIENT_IP_HEADERS.join(', ')} (got "${raw.slice(0, 40)}")`);
  if (env.TABULA_TRUST_PROXY !== '1') warn('TABULA_CLIENT_IP_HEADER is ignored without TABULA_TRUST_PROXY=1: rate limits count by the connection address');
  return raw;
}

export function loadConfig(rawEnv = process.env, warn = console.warn) {
  const env = withLegacyEnv(rawEnv, warn);
  const authEnabled = env.TABULA_AUTH === 'on';
  const port = Number(env.PORT) || 8787;
  const dataDir = path.resolve(env.DATA_DIR || path.join(here, '..', 'data'));

  const ownerRaw = (env.TABULA_OWNER_EMAIL || '').trim();
  const ownerEmail = normaliseEmail(ownerRaw);
  if (ownerRaw && !ownerEmail) throw new Error('TABULA_OWNER_EMAIL is not a valid email address');
  if (authEnabled && !ownerEmail) throw new Error('TABULA_OWNER_EMAIL is required when TABULA_AUTH=on');

  const baseUrl = (env.TABULA_BASE_URL || `http://localhost:${port}`).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`TABULA_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('TABULA_BASE_URL must be an http:// or https:// URL');
  }
  const origin = url.origin;
  const secureCookies = origin.startsWith('https:');

  const days = Number(env.TABULA_SESSION_DAYS);
  const sessionMs = (days > 0 && Number.isFinite(days) ? days : 30) * DAY_MS;

  const mode = (env.TABULA_MAIL || 'log').trim();
  if (!MAIL_MODES.includes(mode)) {
    throw new Error(`TABULA_MAIL must be one of ${MAIL_MODES.join(', ')} (got "${mode}")`);
  }
  const webhookUrl = (env.TABULA_MAIL_WEBHOOK_URL || '').trim() || null;
  if (mode === 'webhook' && !webhookUrl) {
    throw new Error('TABULA_MAIL_WEBHOOK_URL is required when TABULA_MAIL=webhook');
  }

  const webhookToken = (env.TABULA_MAIL_WEBHOOK_TOKEN || '').trim() || null;
  const smtpUrl = (env.TABULA_SMTP_URL || '').trim() || null;
  if (mode === 'smtp') {
    if (!smtpUrl) throw new Error('TABULA_SMTP_URL is required when TABULA_MAIL=smtp (for example smtps://user:password@smtp.example.com:465)');
    if (!(env.TABULA_MAIL_FROM || '').trim()) throw new Error('TABULA_MAIL_FROM is required when TABULA_MAIL=smtp');
  }

  const cloud = loadCloud(env, authEnabled);
  const mcp = loadMcp(env, authEnabled, url);
  const ai = loadAi(env, authEnabled, warn);
  const assets = loadAssets(env, authEnabled);
  const chat = loadChat(env, authEnabled, warn);
  const tracker = loadTracker(env);
  const joinCodeMode = (env.TABULA_JOIN_CODES ?? '').trim() || 'off';
  if (joinCodeMode !== 'on' && joinCodeMode !== 'off') throw new Error(`TABULA_JOIN_CODES must be on or off (got "${joinCodeMode.slice(0, 20)}")`);
  if (joinCodeMode === 'on' && !authEnabled) warn('TABULA_JOIN_CODES=on is ignored without accounts mode (TABULA_AUTH=on)');
  const joinCodes = authEnabled && joinCodeMode === 'on';
  // the release label of this build, set when the image is built (Dockerfile ARG TABULA_VERSION); null when it was not
  const versionLabel = (env.TABULA_VERSION || '').trim();
  if (versionLabel && !/^[A-Za-z0-9._-]{1,40}$/.test(versionLabel)) warn('TABULA_VERSION is ignored: use 1 to 40 letters, digits, dots, dashes or underscores');

  return {
    version: /^[A-Za-z0-9._-]{1,40}$/.test(versionLabel) ? versionLabel : null,
    authEnabled,
    ownerEmail,
    baseUrl,
    origin,
    secureCookies,
    trustProxy: env.TABULA_TRUST_PROXY === '1',
    clientIpHeader: loadClientIpHeader(env, warn),
    sourcePolicy: loadSourcePolicy(env),
    cookieName: secureCookies ? '__Host-tabula_session' : 'tabula_session',
    sessionMs,
    loginTokenMs: 15 * 60 * 1000,
    dataDir,
    port,
    mail: { mode, webhookUrl, webhookToken, smtpUrl, from: env.TABULA_MAIL_FROM || 'Tabula <no-reply@localhost>' },
    ai,
    assets,
    ...(joinCodes ? { joinCodes: true } : {}),
    ...(chat ? { chat: true } : {}),
    tracker,
    ...(cloud ? { cloud } : {}),
    ...(mcp ? { mcp } : {}),
  };
}
