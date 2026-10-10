import './tracker.css';
import { chipModel, splitTicketKeys, type TicketLookup } from '../../tracker-chips';
import { h } from '../../ui/dom';
import { stateGlyph } from './glyphs';
import { keyChip } from './primitives';

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'break' }
  | { type: 'ticket'; key: string; raw: string }
  | { type: 'link'; label: string; url: string };

export type Block =
  | { type: 'paragraph'; content: MarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: MarkdownInline[][] };

type TicketInlineSegment = Extract<MarkdownInline, { type: 'text' | 'ticket' }>;

const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|(\*\*|__)(.+?)\3|(\*|_)(.+?)\5|(`+)(.+?)\7/g;

function ticketSegments(text: string): TicketInlineSegment[] {
  const prefixes = [...text.matchAll(/\b([a-z]{2,5})-[1-9]\d*\b/gi)].map((match) => match[1]);
  return splitTicketKeys(text, { prefixes }).map((segment) => segment.type === 'key'
    ? { type: 'ticket', key: segment.key, raw: segment.raw }
    : { type: 'text', text: segment.text });
}

function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let cursor = 0;
  INLINE.lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) out.push(...ticketSegments(text.slice(cursor, start)));
    if (match[1] !== undefined) {
      out.push({ type: 'link', label: match[1], url: match[2] });
    } else if (match[3] !== undefined) {
      out.push({ type: 'bold', text: match[4] });
    } else if (match[5] !== undefined) {
      out.push({ type: 'italic', text: match[6] });
    } else {
      out.push({ type: 'code', text: match[8] });
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) out.push(...ticketSegments(text.slice(cursor)));
  return out;
}

function listLine(line: string): { ordered: boolean; text: string } | null {
  const match = /^\s*(?:([-+*])|(\d+[.)]))\s+(.+)$/.exec(line);
  return match ? { ordered: match[2] !== undefined, text: match[3] } : null;
}

/** Parses the deliberately small Markdown subset used by tracker descriptions and comments. */
export function renderMarkdownSafe(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { type: 'list'; ordered: boolean; items: MarkdownInline[][] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) {
      const content: MarkdownInline[] = [];
      paragraph.forEach((line, index) => {
        if (index) content.push({ type: 'break' });
        content.push(...parseInline(line));
      });
      blocks.push({ type: 'paragraph', content });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of lines) {
    const item = listLine(line);
    if (item) {
      flushParagraph();
      if (list && list.ordered !== item.ordered) flushList();
      list ??= { type: 'list', ordered: item.ordered, items: [] };
      list.items.push(parseInline(item.text));
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export interface MarkdownDomOptions {
  lookup?: TicketLookup;
  onNavigate?: (key: string) => void;
  className?: string;
}

function appendPlain(parent: HTMLElement, text: string, options: MarkdownDomOptions): void {
  for (const segment of ticketSegments(text)) {
    if (segment.type !== 'ticket') {
      parent.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const model = chipModel(segment.key, options.lookup ?? (() => null));
    if (!model.resolved) {
      parent.appendChild(document.createTextNode(segment.raw));
      continue;
    }
    const link = h('a', { class: 'tk-ticket-chip', href: `/t/${model.key}`, 'aria-label': `${model.key}, ${model.state?.name ?? 'ticket'}: ${model.title}` });
    link.append(keyChip(model.key));
    if (model.state) link.append(stateGlyph(model.state.category), h('span', { class: 'tk-chip-title' }, model.title));
    link.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      options.onNavigate?.(model.key);
    });
    parent.appendChild(link);
  }
}

function appendInline(parent: HTMLElement, inline: MarkdownInline, options: MarkdownDomOptions): void {
  if (inline.type === 'break') {
    parent.appendChild(h('br'));
  } else if (inline.type === 'text') {
    appendPlain(parent, inline.text, options);
  } else if (inline.type === 'bold' || inline.type === 'italic' || inline.type === 'code') {
    const tag = inline.type === 'bold' ? 'strong' : inline.type === 'italic' ? 'em' : 'code';
    const el = h(tag);
    if (inline.type === 'code') el.textContent = inline.text;
    else appendPlain(el, inline.text, options);
    parent.appendChild(el);
  } else if (inline.type === 'ticket') {
    appendPlain(parent, inline.raw, options);
  } else {
    appendPlain(parent, inline.label, options);
    parent.appendChild(document.createTextNode(` (${inline.url})`));
  }
}

/** Builds safe DOM nodes from the parsed model. No HTML string is ever interpreted. */
export function buildMarkdownDom(blocks: readonly Block[], options: MarkdownDomOptions = {}): HTMLElement {
  const root = h('div', { class: `tk-markdown${options.className ? ` ${options.className}` : ''}` });
  for (const block of blocks) {
    if (block.type === 'paragraph') {
      const paragraph = h('p');
      block.content.forEach((inline) => appendInline(paragraph, inline, options));
      root.appendChild(paragraph);
      continue;
    }
    const list = h(block.ordered ? 'ol' : 'ul');
    for (const item of block.items) {
      const row = h('li');
      item.forEach((inline) => appendInline(row, inline, options));
      list.appendChild(row);
    }
    root.appendChild(list);
  }
  return root;
}
