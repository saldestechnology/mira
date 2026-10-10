import type { TrackerKanbanLink } from '../../tracker-types';
import type { TrackerStore } from '../../tracker-data';

export interface LinkDialogKanban {
  name: string;
  lanes: { id: string; name: string; cardCount: number }[];
  /** Cards on the kanban now; they become tickets when the dialog's box is ticked. */
  cardCount: number;
}
export interface LinkContextBase { boardId: string; kanbanId: string; store: TrackerStore }
export interface LinkDialogContext extends LinkContextBase { kanban: LinkDialogKanban }
export interface UnlinkConfirmContext extends LinkContextBase { link: TrackerKanbanLink }
type LinkDialogOpen = (context: LinkDialogContext) => void;
type UnlinkConfirmOpen = (context: UnlinkConfirmContext) => void;

let linkDialog: LinkDialogOpen | null = null;
let unlinkConfirm: UnlinkConfirmOpen | null = null;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function registerLinkDialog(open: LinkDialogOpen): () => void {
  linkDialog = open;
  changed();
  return () => {
    if (linkDialog !== open) return;
    linkDialog = null;
    changed();
  };
}

export function registerUnlinkConfirm(open: UnlinkConfirmOpen): () => void {
  unlinkConfirm = open;
  changed();
  return () => {
    if (unlinkConfirm !== open) return;
    unlinkConfirm = null;
    changed();
  };
}

export function onTrackerLinkSeamChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hasRegisteredLinkDialog(): boolean { return linkDialog !== null; }
export function hasRegisteredUnlinkConfirm(): boolean { return unlinkConfirm !== null; }

export function openRegisteredLinkDialog(context: LinkDialogContext): boolean {
  if (!linkDialog) return false;
  linkDialog(context);
  return true;
}

export function openRegisteredUnlinkConfirm(context: UnlinkConfirmContext): boolean {
  if (!unlinkConfirm) return false;
  unlinkConfirm(context);
  return true;
}

export function canShowTrackerLinkAction(input: { trackerEnabled: boolean; linked: boolean; registered: boolean; ready: boolean }): boolean {
  return input.trackerEnabled && !input.linked && input.registered && input.ready;
}

export function canShowTrackerUnlinkAction(input: { trackerEnabled: boolean; linked: boolean; registered: boolean; ready: boolean }): boolean {
  return input.trackerEnabled && input.linked && input.registered && input.ready;
}
