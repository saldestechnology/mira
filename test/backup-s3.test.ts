import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  BackupError, canonicalQuery, createS3Client, encodeKeyPath, encodeSegment, loadBackupConfig, parseErrorCode, parseListXml,
  parseXml, s3Target, signRequest,
} from '../server/backup.mjs';
import { startFakeS3, type FakeS3 } from './backup-fake-s3';

// docs/backups.md. The S3 side: SigV4 against the published examples, the URL builder for the providers people use,
// the XML reader, the client against a local fake S3 that verifies every signature on its own, and the configuration.

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const EMPTY = sha('');

describe('SigV4 against the examples AWS publishes', () => {
  // Source: the AWS Signature Version 4 test suite (get-vanilla, post-vanilla), the IAM ListUsers example of "Create a
  // signed AWS API request", and the Amazon S3 documentation "Signature Calculations for the Authorization Header"
  // (GET Object with a Range, PUT Object, GET lifecycle, list objects). Every key, date and signature below is public
  // documentation.
  const SUITE = { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: '20150830T123600Z', region: 'us-east-1' };
  const S3DOC = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: '20130524T000000Z', region: 'us-east-1' };

  it('get-vanilla', () => {
    const r = signRequest({
      ...SUITE, service: 'service', method: 'GET', canonicalUri: '/', payloadHash: EMPTY,
      headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': SUITE.date },
    });
    expect(r.canonicalRequest).toBe(`GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`);
    expect(sha(r.canonicalRequest)).toBe('bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
    expect(r.stringToSign).toBe('AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
    expect(r.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    expect(r.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('post-vanilla', () => {
    const r = signRequest({
      ...SUITE, service: 'service', method: 'POST', canonicalUri: '/', payloadHash: EMPTY,
      headers: { host: 'example.amazonaws.com', 'x-amz-date': SUITE.date },
    });
    expect(r.signature).toBe('5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
  });

  it('the IAM ListUsers example (query string, content-type header)', () => {
    const r = signRequest({
      ...SUITE, service: 'iam', method: 'GET', canonicalUri: '/', payloadHash: EMPTY,
      query: [['Version', '2010-05-08'], ['Action', 'ListUsers']],
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', host: 'iam.amazonaws.com', 'x-amz-date': SUITE.date },
    });
    expect(sha(r.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(r.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  });

  it('S3 GET Object with a Range header', () => {
    const r = signRequest({
      ...S3DOC, method: 'GET', canonicalUri: '/test.txt', payloadHash: EMPTY,
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': S3DOC.date },
    });
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('S3 PUT Object (a $ in the key is encoded, a body is hashed)', () => {
    const body = 'Welcome to Amazon S3.';
    expect(sha(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    expect(encodeKeyPath('test$file.text')).toBe('test%24file.text');
    const r = signRequest({
      ...S3DOC, method: 'PUT', canonicalUri: `/${encodeKeyPath('test$file.text')}`, payloadHash: sha(body),
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT', host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': sha(body),
        'x-amz-date': S3DOC.date, 'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
    });
    expect(r.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('S3 GET with a query string that has no value (?lifecycle)', () => {
    const r = signRequest({
      ...S3DOC, method: 'GET', canonicalUri: '/', payloadHash: EMPTY, query: [['lifecycle', '']],
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': S3DOC.date },
    });
    expect(r.signature).toBe('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('S3 list objects (two parameters, sorted)', () => {
    const r = signRequest({
      ...S3DOC, method: 'GET', canonicalUri: '/', payloadHash: EMPTY, query: [['prefix', 'J'], ['max-keys', '2']],
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': S3DOC.date },
    });
    expect(r.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('encodes the way S3 expects: RFC 3986, once, slashes kept in a key', () => {
    expect(encodeSegment("a b!'()*~._-é")).toBe('a%20b%21%27%28%29%2A~._-%C3%A9');
    expect(encodeKeyPath('tabula/objects/a b')).toBe('tabula/objects/a%20b');
    expect(canonicalQuery([['b', '2'], ['a', 'x y'], ['a', 'x'], ['continuation-token', 'ab/c+d==']])).toBe('a=x&a=x%20y&b=2&continuation-token=ab%2Fc%2Bd%3D%3D');
  });
});

describe('URLs for the providers people use', () => {
  const t = (endpoint: string, pathStyle: boolean, key = 'tabula/objects/ab12', query: [string, string][] = []) =>
    s3Target({ endpoint, bucket: 'my-bucket', key, pathStyle, query });

  it('path style puts the bucket in the path', () => {
    expect(t('https://fly.storage.tigris.dev', true)).toEqual({
      host: 'fly.storage.tigris.dev', canonicalUri: '/my-bucket/tabula/objects/ab12', url: 'https://fly.storage.tigris.dev/my-bucket/tabula/objects/ab12',
    });
    expect(t('https://0123abcd.r2.cloudflarestorage.com', true).url).toBe('https://0123abcd.r2.cloudflarestorage.com/my-bucket/tabula/objects/ab12');
  });

  it('virtual hosted style puts the bucket in the host', () => {
    expect(t('https://fly.storage.tigris.dev', false)).toEqual({
      host: 'my-bucket.fly.storage.tigris.dev', canonicalUri: '/tabula/objects/ab12', url: 'https://my-bucket.fly.storage.tigris.dev/tabula/objects/ab12',
    });
    expect(t('https://0123abcd.r2.cloudflarestorage.com', false).host).toBe('my-bucket.0123abcd.r2.cloudflarestorage.com');
    expect(t('https://s3.eu-central-1.amazonaws.com', false).url).toBe('https://my-bucket.s3.eu-central-1.amazonaws.com/tabula/objects/ab12');
  });

  it('keeps a port in the Host header, in both styles', () => {
    expect(t('http://127.0.0.1:9000', true).host).toBe('127.0.0.1:9000');
    expect(t('https://storage.example.com:8443', true)).toMatchObject({ host: 'storage.example.com:8443', url: 'https://storage.example.com:8443/my-bucket/tabula/objects/ab12' });
    expect(t('https://storage.example.com:8443', false).host).toBe('my-bucket.storage.example.com:8443');
  });

  it('drops the default port and lower-cases the host', () => {
    expect(t('https://Storage.Example.com:443', true).host).toBe('storage.example.com');
    expect(t('http://localhost:80', true).host).toBe('localhost');
  });

  it('a custom domain works like any other host', () => {
    expect(t('https://backups.example.org', true).url).toBe('https://backups.example.org/my-bucket/tabula/objects/ab12');
    expect(t('https://backups.example.org', false).url).toBe('https://my-bucket.backups.example.org/tabula/objects/ab12');
  });

  it('lists the bucket itself: no key, the query sorted and encoded', () => {
    const q: [string, string][] = [['list-type', '2'], ['prefix', 'tabula/objects/'], ['continuation-token', 'a/b+c==']];
    expect(t('https://fly.storage.tigris.dev', true, '', q).url).toBe('https://fly.storage.tigris.dev/my-bucket?continuation-token=a%2Fb%2Bc%3D%3D&list-type=2&prefix=tabula%2Fobjects%2F');
    expect(t('https://fly.storage.tigris.dev', false, '', q).url).toBe('https://my-bucket.fly.storage.tigris.dev/?continuation-token=a%2Fb%2Bc%3D%3D&list-type=2&prefix=tabula%2Fobjects%2F');
  });

  it('encodes odd characters in a key once, in the signed path and in the URL alike', () => {
    const target = t('https://x.example.com', true, 'a b/ü/100%+x');
    expect(target.canonicalUri).toBe('/my-bucket/a%20b/%C3%BC/100%25%2Bx');
    expect(new URL(target.url).pathname).toBe(target.canonicalUri);
  });
});

describe('the XML reader', () => {
  const list = (body: string, extra = '') =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name>${extra}${body}</ListBucketResult>`;
  const item = (key: string, size = '5', at = '2026-10-08T10:00:00.000Z') =>
    `<Contents><Key>${key}</Key><LastModified>${at}</LastModified><ETag>&quot;e&quot;</ETag><Size>${size}</Size></Contents>`;

  it('reads a listing, with entities', () => {
    const page = parseListXml(list(`${item('a&amp;b')}${item('c')}<IsTruncated>false</IsTruncated>`));
    expect(page).toEqual({
      contents: [
        { key: 'a&b', size: 5, lastModified: Date.parse('2026-10-08T10:00:00.000Z') },
        { key: 'c', size: 5, lastModified: Date.parse('2026-10-08T10:00:00.000Z') },
      ],
      truncated: false,
      next: null,
    });
  });

  it('reads the continuation token of a truncated page, and insists on one', () => {
    expect(parseListXml(list(`${item('a')}<IsTruncated>true</IsTruncated><NextContinuationToken>tok/en==</NextContinuationToken>`)).next).toBe('tok/en==');
    expect(() => parseListXml(list(`${item('a')}<IsTruncated>true</IsTruncated>`))).toThrow(BackupError);
  });

  it('leaves out entries it cannot trust instead of guessing', () => {
    const page = parseListXml(list(`${item('ok')}${item('bad-size', 'many')}${item('bad-date', '5', 'yesterday')}<Contents><Size>1</Size></Contents>${item('')}`));
    expect(page.contents.map((c) => c.key)).toEqual(['ok']);
  });

  it('decodes numeric entities and CDATA, ignores comments, declarations and attributes', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1 > 2"><b>&#65;&#x42;&lt;<![CDATA[<&>]]></b><c/><d y=\'/\'></d></a>');
    expect(root.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
    expect(root.children[0].text).toBe('AB<<&>');
  });

  it.each([
    ['a DOCTYPE', '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ['an unclosed tag', '<a><b></a>'],
    ['a mismatched tag', '<a></b>'],
    ['text outside the root', 'hi<a></a>'],
    ['a second root', '<a></a><b></b>'],
    ['an unterminated tag', '<a'],
    ['nothing', ''],
    ['an unterminated comment', '<a><!-- </a>'],
  ])('refuses %s', (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(BackupError);
  });

  it('refuses a document that is too deep', () => {
    expect(() => parseXml('<a>'.repeat(40) + '</a>'.repeat(40))).toThrow(BackupError);
  });

  it('refuses a listing that is not a ListBucketResult', () => {
    expect(() => parseListXml('<Error><Code>AccessDenied</Code></Error>')).toThrow(BackupError);
  });

  it('reads an error code and only a plausible one', () => {
    expect(parseErrorCode('<?xml version="1.0"?><Error><Code>SlowDown</Code><Message>x</Message></Error>')).toBe('SlowDown');
    expect(parseErrorCode('<Error><Code>has spaces and more</Code></Error>')).toBeNull();
    expect(parseErrorCode('<html>nope</html>')).toBeNull();
    expect(parseErrorCode('not xml')).toBeNull();
  });
});

describe('the S3 client against a fake that verifies every signature', () => {
  const CREDS = { accessKey: 'AKIAFAKEACCESS0001', secretKey: 'fake/secret+key/for+the+tests0123456789ab', region: 'auto', bucket: 'test-bucket' };
  let fake: FakeS3;
  let clock = Date.UTC(2026, 9, 8, 19, 30, 0);

  afterEach(async () => {
    await fake?.close();
  });

  async function setup(extra: Record<string, unknown> = {}, pageSize = 1000) {
    clock = Date.UTC(2026, 9, 8, 19, 30, 0);
    fake = await startFakeS3({ creds: CREDS, clock: () => clock, pageSize });
    return createS3Client({
      endpoint: fake.url, region: CREDS.region, bucket: CREDS.bucket, accessKey: CREDS.accessKey, secretKey: CREDS.secretKey,
      pathStyle: true, now: () => clock, backoffMs: [0, 0, 0], ...extra,
    });
  }

  it('puts, gets, heads and deletes, with signatures the fake recomputes', async () => {
    const s3 = await setup();
    await s3.put('tabula/objects/one', Buffer.from('hello'));
    expect((await s3.get('tabula/objects/one')).toString()).toBe('hello');
    expect(await s3.head('tabula/objects/one')).toEqual({ size: 5 });
    expect(await s3.head('tabula/objects/none')).toBeNull();
    await s3.del('tabula/objects/one');
    expect(await s3.head('tabula/objects/one')).toBeNull();
    await expect(s3.get('tabula/objects/one')).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.badSignatures).toEqual([]);
  });

  it('signs keys that need encoding and bodies of any content', async () => {
    const s3 = await setup();
    const body = crypto.randomBytes(5000);
    await s3.put("odd key/ü+&=?#%'()!*~", body);
    expect((await s3.get("odd key/ü+&=?#%'()!*~")).equals(body)).toBe(true);
    await s3.put('empty', Buffer.alloc(0));
    expect(await s3.head('empty')).toEqual({ size: 0 });
    expect(fake.badSignatures).toEqual([]);
  });

  it('lists every page, with continuation tokens that need encoding', async () => {
    const s3 = await setup({}, 2);
    for (let i = 0; i < 7; i++) await s3.put(`tabula/objects/k${i}`, Buffer.from(String(i)));
    await s3.put('tabula/manifests/m', Buffer.from('x'));
    const items = await s3.list('tabula/objects/');
    expect(items.map((x) => x.key)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => `tabula/objects/k${i}`));
    expect(items[0]).toMatchObject({ size: 1, lastModified: clock });
    expect(fake.count('GET', /^$/)).toBe(4);
    expect(fake.badSignatures).toEqual([]);
  });

  it('retries a 500 and then succeeds', async () => {
    const s3 = await setup();
    fake.rules.push({ method: 'PUT', status: 500, times: 2 });
    await s3.put('k', Buffer.from('v'));
    expect(fake.count('PUT')).toBe(3);
    expect(fake.keys()).toEqual(['k']);
  });

  it('retries a 429 too', async () => {
    const s3 = await setup();
    fake.rules.push({ method: 'GET', key: /busy/, status: 429, times: 3 });
    fake.put('busy', Buffer.from('v'));
    expect((await s3.get('busy')).toString()).toBe('v');
    expect(fake.count('GET', /busy/)).toBe(4);
  });

  it('gives up after three retries and reports the status and S3 code only', async () => {
    const s3 = await setup();
    fake.rules.push({ method: 'PUT', status: 500, times: 99 });
    const err = await s3.put('k', Buffer.from('v')).catch((e) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect(err).toMatchObject({ code: 's3', status: 500, s3Code: 'InternalError' });
    expect(err.message).toBe('S3 PUT failed (status 500, InternalError)');
    expect(fake.count('PUT')).toBe(4);
  });

  it('does not retry a 403, a 404 on GET or a 400', async () => {
    const s3 = await setup();
    fake.rules.push({ method: 'PUT', status: 403, times: 99 });
    const denied = await s3.put('k', Buffer.from('v')).catch((e) => e);
    expect(denied).toMatchObject({ code: 's3', status: 403, s3Code: 'AccessDenied' });
    expect(fake.count('PUT')).toBe(1);
    fake.rules.length = 0;
    fake.rules.push({ method: 'DELETE', status: 400, times: 99 });
    await expect(s3.del('k')).rejects.toMatchObject({ status: 400 });
    expect(fake.count('DELETE')).toBe(1);
    await expect(s3.get('nope')).rejects.toMatchObject({ code: 'not_found' });
    expect(fake.count('GET', /nope/)).toBe(1);
  });

  it('retries a dropped connection', async () => {
    const s3 = await setup();
    fake.rules.push({ method: 'PUT', destroy: true, times: 1 });
    await s3.put('k', Buffer.from('v'));
    expect(fake.count('PUT')).toBe(2);
  });

  it('times out a request that never answers, and retries it', async () => {
    // The client's timer starts when the request is made; on a loaded machine a timeout shorter than the time the request needs
    // to reach the fake fires first, and the fake then counts fewer requests than the client made.
    const s3 = await setup({ requestTimeoutMs: 400 });
    fake.rules.push({ method: 'PUT', hang: true, times: 1 });
    await s3.put('k', Buffer.from('v'));
    expect(fake.count('PUT')).toBe(2);
    fake.rules.push({ method: 'GET', key: /slow/, hang: true, times: 99 });
    const err = await s3.get('slow').catch((e) => e);
    expect(err).toMatchObject({ code: 'timeout' });
    expect(fake.count('GET', /slow/)).toBe(4);
  });

  it('does not follow a redirect and says so', async () => {
    const s3 = await setup({
      fetch: async () => new Response('', { status: 301, headers: { location: 'https://elsewhere.example.com/?X-Amz-Signature=abc' } }),
    });
    const err = await s3.put('k', Buffer.from('v')).catch((e) => e);
    expect(err).toMatchObject({ code: 's3', status: 301 });
    expect(err.message).not.toContain('elsewhere');
  });

  it('a failing fetch is reported by its error code, never its message', async () => {
    const s3 = await setup({
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed for https://user:hunter2@host/?X-Amz-Signature=abcdef'), { cause: { code: 'ECONNREFUSED' } });
      },
      backoffMs: [],
    });
    const err = await s3.head('k').catch((e) => e);
    expect(err).toMatchObject({ code: 'network' });
    expect(err.message).toBe('S3 HEAD could not reach the storage provider (ECONNREFUSED)');
  });

  it('refuses an answer that is bigger than the caller allows', async () => {
    const s3 = await setup();
    await s3.put('big', Buffer.alloc(1000));
    await expect(s3.get('big', { maxBytes: 100 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('stops retrying when it is aborted', async () => {
    const controller = new AbortController();
    const s3 = await setup({ signal: controller.signal, backoffMs: [60_000] });
    fake.rules.push({ method: 'PUT', status: 500, times: 99 });
    const pending = s3.put('k', Buffer.from('v')).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(pending).resolves.toMatchObject({ code: 'aborted' });
  });
});

describe('configuration', () => {
  const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const KEY_B64 = Buffer.from(KEY_HEX, 'hex').toString('base64');
  const SECRET = 'S3cr3t/Value+that-must-never-appear-0123456789';
  const base = (extra: Record<string, string> = {}): Record<string, string> => ({
    TABULA_BACKUP_S3_ENDPOINT: 'https://fly.storage.tigris.dev',
    TABULA_BACKUP_BUCKET: 'my-bucket',
    TABULA_BACKUP_ACCESS_KEY: 'AKIAEXAMPLEACCESS01',
    TABULA_BACKUP_SECRET_KEY: SECRET,
    TABULA_BACKUP_KEY: KEY_B64,
    ...extra,
  });
  const load = (env: Record<string, string>) => loadBackupConfig(env, () => {});
  const messageOf = (env: Record<string, string>) => {
    try {
      load(env);
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  };

  it('is off without any of the required variables', () => {
    expect(load({})).toBeNull();
    expect(load({ TABULA_BACKUP_PREFIX: 'x', TABULA_BACKUP_INTERVAL_MINUTES: '30' })).toBeNull();
  });

  it('reads the defaults', () => {
    const config = load(base())!;
    expect(config).toMatchObject({
      endpoint: 'https://fly.storage.tigris.dev', bucket: 'my-bucket', prefix: 'tabula', region: 'auto', pathStyle: true,
      intervalMinutes: 60, keepHourlyHours: 48, keepDailyDays: 30,
    });
    expect(config.key.equals(Buffer.from(KEY_HEX, 'hex'))).toBe(true);
    expect(config.previousKeys).toEqual([]);
  });

  it('reads every setting', () => {
    const config = load(base({
      TABULA_BACKUP_PREFIX: '/workspaces/ws_1/', TABULA_BACKUP_REGION: 'eu-central-1', TABULA_BACKUP_PATH_STYLE: 'off',
      TABULA_BACKUP_INTERVAL_MINUTES: '1440', TABULA_BACKUP_KEEP_HOURLY_HOURS: '0', TABULA_BACKUP_KEEP_DAILY_DAYS: '7',
      TABULA_BACKUP_S3_ENDPOINT: 'https://s3.example.com:8443',
    }))!;
    expect(config).toMatchObject({
      endpoint: 'https://s3.example.com:8443', prefix: 'workspaces/ws_1', region: 'eu-central-1', pathStyle: false,
      intervalMinutes: 1440, keepHourlyHours: 0, keepDailyDays: 7,
    });
  });

  it('accepts the old MIRA_ spelling', () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base())) env[k.replace('TABULA_', 'MIRA_')] = v;
    expect(load(env)?.bucket).toBe('my-bucket');
  });

  it('takes the key as hex, base64, base64url, with or without padding', () => {
    const bytes = Buffer.from(KEY_HEX, 'hex');
    for (const spelling of [KEY_HEX, KEY_HEX.toUpperCase(), bytes.toString('base64'), bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url')]) {
      expect(load(base({ TABULA_BACKUP_KEY: spelling }))!.key.equals(bytes)).toBe(true);
    }
  });

  it('reads previous keys for old backups, once each, and never twice the current one', () => {
    const other = crypto.randomBytes(32);
    const third = crypto.randomBytes(32);
    const config = load(base({ TABULA_BACKUP_KEY_PREVIOUS: ` ${other.toString('hex')}, ${third.toString('base64')},${other.toString('hex')},${KEY_HEX} ` }))!;
    expect(config.previousKeys.map((k: Buffer) => k.toString('hex'))).toEqual([other.toString('hex'), third.toString('hex')]);
  });

  const table: [string, Record<string, string>, RegExp][] = [
    ['one required variable missing', (() => { const e = base(); delete e.TABULA_BACKUP_BUCKET; return e; })(), /must be set together \(missing TABULA_BACKUP_BUCKET\)/],
    ['two missing', { TABULA_BACKUP_S3_ENDPOINT: 'https://x.example.com', TABULA_BACKUP_BUCKET: 'bucket-1', TABULA_BACKUP_ACCESS_KEY: 'a' }, /missing TABULA_BACKUP_SECRET_KEY, TABULA_BACKUP_KEY/],
    ['only the key', { TABULA_BACKUP_KEY: KEY_HEX }, /missing TABULA_BACKUP_S3_ENDPOINT, TABULA_BACKUP_BUCKET/],
    ['a blank value counts as missing', base({ TABULA_BACKUP_SECRET_KEY: '   ' }), /missing TABULA_BACKUP_SECRET_KEY/],
    ['endpoint that is not a URL', base({ TABULA_BACKUP_S3_ENDPOINT: 'fly.storage.tigris.dev' }), /S3_ENDPOINT is not a valid URL/],
    ['plain http to a real host', base({ TABULA_BACKUP_S3_ENDPOINT: 'http://storage.example.com' }), /must be an https:\/\/ URL/],
    ['endpoint with credentials', base({ TABULA_BACKUP_S3_ENDPOINT: 'https://user:hunter2@storage.example.com' }), /without credentials/],
    ['endpoint with a path', base({ TABULA_BACKUP_S3_ENDPOINT: 'https://storage.example.com/bucket' }), /without credentials, a path/],
    ['endpoint with a query', base({ TABULA_BACKUP_S3_ENDPOINT: 'https://storage.example.com/?a=1' }), /without credentials, a path/],
    ['bucket with capitals', base({ TABULA_BACKUP_BUCKET: 'MyBucket' }), /BUCKET must be 3 to 63/],
    ['bucket that is too short', base({ TABULA_BACKUP_BUCKET: 'ab' }), /BUCKET must be 3 to 63/],
    ['access key with a space', base({ TABULA_BACKUP_ACCESS_KEY: 'two words' }), /ACCESS_KEY must be printable/],
    ['key that is too short (hex)', base({ TABULA_BACKUP_KEY: KEY_HEX.slice(0, 62) }), /KEY must be 32 bytes/],
    ['key that is too short (base64)', base({ TABULA_BACKUP_KEY: Buffer.alloc(16, 7).toString('base64') }), /KEY must be 32 bytes/],
    ['key that is too long', base({ TABULA_BACKUP_KEY: Buffer.alloc(33, 7).toString('base64') }), /KEY must be 32 bytes/],
    ['key that is not hex or base64', base({ TABULA_BACKUP_KEY: 'zz'.repeat(32) }), /KEY must be 32 bytes/],
    ['previous key that is malformed', base({ TABULA_BACKUP_KEY_PREVIOUS: `${KEY_HEX},nope` }), /KEY_PREVIOUS entry 2 must be 32 bytes/],
    ['too many previous keys', base({ TABULA_BACKUP_KEY_PREVIOUS: Array.from({ length: 9 }, () => crypto.randomBytes(32).toString('hex')).join(',') }), /at most 8 keys/],
    ['prefix with ..', base({ TABULA_BACKUP_PREFIX: 'a/../b' }), /PREFIX must be/],
    ['prefix with a space', base({ TABULA_BACKUP_PREFIX: 'my backups' }), /PREFIX must be/],
    ['region with a slash', base({ TABULA_BACKUP_REGION: 'eu/west' }), /REGION must be/],
    ['path style that is not on or off', base({ TABULA_BACKUP_PATH_STYLE: 'yes' }), /PATH_STYLE must be on or off/],
    ['virtual hosted style with an IP address', base({ TABULA_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9000', TABULA_BACKUP_PATH_STYLE: 'off' }), /PATH_STYLE=off needs a DNS name/],
    ['an interval below five minutes', base({ TABULA_BACKUP_INTERVAL_MINUTES: '4' }), /INTERVAL_MINUTES must be a whole number from 5 to 10080/],
    ['an interval that is not a number', base({ TABULA_BACKUP_INTERVAL_MINUTES: 'hourly' }), /INTERVAL_MINUTES must be a whole number/],
    ['a fractional interval', base({ TABULA_BACKUP_INTERVAL_MINUTES: '7.5' }), /INTERVAL_MINUTES must be a whole number/],
    ['a negative hourly retention', base({ TABULA_BACKUP_KEEP_HOURLY_HOURS: '-1' }), /KEEP_HOURLY_HOURS must be a whole number from 0 to 8760/],
    ['a daily retention that is too long', base({ TABULA_BACKUP_KEEP_DAILY_DAYS: '99999' }), /KEEP_DAILY_DAYS must be a whole number from 0 to 3650/],
  ];

  it.each(table)('refuses %s', (_name, env, expected) => {
    const message = messageOf(env);
    expect(message).toMatch(expected);
  });

  it('allows http only for local endpoints', () => {
    for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000']) {
      expect(load(base({ TABULA_BACKUP_S3_ENDPOINT: `http://${host}` }))?.endpoint).toBe(`http://${host}`);
    }
  });

  it('never puts the key, the secret or the endpoint credentials in an error', () => {
    const wrongKeys = ['short', KEY_HEX.slice(1), `${KEY_B64}AAAA`, 'k'.repeat(64), `${SECRET}${SECRET}`];
    for (const key of wrongKeys) {
      const message = messageOf(base({ TABULA_BACKUP_KEY: key, TABULA_BACKUP_KEY_PREVIOUS: key }));
      expect(message).not.toBeNull();
      expect(message).not.toContain(key);
      expect(message).not.toContain(SECRET);
    }
    for (const env of [
      base({ TABULA_BACKUP_S3_ENDPOINT: 'https://AKIDUSER:hunter2pass@storage.example.com' }),
      base({ TABULA_BACKUP_BUCKET: SECRET }),
      base({ TABULA_BACKUP_ACCESS_KEY: `${SECRET} extra` }),
      base({ TABULA_BACKUP_INTERVAL_MINUTES: SECRET }),
      base({ TABULA_BACKUP_PREFIX: `${SECRET}/../x` }),
      base({ TABULA_BACKUP_PATH_STYLE: SECRET }),
      base({ TABULA_BACKUP_REGION: SECRET }),
    ]) {
      const message = messageOf(env)!;
      expect(message).not.toBeNull();
      for (const secret of [SECRET, 'hunter2pass', 'AKIDUSER', KEY_B64, KEY_HEX]) expect(message).not.toContain(secret);
    }
  });

  it('keeps the secrets off the printable config', () => {
    const config = load(base({ TABULA_BACKUP_KEY_PREVIOUS: crypto.randomBytes(32).toString('hex') }))!;
    const printed = `${JSON.stringify(config)} ${JSON.stringify(Object.keys(config))}`;
    for (const secret of [SECRET, 'AKIAEXAMPLEACCESS01', KEY_B64, KEY_HEX]) expect(printed).not.toContain(secret);
    expect(config.secretKey).toBe(SECRET);
  });
});
