import './tracker.css';
import { dialog, toast } from '../../ui/common';
import { h } from '../../ui/dom';
import { TrackerError, type TrackerMeta, type TrackerPriority } from '../../tracker-types';
import type { TrackerStore } from '../../tracker-data';
import { openPicker } from './picker';
import { trackerErrorField } from './error-path';

export interface MarkdownInlineToken { type: 'text' | 'link' | 'code' | 'strong' | 'em'; text: string; href?: string }

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, 'https://tracker.invalid');
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? raw : null;
  } catch { return null; }
}

/** Tokenizes a deliberately small Markdown inline subset without interpreting HTML. */
export function markdownInlineTokens(input: string): MarkdownInlineToken[] {
  const text = input.slice(0, 20_000);
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g;
  const tokens: MarkdownInlineToken[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) tokens.push({ type: 'text', text: text.slice(offset, index) });
    if (match[1] !== undefined) {
      const href = safeHref(match[2]);
      tokens.push(href ? { type: 'link', text: match[1], href } : { type: 'text', text: match[0] });
    } else if (match[3] !== undefined) tokens.push({ type: 'strong', text: match[3] });
    else if (match[4] !== undefined) tokens.push({ type: 'code', text: match[4] });
    else tokens.push({ type: 'em', text: match[5] ?? '' });
    offset = index + match[0].length;
  }
  if (offset < text.length) tokens.push({ type: 'text', text: text.slice(offset) });
  return tokens;
}

function inlineNodes(text: string): Node[] {
  return markdownInlineTokens(text).map((token) => {
    if (token.type === 'link') {
      const link = h('a', { href: token.href, rel: 'noopener noreferrer', target: '_blank' }, token.text);
      return link;
    }
    if (token.type === 'strong') return h('strong', null, token.text);
    if (token.type === 'em') return h('em', null, token.text);
    if (token.type === 'code') return h('code', null, token.text);
    return document.createTextNode(token.text);
  });
}

