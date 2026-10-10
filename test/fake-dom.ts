import { vi, type Mock } from 'vitest';

// A small stand-in for the browser's DOM, for the tests of screens built with `h()` (src/ui/dom.ts). No jsdom is installed and
// the repository adds no dependency for tests, so this covers what those screens use: elements, text, attributes, classes,
// dataset, events that bubble, focus, a selector engine for classes, ids, attributes and descendants, and `isConnected`.

type Listener = (event: FakeEvent) => void;

/** Inline style: plain properties, plus the custom-property calls the real CSSStyleDeclaration has. */
class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string): void { this[name] = value; }
  getPropertyValue(name: string): string { return String(this[name] ?? ''); }
  removeProperty(name: string): void { delete this[name]; }
}

export class FakeEvent {
  defaultPrevented = false;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  constructor(public type: string, public bubbles = true) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
  propagationStopped = false;
  stopPropagation() {
    this.bubbles = false;
    this.propagationStopped = true;
  }
}

export class FakeNode {
  parentNode: FakeElement | null = null;
  nodeType = 0;
  get isConnected(): boolean {
    const root = currentDocument?.documentElement;
    if ((this as FakeNode) === root) return true;
    for (let at = this.parentNode; at; at = at.parentNode) if (at === root) return true;
    return false;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get nextSibling(): FakeNode | null {
    const list = this.parentNode?.childNodes;
    return list ? (list[list.indexOf(this) + 1] ?? null) : null;
  }
  replaceWith(...nodes: FakeNode[]) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(n, this);
    parent.removeChild(this);
  }
  get textContent(): string {
    return '';
  }
}

export class FakeText extends FakeNode {
  nodeType = 3;
  constructor(public data: string) {
    super();
  }
  override get textContent() {
    return this.data;
  }
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

type Compound = { tag?: string; id?: string; classes: string[]; attrs: [string, string | null][] };

function parseCompound(text: string): Compound {
  const compound: Compound = { classes: [], attrs: [] };
  const re = /([#.]?)([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[3] !== undefined) compound.attrs.push([m[3], m[4] ?? m[5] ?? m[6] ?? null]);
    else if (m[1] === '#') compound.id = m[2];
    else if (m[1] === '.') compound.classes.push(m[2]);
    else compound.tag = m[2].toLowerCase();
  }
  return compound;
}

function matchesCompound(el: FakeElement, c: Compound): boolean {
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (!c.classes.every((name) => el.classList.contains(name))) return false;
  return c.attrs.every(([name, value]) => (value === null ? el.hasAttribute(name) : el.getAttribute(name) === value));
}

/** Selectors of descendants ("a b"), children ("a > b") and lists ("a, b") over tags, ids, classes and attributes. */
function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const walk = (node: FakeElement | null, at: number): boolean => {
      if (!node) return false;
      const token = tokens[at];
      if (token === '>') return false;
      if (!matchesCompound(node, parseCompound(token))) return false;
      if (at === 0) return true;
      const combinator = tokens[at - 1] === '>' ? '>' : ' ';
      const before = combinator === '>' ? at - 2 : at - 1;
      if (combinator === '>') return walk(node.parentNode, before);
      for (let up = node.parentNode; up; up = up.parentNode) if (walk(up, before)) return true;
      return false;
    };
    return walk(el, tokens.length - 1);
  });
}

export class FakeElement extends FakeNode {
  readOnly = false;
  nodeType = 1;
  childNodes: FakeNode[] = [];
  style = new FakeStyle() as unknown as Record<string, string> & FakeStyle;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Listener[]>();
  private inputValue: string | null = null;
  private inputChecked = false;
  html = '';
  inert = false;

