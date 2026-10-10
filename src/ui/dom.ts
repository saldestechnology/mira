type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

/** Tiny hyperscript helper for building UI chrome. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && k !== 'list' && k !== 'type' && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function icon(name: keyof typeof ICONS, size = 20): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'ico';
  s.setAttribute('aria-hidden', 'true');
  const strokeWidth = name === 'group' || name === 'ungroup' ? 2 : 1.75;
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

export const ICONS = {
  select: '<path d="M5.5 5.35l13 6.2-5.6 1.7-2.6 5.4z"/><path d="M13.1 13.45l5 5"/>',
  hand: '<g transform="translate(1.6 0.75)"><path d="M8 11V5.5a1.5 1.5 0 013 0V10m0-.5V4a1.5 1.5 0 013 0v6m0-4.5a1.5 1.5 0 013 0V13a7 7 0 01-7 7h-.6a6 6 0 01-4.9-2.6L4 14.2a1.6 1.6 0 012.4-2L8 14"/></g>',
  sticky: '<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="var(--radius-xs)"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  diamond: '<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z"/>',
  connector: '<path d="M5 19L18 6"/><path d="M11 6h7v7"/>',
  pen: '<g transform="translate(0.15 -1.75)"><path d="M4 20c3-1 4-4 6-7s5-6 8-7c1-.4 2 .6 1.6 1.6-1 3-4 6-7 8s-6 3-7 6"/></g>',
  frame: '<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>',
  kanban: '<path d="M4 4h16v16H4zM9.5 4v16M14.5 4v16"/>',
  card: '<path d="M4 6h16v12H4zM8 10h8M8 14h5"/>',
  tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><path d="M8.5 8.5h.01"/>',
  calendar: '<path d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="var(--radius-xs)"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>',
  shapes: '<rect x="3.5" y="10" width="10" height="10" rx="var(--radius-xs)"/><circle cx="16" cy="8" r="5"/>',
  uml: '<rect x="4" y="3.5" width="16" height="17" rx="var(--radius-xs)"/><path d="M4 8.5h16M4 14h16M7 11.2h6M7 16.8h8"/>',
  icons: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14a4 4 0 007 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.5"/>',
  react: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2c.9 1.4 2 2.1 3.5 2.1s2.6-.7 3.5-2.1"/><path d="M9.4 9.6h.01M14.6 9.6h.01"/>',
  stickers: '<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 17l-5.3 2.6 1-5.8-4.2-4.1 5.9-.9z"/>',
  templates: '<rect x="3.5" y="4" width="17" height="16" rx="var(--radius-xs)"/><path d="M3.5 9h17M9.5 9v11"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 108.5-8.5c-2.5 0-4.8 1.1-6.4 2.9L3.5 8.5"/><path d="M3.5 4v4.5H8"/><path d="M12 7.5V12l3 1.8"/>',
  undo: '<path d="M8 8H4V4"/><path d="M4.5 8.2A8 8 0 1112 20"/>',
  redo: '<path d="M16 8h4V4"/><path d="M19.5 8.2A8 8 0 1012 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  grid: '<path d="M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  share: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  prev: '<path d="M15 5l-7 7 7 7"/>',
  timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>',
  vote: '<circle cx="8" cy="12" r="3"/><circle cx="16" cy="8" r="3"/><circle cx="16" cy="16" r="3"/>',
  poll: '<path d="M4 20h16M7.5 16v-5M12 16V7M16.5 16v-7"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  layers: '<path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z"/><path d="M3.5 12l8.5 4.5 8.5-4.5"/><path d="M3.5 16l8.5 4.5 8.5-4.5"/>',
  group: '<path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><rect x="8" y="8" width="8" height="8" rx="var(--radius-xs)"/>',
  ungroup: '<rect x="3" y="3" width="7" height="7" rx="var(--radius-xs)"/><rect x="14" y="14" width="7" height="7" rx="var(--radius-xs)"/><path d="M14 6h4a2 2 0 012 2v2M10 18H6a2 2 0 01-2-2v-2" stroke-dasharray="2 3"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="var(--radius-xs)"/><path d="M15.5 8.5V5a1 1 0 00-1-1H5a1 1 0 00-1 1v9.5a1 1 0 001 1h3.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="var(--radius-xs)"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="var(--radius-xs)"/><path d="M8 10.5V7.5a4 4 0 017.7-1.5"/>',
  forward: '<rect x="4" y="9" width="10" height="10" rx="var(--radius-xs)"/><rect x="10" y="4" width="10" height="10" rx="var(--radius-xs)" fill="currentColor" fill-opacity=".18"/>',
  backward: '<rect x="10" y="9" width="10" height="10" rx="var(--radius-xs)"/><rect x="4" y="4" width="10" height="10" rx="var(--radius-xs)" fill="currentColor" fill-opacity=".18"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="var(--radius-xs)" fill="currentColor" fill-opacity=".18"/><path d="M4 15V5a1 1 0 011-1h10"/>',
  back: '<rect x="4" y="4" width="12" height="12" rx="var(--radius-xs)" fill="currentColor" fill-opacity=".18"/><path d="M20 9v10a1 1 0 01-1 1H9"/>',
  alignLeft: '<path d="M4 3v18M8 7h10M8 12h6M8 17h11"/>',
  alignCenterH: '<path d="M12 3v18M6 7h12M8.5 12h7M5.5 17h13"/>',
  alignRight: '<path d="M20 3v18M6 7h10M10 12h6M5 17h11"/>',
  alignTop: '<path d="M3 4h18M7 8v10M12 8v6M17 8v11"/>',
  alignMiddleV: '<path d="M3 12h18M7 6v12M12 8.5v7M17 5.5v13"/>',
  alignBottom: '<path d="M3 20h18M7 6v10M12 10v6M17 5v11"/>',
  flipHorizontal: '<path d="M12 4v16M9 7l-4 5 4 5M15 7l4 5-4 5"/>',
  flipVertical: '<path d="M4 12h16M7 9l5-4 5 4M7 15l5 4 5-4"/>',
  properties: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="1.6" fill="currentColor"/><circle cx="15" cy="12" r="1.6" fill="currentColor"/><circle cx="8" cy="18" r="1.6" fill="currentColor"/>',
  distributeH: '<path d="M4 4v16M20 4v16M10 8h4v8h-4z"/>',
  distributeV: '<path d="M4 4h16M4 20h16M8 10h8v4H8z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M7 10l5 5 5-5"/>',
  home: '<path d="M4 11l8-6.5 8 6.5V20h-5.5v-5.5h-5V20H4z"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>',
  font: '<path d="M4 19l5-14h1l5 14M6 14h8"/><path d="M16.5 19v-5.5a2.5 2.5 0 015 0V19M16.5 16h5"/>',
  wifi: '<path d="M2.5 9a14 14 0 0119 0M5.5 12.5a9.5 9.5 0 0113 0M8.6 15.8a5 5 0 016.8 0"/><circle cx="12" cy="19" r=".9" fill="currentColor"/>',
  cloudOff: '<path d="M3 3l18 18M8.5 6.6A6 6 0 0117.7 10h.3a4 4 0 012.6 7M17 18H7a4.5 4.5 0 01-1.6-8.7"/>',
  dup: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="var(--radius-xs)"/><path d="M14.2 11.5v5.5M11.5 14.2H17"/><path d="M15.5 8.5V5a1 1 0 00-1-1H5a1 1 0 00-1 1v9.5a1 1 0 001 1h3.5"/>',
  mermaid: '<path d="M4 5h6v4H4zM14 15h6v4h-6zM7 9v3h10v3"/>',
  user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  // the list sheet's drag handle (docs/kanban.md, Visual design)
  grip: '<rect x="8" y="5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="13" y="5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="8" y="10.5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="13" y="10.5" width="3" height="3" fill="currentColor" stroke="none"/><rect x="8" y="16" width="3" height="3" fill="currentColor" stroke="none"/><rect x="13" y="16" width="3" height="3" fill="currentColor" stroke="none"/>',
  dots: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  map: '<path d="M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5L15 20l-6-2.5-5.5 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
  chat: '<path d="M4 5h16v11H10l-6 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  comment: '<g transform="translate(0 -.25)"><path d="M5.5 5h13A1.5 1.5 0 0120 6.5v8a1.5 1.5 0 01-1.5 1.5H10.5L6.5 19.5V16h-1A1.5 1.5 0 014 14.5v-8A1.5 1.5 0 015.5 5z"/></g>',
} as const;
