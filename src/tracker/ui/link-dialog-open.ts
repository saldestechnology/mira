import { toast } from '../../ui/common';
import { createLinkDialogModel } from './link-dialog-model';
import { mountLinkDialog } from './link-dialog';
import type { LinkDialogContext } from './link-seam';
import { registerLinkDialog } from './link-seam';

let activeOpen: Promise<void> | null = null;

/** Fetches the current state choices and suggestion, then resolves after the dialog closes. */
export function openTrackerLinkDialog(context: LinkDialogContext): Promise<void> {
  if (activeOpen) return activeOpen;
  activeOpen = open(context).finally(() => { activeOpen = null; });
  return activeOpen;
}

async function open(context: LinkDialogContext): Promise<void> {
  let host: HTMLElement | null = null;
  try {
    let meta = context.store.snapshot().meta;
    if (!meta) meta = await context.store.loadMeta();
    const states = meta.states.map(({ id, key, name, category }) => ({ id, key, name, category }));
    const suggestion = await context.store.suggestLinkMapping(context.boardId, context.kanbanId);
    const model = createLinkDialogModel({
      lanes: context.kanban.lanes.map(({ id, name }) => ({ id, name })),
      states,
      suggestion,
      existingCardCount: suggestion.existingCardCount,
    });
    host = document.createElement('div');
    host.className = 'trk-link-dialog-host';
    document.body.appendChild(host);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        host?.remove();
        resolve();
      };
      mountLinkDialog(host!, {
        model, context, states, suggestion,
        onClose: finish,
        onLinked: () => undefined,
      });
    });
  } catch {
    host?.remove();
    toast("Couldn't load the kanban. Try again.");
  }
}

/** Register the Link action used by the kanban menus and quick bar. */
export function installTrackerLinkDialog(): () => void {
  return registerLinkDialog((context) => { void openTrackerLinkDialog(context); });
}
