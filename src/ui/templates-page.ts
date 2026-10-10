import './home.css';
import { h, icon, type ICONS } from './dom';
import { dialog, field, popover, toast } from './common';
import { newId } from '../store';
import { getUser } from '../sync';
import { download, safeName } from '../exporters';
import { CATEGORIES, CUSTOM_CATEGORY, CUSTOM_PREFIX, TEMPLATES, type TemplateDef } from '../templates';
import { builtinThumbnail, thumbnailSvg } from '../template-thumb';
import { duplicateSavedTemplate, getTemplate, listTemplates, onTemplatesChange, putTemplate, removeTemplate, templatesShared } from '../template-store';
import { accountId, mayChange, scopeLabel, splitMine } from '../template-share';
import { NAME_MAX, builtinToCustom, duplicateTemplate, exportTemplateFile, parseTemplateFile } from '../template-file';
import type { CustomTemplate } from '../custom-templates';
import { storedWhere } from '../desktop-env';
import type { AuthState } from '../auth';
import type { HomeNav } from './home';
import { createWorkspaceBanner } from './workspace';
import { accountMe, createTopbar, pageFooter, searchField } from './topbar';

/** Opens a new board from a template; the cards on the home strip and on the templates page both start here. */
export function useTemplate(nav: HomeNav, id: string): void {
  nav.open(newId(), { template: id });
}

/** The id a saved template is opened by. */
export const customRef = (t: CustomTemplate) => `${CUSTOM_PREFIX}${t.id}`;

const thumbs = new Map<string, string>();

/** Thumbnail of a saved template. Memoised until the template is saved again. */
export function customThumbnail(t: CustomTemplate): string {
  const key = `${t.id}:${t.updatedAt}`;
  let svg = thumbs.get(key);
  if (svg === undefined) {
    svg = thumbnailSvg(t.content.objects, { labels: t.content.labels });
    thumbs.set(key, svg);
  }
  return svg;
}

/** One template from each of the first categories: the short list on the home page. */
export function featuredTemplates(count = 4): TemplateDef[] {
  return CATEGORIES.slice(0, count).flatMap((category) => TEMPLATES.find((t) => t.category === category) ?? []);
}

const matches = (t: { name: string; category: string; description: string }, query: string) =>
  !query || `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(query);

const countLabel = (n: number) => `${n} ${n === 1 ? 'template' : 'templates'}`;

const deleteNote = (t: CustomTemplate) => {
  if (!templatesShared()) return `“${t.name}” will be removed from this browser. Boards made from it are not affected.`;
  const who = t.scope === 'team' ? `everyone in ${t.teamName || 'the team'}` : t.scope === 'workspace' ? 'everyone in the workspace' : 'your account';
  return `“${t.name}” will be deleted for ${who}. Boards made from it are not affected.`;
};

function confirmDelete(t: CustomTemplate) {
  dialog('Delete this template?', h('p', null, deleteNote(t)), [
    { label: 'Cancel' },
    {
      label: 'Delete template', primary: true,
      onClick: async () => {
        try {
          await removeTemplate(t.id);
        } catch (e) {
          toast((e as Error).message);
          return false;
        }
      },
    },
  ]);
}

function openRename(t: CustomTemplate) {
  const name = h('input', { class: 'input', maxlength: NAME_MAX, value: t.name, 'aria-label': 'Name', spellcheck: 'false', autocomplete: 'off' });
  const error = h('div', { class: 'error', role: 'alert' });
  const dlg = dialog('Rename template', h('div', { class: 'stack' }, field('Name', name), error), [
    { label: 'Cancel' },
    {
      label: 'Rename', primary: true,
      onClick: async () => {
        const title = name.value.trim();
        if (!title) {
          error.textContent = 'Give the template a name.';
          name.focus();
          return false;
        }
        try {
          // Read it again, so a template edited in another tab keeps its new content.
          const latest = await getTemplate(t.id);
          if (!latest) throw new Error('That template is no longer available.');
          if (title === latest.name) return;
          await putTemplate({ ...latest, name: title, updatedAt: Date.now() });
        } catch (e) {
          error.textContent = (e as Error).message;
          return false;
        }
        toast(`Renamed to “${title}”.`);
      },
    },
  ]);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) dlg.box.querySelector<HTMLButtonElement>('.modal-actions .btn.primary')?.click();
  });
  requestAnimationFrame(() => name.select());
}

async function duplicate(t: CustomTemplate) {
  try {
    const copy = templatesShared() ? await duplicateSavedTemplate(t.id) : await putTemplate(duplicateTemplate(t, getUser().id));
    toast(`Duplicated as “${copy.name}”.`);
  } catch (e) {
    toast((e as Error).message);
  }
}

function exportFile(t: CustomTemplate) {
  download(exportTemplateFile(t), `${safeName(t.name)}.tabula-template.json`, 'application/json');
}

/** A personal copy of a built-in template, opened for editing. */
async function duplicateToEdit(def: TemplateDef) {
  try {
    const copy = await putTemplate(builtinToCustom(def, getUser().id));
    location.hash = `#/t/${copy.id}/edit`;
  } catch (e) {
    toast((e as Error).message);
  }
}

