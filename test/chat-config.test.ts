import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config.mjs';

// TABULA_CHAT (docs/chat.md): on by default wherever accounts exist, TABULA_CHAT=off is the opt-out, never in open mode.

const ACCOUNTS = { TABULA_AUTH: 'on', TABULA_OWNER_EMAIL: 'owner@example.com' };
const load = (env: Record<string, string>) => {
  const warnings: string[] = [];
  const config = loadConfig(env, (w: string) => warnings.push(w));
  return { config, warnings };
};

describe('TABULA_CHAT', () => {
  it('is on by default in accounts mode, with no flag', () => {
    const { config, warnings } = load(ACCOUNTS);
    expect(config.chat).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('is off in open mode unless asked, and then says why it stays off', () => {
    const quiet = load({});
    expect(quiet.config.chat).toBeUndefined();
    expect(quiet.warnings).toEqual([]);
    const asked = load({ TABULA_CHAT: 'on' });
    expect(asked.config.chat).toBeUndefined();
    expect(asked.warnings.join('\n')).toContain('TABULA_CHAT=on is ignored');
  });

  it('can be turned off by the operator in accounts mode, and on explicitly', () => {
    expect(load({ ...ACCOUNTS, TABULA_CHAT: 'off' }).config.chat).toBeUndefined();
    expect(load({ ...ACCOUNTS, TABULA_CHAT: ' off ' }).config.chat).toBeUndefined();
    expect(load({ ...ACCOUNTS, TABULA_CHAT: 'on' }).config.chat).toBe(true);
    expect(load({ ...ACCOUNTS, TABULA_CHAT: ' on ' }).config.chat).toBe(true);
  });

  it('honours the old MIRA_ spelling', () => {
    expect(load({ ...ACCOUNTS, MIRA_CHAT: 'off' }).config.chat).toBeUndefined();
    expect(load({ ...ACCOUNTS, MIRA_CHAT: 'on' }).config.chat).toBe(true);
  });

  it.each(['yes', '1', 'true', 'ON'])('refuses %s', (value) => {
    expect(() => load({ ...ACCOUNTS, TABULA_CHAT: value })).toThrow('TABULA_CHAT must be on or off');
  });
});

describe('TABULA_CHAT_MENTION_MAIL_AFTER_MS', () => {
  it('shortens the mention mail delay only under NODE_ENV=test', async () => {
    const { mailAfterMsFromEnv } = await import('../server/chat-notify.mjs');
    expect(mailAfterMsFromEnv({ NODE_ENV: 'test', TABULA_CHAT_MENTION_MAIL_AFTER_MS: '400' })).toBe(400);
    expect(mailAfterMsFromEnv({ NODE_ENV: 'production', TABULA_CHAT_MENTION_MAIL_AFTER_MS: '400' })).toBeUndefined();
    expect(mailAfterMsFromEnv({ TABULA_CHAT_MENTION_MAIL_AFTER_MS: '400' })).toBeUndefined();
    expect(mailAfterMsFromEnv({ NODE_ENV: 'test' })).toBeUndefined();
  });
});