  constructor(public tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v: string) {
    this.attrs.set('class', v);
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]) => this.attrs.set('class', list.join(' '));
    return {
      add: (...add: string[]) => write([...new Set([...names(), ...add])]),
      remove: (...gone: string[]) => write(names().filter((n) => !gone.includes(n))),
      contains: (name: string) => names().includes(name),
      toggle: (name: string, force?: boolean) => {
        const has = names().includes(name);
        const on = force ?? !has;
        write(on ? [...new Set([...names(), name])] : names().filter((n) => n !== name));
        return on;
      },
    };
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v: string) {
    this.attrs.set('id', v);
  }
  get dataset(): Record<string, string | undefined> {
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_t, prop) => (typeof prop === 'string' ? this.attrs.get(`data-${kebab(prop)}`) : undefined),
      set: (_t, prop, value) => {
        if (typeof prop === 'string') this.attrs.set(`data-${kebab(prop)}`, String(value));
        return true;
      },
    });
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  get attributeNames() {
    return [...this.attrs.keys()];
  }
  get disabled() {
    return this.attrs.has('disabled');
  }
  set disabled(v: boolean) {
    if (v) this.attrs.set('disabled', '');
    else this.attrs.delete('disabled');
  }
  get hidden() {
    return this.attrs.has('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  get checked() {
    return this.inputChecked;
  }
  set checked(v: boolean) {
    this.inputChecked = v;
  }
  get value() {
    return this.inputValue ?? this.attrs.get('value') ?? '';
  }
  set value(v: string) {
    this.inputValue = String(v);
  }
  get type() {
    return this.attrs.get('type') ?? '';
  }
  get href() {
    return this.attrs.get('href') ?? '';
  }
  set href(v: string) {
    this.attrs.set('href', String(v));
  }
  set innerHTML(v: string) {
    this.html = v;
    this.replaceChildren();
  }
  get innerHTML() {
    return this.html;
  }
  override get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v: string) {
    this.replaceChildren(String(v));
  }

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  /** Puts `node` before `ref` (at the end when `ref` is null), moving it if it is somewhere else. */
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    node.parentNode?.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    node.parentNode = this;
    if (at >= 0) this.childNodes.splice(at, 0, node);
    else this.childNodes.push(node);
    return node;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }
  prepend(...nodes: (FakeNode | string)[]) {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(typeof n === 'string' ? new FakeText(n) : n, first);
  }
  before(...nodes: (FakeNode | string)[]) {
    const parent = this.parentNode;
    if (!parent) return;
    for (const n of nodes) parent.insertBefore(typeof n === 'string' ? new FakeText(n) : n, this);
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    for (const old of this.childNodes) old.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  removeChild<T extends FakeNode>(node: T): T {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  contains(node: FakeNode | null): boolean {
    if (node === this) return true;
    for (let at = node?.parentNode ?? null; at; at = at.parentNode) if (at === this) return true;
    return false;
  }

  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this;
    const chain: FakeElement[] = [this];
    for (let at = this.parentNode; at && event.bubbles; at = at.parentNode) chain.push(at);
    for (const at of chain) {
      event.currentTarget = at;
      for (const fn of at.listeners.get(event.type) ?? []) fn(event);
      if (event.propagationStopped) break;
    }
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click'));
  }
  focus() {
    if (this.disabled || !currentDocument) return;
    currentDocument.activeElement = this;
  }
  blur() {
    if (currentDocument?.activeElement === this) currentDocument.activeElement = currentDocument.body;
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (matchesSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out as T[];
  }
  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null;
  }
  /** The nearest of itself and its ancestors that matches. */
  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    if (matchesSelector(this, selector)) return this as unknown as T;
    for (let n = this.parentNode; n; n = n.parentNode) if (matchesSelector(n, selector)) return n as T;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  /** A canvas with no 2D context: text is measured by the fallback estimate (src/text.ts). */
  getContext() {
    return null;
  }
}