interface MenuItem {
  icon: keyof typeof ICONS;
  label: string;
  run: () => void;
}

/** The ⋯ button of a card, with a compact popover of actions. */
function moreButton(name: string, items: MenuItem[]): HTMLButtonElement {
  const more: HTMLButtonElement = h('button', {
    class: 'icon-btn', 'data-tip': 'More actions', 'aria-label': `More actions for ${name}`, 'aria-haspopup': 'menu',
    onclick: () => {
      const menu = h('div', { class: 'menu' }, ...items.map((item) => h('button', {
        class: 'menu-item', onclick: () => {
          pop.close();
          item.run();
        },
      }, icon(item.icon, 18), h('span', null, item.label))));
      const pop = popover(more, menu, { className: 'tpl-pop' });
    },
  }, icon('dots', 18));
  return more;
}

/** Reads a template file picked on the page and adds it to My templates. */
function templateFileInput(): HTMLInputElement {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Template file' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const t = await putTemplate(parseTemplateFile(await file.text(), getUser().id));
      toast(`Imported “${t.name}” into My templates.`);
    } catch (e) {
      toast(`Could not import ${file.name}: ${(e as Error).message}`, 6000);
    } finally {
      input.value = '';
    }
  });
  return input;
}

/** Every template with a category filter and a search box. */
export function renderTemplates(root: HTMLElement, nav: HomeNav, auth: AuthState = { mode: 'open' }): void {
  document.title = 'Templates - Tabula';
  const me = accountMe(auth);
  const down = auth.mode === 'offline';
  let category: string | null = null;
  let query = '';
  /** Null until the saved templates have been read. */
  let mine: CustomTemplate[] | null = null;
  /** Accounts mode: team and workspace templates somebody else owns. */
  let shared: CustomTemplate[] = [];
  let chipSet = '';
  const userId = accountId(auth);

  const grid = h('ul', { class: 'tpl-grid', 'aria-label': 'Built-in templates' });
  const mineGrid = h('ul', { class: 'tpl-grid', 'aria-label': 'My templates' });
  const mineEmpty = h('p', { class: 'home-empty' }, 'Templates you save from a board appear here.');
  const mineSection = h('section', { class: 'tpl-section', 'aria-label': 'My templates' },
    h('h2', { class: 'tpl-section-title' }, 'My templates'), mineGrid, mineEmpty);
  const sharedGrid = h('ul', { class: 'tpl-grid', 'aria-label': 'Shared with me' });
  const sharedSection = h('section', { class: 'tpl-section', 'aria-label': 'Shared with me' },
    h('h2', { class: 'tpl-section-title' }, 'Shared with me'), sharedGrid);
  const builtinSection = h('section', { class: 'tpl-section', 'aria-label': 'Built-in templates' },
    h('h2', { class: 'tpl-section-title' }, 'Built-in templates'), grid);
  const count = h('p', { class: 'tpl-count', 'aria-live': 'polite' });
  const empty = h('p', { class: 'home-empty' }, 'No templates match.');
  const chips = h('div', { class: 'tpl-chips', role: 'group', 'aria-label': 'Filter by category' });

  const filters = (): (string | null)[] => [
    null, ...CATEGORIES, ...([...(mine ?? []), ...shared].some((t) => t.category === CUSTOM_CATEGORY) ? [CUSTOM_CATEGORY] : []),
  ];

  const customCard = (t: CustomTemplate) => {
    const can = mayChange(t);
    const more = moreButton(t.name, [
      ...(can ? [
        { icon: 'pen' as const, label: 'Edit', run: () => (location.hash = `#/t/${t.id}/edit`) },
        { icon: 'text' as const, label: 'Rename', run: () => openRename(t) },
      ] : []),
      { icon: 'dup', label: 'Duplicate', run: () => void duplicate(t) },
      { icon: 'download', label: 'Export file', run: () => exportFile(t) },
      ...(can ? [{ icon: 'trash' as const, label: 'Delete', run: () => confirmDelete(t) }] : []),
    ]);
    const who = userId !== null && t.createdBy !== userId && t.ownerName ? ` · ${t.ownerName}` : '';
    return h('li', null,
      h('article', { class: 'tpl-card' },
        h('div', { class: 'tpl-thumb', html: customThumbnail(t) }),
        h('p', { class: 'tpl-label' }, t.category),
        userId === null ? null : h('p', { class: 'tpl-scope' }, `${scopeLabel(t, userId)}${who}`),
        h('h2', { class: 'tpl-title' }, t.name),
        h('p', { class: 'tpl-text' }, t.description),
        h('div', { class: 'tpl-actions' },
          h('button', {
            class: 'btn', disabled: down, 'aria-label': `Use template ${t.name}`, onclick: () => useTemplate(nav, customRef(t)),
          }, 'Use template'),
          more)));
  };

  const paint = () => {
    const available = filters();
    if (category !== null && !available.includes(category)) category = null;
    const q = query.trim().toLowerCase();
    const show = (c: string) => category === null || c === category;
    const shown = TEMPLATES.filter((t) => show(t.category) && matches(t, q));
    const shownMine = (mine ?? []).filter((t) => show(t.category) && matches(t, q));
    const shownShared = shared.filter((t) => show(t.category) && matches(t, q));
    // The buttons are rebuilt only when the set of categories changes, so a focused chip stays focused.
    if (available.join('|') !== chipSet) {
      chipSet = available.join('|');
      chips.replaceChildren(...available.map((c) => h('button', {
        class: 'tpl-chip', onclick: () => {
          category = c;
          paint();
        },
      }, c ?? 'All')));
    }
    available.forEach((c, i) => chips.children[i].setAttribute('aria-pressed', String(c === category)));
    count.textContent = countLabel(shown.length + shownMine.length + shownShared.length);
    grid.replaceChildren(...shown.map((t) => h('li', null,
      h('article', { class: 'tpl-card' },
        h('div', { class: 'tpl-thumb', html: builtinThumbnail(t) }),
        h('p', { class: 'tpl-label' }, t.category),
        h('h2', { class: 'tpl-title' }, t.name),
        h('p', { class: 'tpl-text' }, t.description),
        h('div', { class: 'tpl-actions' },
          h('button', {
            class: 'btn', disabled: down, 'aria-label': `Use template ${t.name}`, onclick: () => useTemplate(nav, t.id),
          }, 'Use template'),
          moreButton(t.name, [{ icon: 'dup', label: 'Duplicate to edit', run: () => void duplicateToEdit(t) }]))))));
    mineGrid.replaceChildren(...shownMine.map(customCard));
    sharedGrid.replaceChildren(...shownShared.map(customCard));
    sharedSection.hidden = !shownShared.length;
    // Nothing saved yet is worth saying; saved templates that the filter hides are not.
    mineEmpty.hidden = mine === null || mine.length > 0;
    mineSection.hidden = mine === null || (mine.length > 0 && !shownMine.length);
    builtinSection.hidden = !shown.length;
    empty.hidden = shown.length + shownMine.length + shownShared.length > 0;
  };

  const load = () => {
    void listTemplates().then((list) => {
      if (!grid.isConnected) return;
      ({ mine, shared } = splitMine(list, userId));
      paint();
    });
  };

  const fileInput = templateFileInput();
  const banner = me ? createWorkspaceBanner() : null;
  root.replaceChildren(...(banner ? [banner.el] : []), h('div', { class: 'home-page' },
    createTopbar('templates', me),
    h('main', { class: 'home' },
      h('header', { class: 'home-head' },
        h('div', { class: 'home-titlerow' },
          h('h1', { class: 'home-title' }, 'Templates'),
          h('div', { class: 'home-actions' },
            h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import template'),
            fileInput)),
        h('p', { class: 'home-lede' }, 'Ready-made boards for team exercises, and the ones you save. Pick one to open it as a new board.'),
        down ? h('p', { class: 'home-note', role: 'status' }, 'You are offline. Starting a board from a template needs the server.') : null,
        h('div', { class: 'tpl-toolbar' },
          chips,
          searchField('Search templates', query, (value) => {
            query = value;
            paint();
          }))),
      h('div', { class: 'tpl-results' }, count, mineSection, sharedSection, builtinSection, empty),
      pageFooter(me ? 'Boards sync through your workspace server when it is reachable.' : `Boards are stored ${storedWhere()}.`))));
  paint();
  load();
  const off = onTemplatesChange(() => {
    if (!grid.isConnected) off();
    else load();
  });
}