/** DOM-only renderer: raw HTML, script tags, and unsafe link protocols stay inert text. */
export function renderSafeMarkdown(markdown: string): HTMLElement {
  const root = h('div', { class: 'trk-markdown-preview' });
  const lines = markdown.slice(0, 20_000).split(/\r?\n/u);
  let list: HTMLUListElement | null = null;
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!list) { list = h('ul'); root.appendChild(list); }
      list.appendChild(h('li', null, inlineNodes(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (heading) root.appendChild(h(`h${heading[1].length}` as 'h1' | 'h2' | 'h3', null, inlineNodes(heading[2])));
    else root.appendChild(h('p', null, inlineNodes(line)));
  }
  return root;
}

interface Draft {
  issueTitle: string;
  description: string;
  state: string;
  assignee: string | null;
  priority: TrackerPriority;
  labels: string[];
  due: string | null;
}

const drafts = new Map<string, Draft>();
const PRIORITIES: TrackerPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export interface NewIssueDialogOptions {
  store: TrackerStore;
  meta: TrackerMeta;
  viewerId: string;
  trackerId: string;
  defaultState?: string;
  offline?: boolean;
  onCreated?: (key: string) => void;
}

export function openNewIssueDialog(options: NewIssueDialogOptions): { close: () => void; box: HTMLElement } {
  const draftKey = `${options.trackerId}:${options.viewerId}`;
  const states = [...options.meta.states].sort((a, b) => a.position - b.position);
  const stateKey = (reference: string | undefined): string =>
    states.find((state) => state.id === reference || state.key === reference || state.name === reference)?.key ?? reference ?? '';
  const defaultState = stateKey(options.defaultState) || states.find((state) => state.key === 'todo')?.key || states[0]?.key || '';
  const draft = drafts.get(draftKey) ?? {
    issueTitle: '', description: '', state: defaultState, assignee: null, priority: 'none' as TrackerPriority, labels: [], due: null,
  };
  draft.state = stateKey(draft.state) || defaultState;
  draft.assignee = options.meta.members.find((member) => member.userId === draft.assignee || member.name === draft.assignee)?.name ?? draft.assignee;
  draft.labels = draft.labels.map((reference) => options.meta.labels.find((label) => label.id === reference || label.name.toLocaleLowerCase() === reference.toLocaleLowerCase())?.name ?? reference);
  drafts.set(draftKey, draft);

  const title = h('input', { class: 'trk-new-title', type: 'text', maxlength: '200', placeholder: 'Issue title', 'aria-label': 'Issue title', value: draft.issueTitle });
  const description = h('textarea', { class: 'trk-new-description', rows: '7', placeholder: 'Description (Markdown)', 'aria-label': 'Description', value: draft.description });
  const preview = h('div', { class: 'trk-new-preview', hidden: true, 'aria-label': 'Description preview' });
  let previewOn = false;
  const previewButton = h('button', { class: 'trk-small-button', type: 'button', 'aria-pressed': 'false' }, 'Preview');
  const propertyBar = h('div', { class: 'trk-new-properties', role: 'group', 'aria-label': 'Issue properties' });
  const stateButton = h('button', { class: 'trk-small-button', type: 'button' });
  const assigneeButton = h('button', { class: 'trk-small-button', type: 'button' });
  const priorityButton = h('button', { class: 'trk-small-button', type: 'button' });
  const labelsButton = h('button', { class: 'trk-small-button', type: 'button' });
  const dueButton = h('button', { class: 'trk-small-button', type: 'button' });
  const refreshProperties = () => {
    stateButton.textContent = states.find((state) => state.key === draft.state)?.name ?? 'To do';
    assigneeButton.textContent = options.meta.members.find((member) => member.userId === draft.assignee || member.name === draft.assignee)?.name ?? 'No one';
    priorityButton.textContent = draft.priority === 'none' ? 'No priority' : `${draft.priority[0].toUpperCase()}${draft.priority.slice(1)}`;
    labelsButton.textContent = draft.labels.length ? `${draft.labels.length} label${draft.labels.length === 1 ? '' : 's'}` : 'Labels';
    dueButton.textContent = draft.due ?? 'Due date';
  };
  propertyBar.append(stateButton, assigneeButton, priorityButton, labelsButton, dueButton);
  refreshProperties();

  stateButton.addEventListener('click', async () => {
    const value = await openPicker(stateButton, { label: 'State', options: states.map((state) => ({ value: state.key, label: state.name })), value: draft.state });
    if (typeof value === 'string') { draft.state = value; refreshProperties(); }
  });
  assigneeButton.addEventListener('click', async () => {
    const value = await openPicker(assigneeButton, { label: 'Assignee', options: options.meta.members.map((member) => ({ value: member.name, label: member.name })), value: draft.assignee });
    if (value === null || typeof value === 'string') { draft.assignee = value; refreshProperties(); }
  });
  priorityButton.addEventListener('click', async () => {
    const value = await openPicker(priorityButton, { label: 'Priority', options: PRIORITIES.map((priority) => ({ value: priority, label: priority === 'none' ? 'No priority' : `${priority[0].toUpperCase()}${priority.slice(1)}` })), value: draft.priority });
    if (typeof value === 'string' && PRIORITIES.includes(value as TrackerPriority)) { draft.priority = value as TrackerPriority; refreshProperties(); }
  });
  labelsButton.addEventListener('click', async () => {
    const value = await openPicker<string>(labelsButton, {
      label: 'Labels', multi: true, selected: draft.labels,
      options: options.meta.labels.map((label) => ({ value: label.name, label: label.name })),
    });
    if (Array.isArray(value)) { draft.labels = value.filter((item): item is string => typeof item === 'string'); refreshProperties(); }
  });
  dueButton.addEventListener('click', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const value = await openPicker<string>(dueButton, {
      label: 'Due date', value: draft.due,
      options: [{ value: today, label: `Today · ${today}` }, { value: tomorrow, label: `Tomorrow · ${tomorrow}` }],
    });
    if (value === null || typeof value === 'string') { draft.due = value; refreshProperties(); }
  });

  previewButton.addEventListener('click', () => {
    previewOn = !previewOn;
    description.hidden = previewOn;
    preview.hidden = !previewOn;
    previewButton.setAttribute('aria-pressed', String(previewOn));
    previewButton.textContent = previewOn ? 'Edit' : 'Preview';
    if (previewOn) preview.replaceChildren(renderSafeMarkdown(description.value));
    else description.focus({ preventScroll: true });
  });
  description.addEventListener('input', () => { draft.description = description.value; if (previewOn) preview.replaceChildren(renderSafeMarkdown(description.value)); });
  title.addEventListener('input', () => { draft.issueTitle = title.value; });

  const createReason = h('span', { class: 'trk-create-reason', hidden: !options.offline }, 'Needs a connection to get a ticket number.');
  const createButton = h('button', {
    class: 'trk-primary-button', type: 'button', disabled: options.offline || !options.meta.me.canWrite,
    'aria-description': options.offline ? 'Needs a connection to get a ticket number.' : undefined,
  }, 'Create issue');
  const anotherButton = h('button', {
    class: 'trk-small-button', type: 'button', disabled: options.offline || !options.meta.me.canWrite,
    'aria-description': options.offline ? 'Needs a connection to get a ticket number.' : undefined,
  }, 'Create and another');
  const error = h('p', { class: 'trk-inline-error', role: 'alert', hidden: true });
  let closeDialog = () => {};
  let discardDraftOnClose = false;
  let busy = false;
  const create = async (another: boolean) => {
    if (busy || options.offline || !options.meta.me.canWrite) return;
    const cleanTitle = title.value.trim();
    if (!cleanTitle) { title.focus(); title.setAttribute('aria-invalid', 'true'); return; }
    title.removeAttribute('aria-invalid');
    busy = true;
    createButton.disabled = anotherButton.disabled = true;
    error.hidden = true;
    for (const control of [title, description, stateButton, assigneeButton, priorityButton, labelsButton, dueButton]) control.removeAttribute('aria-invalid');
    try {
      const ticket = await options.store.createTicket({
        title: cleanTitle, description: description.value, state: draft.state || undefined, priority: draft.priority,
        assignee: draft.assignee, labels: [...draft.labels], due: draft.due,
      });
      options.onCreated?.(ticket.key);
      toast(`${ticket.key} created`);
      if (another) {
        Object.assign(draft, { issueTitle: '', description: '', assignee: null, priority: 'none', labels: [], due: null });
        title.value = '';
        description.value = '';
        refreshProperties();
        title.focus({ preventScroll: true });
        return;
      }
      discardDraftOnClose = true;
      closeDialog();
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : 'Could not create the issue.';
      error.hidden = false;
      const field = caught instanceof TrackerError ? trackerErrorField(caught.path) : null;
      const fieldControl: Record<string, HTMLElement> = {
        title, description, state: stateButton, assignee: assigneeButton, priority: priorityButton, labels: labelsButton, due: dueButton,
      };
      const invalidControl = field ? fieldControl[field] : undefined;
      invalidControl?.setAttribute('aria-invalid', 'true');
      invalidControl?.focus({ preventScroll: true });
    } finally {
      busy = false;
      createButton.disabled = anotherButton.disabled = !options.meta.me.canWrite;
    }
  };
  createButton.addEventListener('click', () => void create(false));
  anotherButton.addEventListener('click', () => void create(true));
  const body = h('div', { class: 'trk-new-issue' },
    title,
    h('div', { class: 'trk-new-description-head' }, h('span', null, 'Description'), previewButton),
    description, preview,
    propertyBar,
    createReason,
    error,
    h('div', { class: 'trk-new-actions' }, anotherButton, createButton),
  );
  body.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'p' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      previewButton.click();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void create(event.shiftKey);
    }
  });
  const modal = dialog('New issue', body, [], { className: 'trk trk-new-issue-back', onClose: () => { if (discardDraftOnClose) drafts.delete(draftKey); else drafts.set(draftKey, draft); } });
  closeDialog = modal.close;
  return modal;
}