export class FakeDocument {
  documentElement = new FakeElement('html');
  body = new FakeElement('body');
  activeElement: FakeElement;
  title = '';
  visibilityState = 'visible';
  constructor() {
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createElementNS(_namespace: string, tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  createDocumentFragment(): DocumentFragment {
    return new FakeElement('fragment') as unknown as DocumentFragment;
  }
  getElementById(id: string) {
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector<T extends FakeElement = FakeElement>(selector: string) {
    return this.documentElement.querySelector<T>(selector);
  }
  querySelectorAll<T extends FakeElement = FakeElement>(selector: string) {
    return this.documentElement.querySelectorAll<T>(selector);
  }
  addEventListener() {}
  removeEventListener() {}
}

let currentDocument: FakeDocument | null = null;

export interface FakeBrowser {
  document: FakeDocument;
  location: { hash: string; pathname: string; assign: Mock<(url: string) => void>; replace: Mock<(url: string) => void>; reload: Mock<() => void> };
  session: Map<string, string>;
  /** A mount point already in the document, like the app's #app. */
  mount: () => FakeElement;
  uninstall: () => void;
}

/** Puts a fake document, window, location and sessionStorage in place of the browser's. Call `uninstall` afterwards. */
export function installFakeBrowser(): FakeBrowser {
  const document = new FakeDocument();
  currentDocument = document;
  const session = new Map<string, string>();
  const location = { hash: '#/admin/backups', pathname: '/', assign: vi.fn<(url: string) => void>(), replace: vi.fn<(url: string) => void>(), reload: vi.fn<() => void>() };
  const window = {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (handle: number) => clearTimeout(handle),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    innerHeight: 800,
    innerWidth: 1024,
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('window', window);
  vi.stubGlobal('location', location);
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, String(v)),
    removeItem: (k: string) => void session.delete(k),
  });
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  return {
    document,
    location,
    session,
    mount: () => {
      const el = document.createElement('div');
      el.id = 'app';
      document.body.appendChild(el);
      return el;
    },
    uninstall: () => {
      currentDocument = null;
      vi.unstubAllGlobals();
    },
  };
}

// ------------------------------------------------------------------ helpers for assertions

const BLOCKS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'SECTION', 'HEADER', 'NAV', 'MAIN', 'BUTTON']);

/** What a reader sees: the text, with a break where a block starts, so neighbouring blocks do not run together. */
function flat(node: FakeNode): string {
  if (!(node instanceof FakeElement)) return node.textContent;
  const inside = node.childNodes.map(flat).join('');
  return BLOCKS.has(node.tagName) ? ` ${inside} ` : inside;
}

export const textOf = (node: FakeNode | null | undefined) => (node ? flat(node).replace(/\s+/g, ' ').trim() : '');

/** The element matching `selector`, or a thrown error that says what was missing. */
export function need<T extends FakeElement = FakeElement>(root: FakeElement, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector} in: ${textOf(root).slice(0, 300)}`);
  return found;
}

/** The first button or link whose text is exactly `label` (or whose aria-label starts with it). */
export function control(root: FakeElement, label: string | RegExp): FakeElement {
  const hit = root.querySelectorAll('button, a').find((el) => {
    const name = el.getAttribute('aria-label') ?? textOf(el);
    return typeof label === 'string' ? textOf(el) === label || name === label : label.test(name) || label.test(textOf(el));
  });
  if (!hit) throw new Error(`no control named ${String(label)} in: ${textOf(root).slice(0, 300)}`);
  return hit;
}

export const hasControl = (root: FakeElement, label: string | RegExp): boolean => {
  try {
    control(root, label);
    return true;
  } catch {
    return false;
  }
};

/** Types into a field the way a person does: sets the value and sends `input`. */
export function type(field: FakeElement, value: string) {
  field.value = value;
  field.dispatchEvent(new FakeEvent('input'));
}

export function choose(radio: FakeElement) {
  radio.checked = true;
  radio.dispatchEvent(new FakeEvent('change'));
}

/** Lets pending promises (mocked fetches and what follows them) settle. */
export async function flush(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < times; i++) await Promise.resolve();
}
