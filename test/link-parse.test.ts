import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, parseLinkHead } from '../server/link-parse.mjs';

describe('link preview HTML head parser', () => {
  it('prefers OpenGraph metadata, decodes entities and resolves image and icon URLs', () => {
    const result = parseLinkHead(`<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="A &amp; B &#x1f680;">
      <meta property="og:description" content="A&nbsp;short&#10;description">
      <meta property="og:site_name" content="Example &copy;">
      <meta property="og:image" content="../preview.png?x=1&amp;y=2">
      <base href="https://cdn.example.test/cards/">
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="apple-touch-icon" href="touch.png" sizes="180x180">
      <link rel="icon" href="large.png" sizes="256x256">
      <link rel="icon" href="too-large.png" sizes="512x512">
      </head><body><meta property="og:title" content="body is ignored"></body></html>`, {
      finalUrl: 'https://www.example.test/path/page',
    });

    expect(result).toMatchObject({
      title: 'A & B 🚀',
      description: 'A short description',
      siteName: 'Example ©',
      imageUrl: 'https://cdn.example.test/preview.png?x=1&y=2',
      iconUrl: 'https://cdn.example.test/cards/large.png',
      baseUrl: 'https://cdn.example.test/cards/',
    });
  });

  it('uses Twitter, then plain description, and falls back to the title element', () => {
    const result = parseLinkHead(`<head>
      <meta name="twitter:title" content="Twitter title">
      <meta name="twitter:description" content="Twitter description">
      <meta name="description" content="Plain description">
      <title>HTML title</title>
      </head>`, { finalUrl: 'https://www.example.test/' });
    expect(result.title).toBe('Twitter title');
    expect(result.description).toBe('Twitter description');
    expect(result.siteName).toBe('example.test');

    const plain = parseLinkHead('<head><title>HTML title</title><meta name="description" content="Plain description"></head>', {
      finalUrl: 'https://example.test/',
    });
    expect(plain).toMatchObject({ title: 'HTML title', description: 'Plain description' });
  });

  it('decodes common named and numeric references', () => {
    expect(decodeHtmlEntities('&amp; &copy; &eacute; &#169; &#x1f680;')).toBe('& © é © 🚀');
    expect(decodeHtmlEntities('&#0;&#x110000;&#xD800;')).toBe('\ufffd\ufffd\ufffd');
  });

  it('uses the HTTP charset header before meta charset and detects meta charset when absent', () => {
    const windows1252 = Buffer.from('<head><meta charset="windows-1252"><title>caf\xe9</title></head>', 'latin1');
    expect(parseLinkHead(windows1252, { finalUrl: 'https://example.test/' }).title).toBe('café');
    expect(parseLinkHead(windows1252, { finalUrl: 'https://example.test/', charset: 'iso-8859-1' }).title).toBe('café');

    const unknown = Buffer.from('<head><title>bad \xff</title></head>', 'latin1');
    expect(parseLinkHead(unknown, { finalUrl: 'https://example.test/', charset: 'not-a-real-charset' }).title).toContain('\ufffd');
  });

  it('cleans hostile title text, bidi and zero-width characters and caps long fields', () => {
    const title = `  safe <script>alert(1)</script>\u202e name\u200b  `;
    const huge = 'x'.repeat(50_000);
    const result = parseLinkHead(`<head><title>${title}</title><meta name="description" content="${huge}"><meta property="og:site_name" content="${huge}"></head>`, {
      finalUrl: 'https://example.test/',
    });
    expect(result.title).toBe('safe alert(1) name');
    expect(result.description).toHaveLength(1000);
    expect(result.siteName).toHaveLength(100);
    expect(result.title).not.toContain('\u202e');
    expect(result.title).not.toContain('\u200b');

    const hugeTitle = parseLinkHead(`<head><title>${huge}</title></head>`, { finalUrl: 'https://example.test/' });
    expect(hugeTitle.title).toHaveLength(300);
  });

  it('removes Arabic letter mark and deprecated bidi controls from preview text', () => {
    const invisible = '\u061c\u206a\u206b\u206c\u206d\u206e\u206f';
    const result = parseLinkHead(`<head><meta property="og:title" content="A${invisible}B"></head>`);
    expect(result.title).toBe('AB');
  });

  it('keeps raw-text, comments and CDATA contents from masquerading as head tags', () => {
    const result = parseLinkHead(`<head>
      <!-- <meta property="og:title" content="comment"> </head> -->
      <![CDATA[</head><meta property="og:title" content="cdata">]]>
      <script>const fake = "</head><meta property='og:title' content='script'>";</script>
      <title>Real <b>title</b></title>
      <meta name="description" content="kept">
      </head><body><meta property="og:title" content="body"></body>`, { finalUrl: 'https://example.test/' });
    expect(result).toMatchObject({ title: 'Real title', description: 'kept' });
  });

  it('scans pathological and dense heads within a linear work bound', () => {
    const pathologicalHtml = `<head><title>${'<'.repeat(1_000_000)}`;
    const workLimit = pathologicalHtml.length * 8;
    const originalCharCodeAt = String.prototype.charCodeAt;
    let charCodeReads = 0;
    let pathological;
    try {
      String.prototype.charCodeAt = function (this: string, index: number) {
        charCodeReads++;
        if (charCodeReads > workLimit) throw new Error('link parser exceeded its linear character-code work bound');
        return originalCharCodeAt.call(this, index);
      };
      pathological = parseLinkHead(pathologicalHtml, { finalUrl: 'https://example.test/' });
    } finally {
      // parseLinkHead is synchronous, so restore the scoped instrumentation before making assertions.
      String.prototype.charCodeAt = originalCharCodeAt;
    }
    const denseMeta = '<meta name="description" content="dense">'.repeat(10_000);
    const hugeAttribute = `<meta property="og:title" content="${'<'.repeat(256_000)}">`;
    const dense = parseLinkHead(`<head>${denseMeta}${hugeAttribute}<title>Done</title></head>`, { finalUrl: 'https://example.test/' });
    expect(charCodeReads).toBeGreaterThan(0);
    expect(charCodeReads).toBeLessThanOrEqual(workLimit);
    expect(pathological.title).toHaveLength(300);
    expect(dense.description).toBe('dense');
    expect(dense.title).toHaveLength(300);
  });

  it('refuses javascript and data image/icon addresses and falls back to favicon.ico', () => {
    const result = parseLinkHead(`<head>
      <meta property="og:image" content="javascript:alert(1)">
      <meta property="og:image:secure_url" content="https://safe.example.test/image.png">
      <link rel="icon" href="data:image/svg+xml,%3Csvg%3E" type="image/svg+xml">
      <link rel="icon" href="javascript:alert(1)">
      </head>`, { finalUrl: 'https://example.test/page' });
    expect(result.imageUrl).toBe('https://safe.example.test/image.png');
    expect(result.iconUrl).toBe('https://example.test/favicon.ico');
  });

  it('resolves relative image and icon references and ignores missing fields', () => {
    const result = parseLinkHead(`<head><meta name="twitter:image" content="../share.webp"><link rel="shortcut icon" href="icons/site.png"></head>`, {
      finalUrl: 'https://example.test/blog/post',
    });
    expect(result).toMatchObject({
      title: null,
      description: null,
      siteName: 'example.test',
      imageUrl: 'https://example.test/share.webp',
      iconUrl: 'https://example.test/blog/icons/site.png',
    });
  });

  it('supports a document without an explicit head but never reads metadata from the body', () => {
    const result = parseLinkHead('<title>Loose title</title><body><meta property="og:title" content="wrong"></body>', {
      finalUrl: 'https://example.test/',
    });
    expect(result.title).toBe('Loose title');
  });
});
