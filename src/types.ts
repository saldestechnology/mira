// Board data model. Every object is stored as a flat Y.Map of these fields, so
// concurrent edits to different fields of one object merge cleanly and the same
// field resolves last-writer-wins.

import type { OWNER_KINDS, STAGES } from '../shared/containers';

export type Id = string;

export type ShapeKind =
  | 'rect' | 'rounded' | 'ellipse' | 'diamond' | 'triangle' | 'hexagon'
  | 'octagon' | 'parallelogram' | 'trapezoid' | 'star' | 'cylinder'
  | 'document' | 'terminator' | 'manual-input' | 'predefined'
  | 'pentagon' | 'cross' | 'heart' | 'cloud' | 'arrow-right' | 'arrow-left'
  | 'arrow-both' | 'chevron' | 'arrow-pentagon' | 'callout-rect' | 'callout-round'
  | 'delay' | 'merge' | 'off-page' | 'manual-operation' | 'display';

export type UmlType =
  | 'uml-class' | 'uml-actor' | 'uml-usecase' | 'uml-lifeline' | 'uml-note'
  | 'uml-package' | 'uml-state' | 'uml-initial' | 'uml-final' | 'uml-component';

export type ObjType = 'shape' | 'sticky' | 'text' | 'frame' | 'tracker' | 'group' | 'icon' | 'image' | 'path' | 'connector' | 'container' | 'lane' | 'card' | UmlType;

export type Dash = 'solid' | 'dashed' | 'dotted';
export type Align = 'left' | 'center' | 'right';
export type VAlign = 'top' | 'middle' | 'bottom';
export type TrackerStateCategory = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

export interface TrackerProjection {
  ticketId: Id;
  ticketKey: string;
  title: string;
  state: { id: Id; key: string; name: string; category: TrackerStateCategory };
  assignee: { userId: Id; name: string } | null;
  labels: { id: Id; name: string; color: string | null }[];
  priority: 'none' | 'urgent' | 'high' | 'medium' | 'low';
  due: string | null;
  projectionSeq: number;
}

export interface TrackerContainerExt {
  provider: 'tabula';
  tracker: Id;
  map: Record<string, string>;
}

export type Head =
  | 'none' | 'arrow' | 'open' | 'triangle' | 'diamond' | 'diamond-open'
  | 'circle' | 'bar' | 'crow-many' | 'crow-one';

export type Route = 'straight' | 'elbow' | 'curved';

export type UmlRelation =
  | 'association' | 'directed' | 'generalization' | 'realization' | 'dependency'
  | 'aggregation' | 'composition' | 'message' | 'async' | 'reply'
  | 'include' | 'extend' | 'transition';

export type Side = 'top' | 'right' | 'bottom' | 'left';

export type End =
  | { kind: 'free'; x: number; y: number }
  | { kind: 'bound'; id: Id; anchor: 'auto' | Side };

export interface StyleFields {
  fill: string;
  stroke: string;
  strokeWidth: number;
  dash: Dash;
  opacity: number;
  font: string;        // Fontshare slug, or 'system'
  fontWeight: number;
  fontSize: number;
  textColor: string;
  align: Align;
  valign: VAlign;
}

export interface Member {
  visibility: '+' | '-' | '#' | '~' | '';
  name: string;
  type: string;
  isStatic?: boolean;
  isAbstract?: boolean;
}

export interface BaseObj extends Partial<StyleFields> {
  id: Id;
  type: ObjType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Mirror the drawn content across the box's vertical centre line. Geometry only; absent is false. */
  flipX?: boolean;
  /** Mirror the drawn content across the box's horizontal centre line. Geometry only; absent is false. */
  flipY?: boolean;
  z: string;
  parent?: Id;
  locked?: boolean;
  /** The AI run an added object came from (TAB-160): which feature and who asked. Read through cleanProposedBy. */
  proposedBy?: ProposedBy;
  /** Hidden for everyone (TAB-198): not drawn, hit, selected or exported; listed dimmed in the layers panel. Not private. */
  hidden?: boolean;
  createdBy?: string;
  updatedAt?: number;
  text?: string;
  // shape
  kind?: ShapeKind;
  // a frame's title; for anything else the name the layers panel shows (TAB-198)
  name?: string;
  /** Read-only TABULA projection fields on linked cards; trackerId also selects a workspace on tracker frames. */
  extProvider?: 'tabula';
  extKey?: string;
  extUrl?: string;
  trackerId?: string;
  /** Default tracker tab for this frame: navigation state only. */
  view?: 'inbox' | 'my' | 'all' | 'board' | 'projects';
  /** Saved tracker view selected by this frame: navigation state only. */
  viewId?: string;
  /** Ticket key opened by default in this frame: navigation state only. */
  focusKey?: string;
  // icon
  ref?: string;
  body?: string;
  viewBox?: [number, number, number, number];
  sticker?: boolean;
  // image: the content hash of the uploaded file, or `pending:<id>` while the bytes are only on this device
  asset?: string;
  mime?: string;
  /** Natural size in pixels, for the aspect ratio and the placeholder. */
  nw?: number;
  nh?: number;
  alt?: string;
  // path
  points?: number[]; // flat [x0,y0,x1,y1,...] relative to x,y
  // uml-class
  stereotype?: string;
  attributes?: Member[];
  operations?: Member[];
  // facilitation
  privateStep?: Id;
  // container (docs/kanban.md). `parent` says which lane or container, `rank` is `<key>@<parent>`.
  layout?: string;
  /** Server-written TABULA tracker link for a kanban container. */
  ext?: TrackerContainerExt;
  /** Compact server-written snapshot of the linked ticket; clients issue tracker commands to change it. */
  tracker?: TrackerProjection;
  /** Server marker for a linked ticket state that has no mapped lane. */
  trackerUnmappedState?: boolean;
  rank?: string;
  laneW?: number;
  stage?: typeof STAGES[number];
  wip?: number;
  wipMode?: 'warn' | 'block';
  desc?: string;
  ownerId?: string;
  ownerName?: string;
  ownerKind?: typeof OWNER_KINDS[number];
  due?: string;
  link?: string;
  labels?: Id[];
}

export interface ConnectorObj {
  id: Id;
  type: 'connector';
  z: string;
  from: End;
  to: End;
  route: Route;
  startHead: Head;
  endHead: Head;
  relation?: UmlRelation;
  label?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: Dash;
  opacity?: number;
  createdBy?: string;
  updatedAt?: number;
  // unused geometry fields kept for uniform handling
  x?: number; y?: number; w?: number; h?: number; rotation?: number; parent?: Id; locked?: boolean;
  hidden?: boolean;
  name?: string;
}

/** A group has no picture of its own; its rectangle is derived from its visible members. */
export interface Group extends BaseObj {
  type: 'group';
}

export type Obj = BaseObj | Group | ConnectorObj;

/** The AI run behind an added object (TAB-160): stored data, so hostile until cleanProposedBy (src/safe-obj.ts) has read it. */
export interface ProposedBy {
  feature: 'generate' | 'summarise' | 'cluster';
  by: { id: string | null; name: string | null };
}

export const isConnector = (o: Obj | undefined): o is ConnectorObj => !!o && o.type === 'connector';
export const isBox = (o: Obj | undefined): o is BaseObj => !!o && o.type !== 'connector' && o.type !== 'group';

export type StepMode = 'write' | 'private-write' | 'cluster' | 'vote' | 'discuss' | 'poll';

export interface Step {
  id: Id;
  title: string;
  instructions: string;
  frameId?: Id;
  durationSec?: number;
  mode: StepMode;
  /** Dots each person may place; 0 = unlimited. Defaults to 3. */
  votesPerPerson?: number;
  /**
   * What a dot vote may be placed on: `all` (every note, shape, card, text and image; the default when absent), `stickies`, or
   * `selection` (exactly `voteItems`, which may include a frame). Only a vote step has it.
   */
  voteScope?: 'all' | 'stickies' | 'selection';
  voteItems?: Id[];
  /** Added with the one-click dot vote; removed from the flow when the session ends. */
  quick?: boolean;
  /** Set iff mode is 'poll'; the poll lives in the `polls` map (see docs/polls.md). */
  pollId?: Id;
}

export interface Timer {
  startedAt: number;
  durationMs: number;
  pausedAt?: number;
}

export interface Vote {
  itemId: Id;
  userId: string;
  stepId: Id;
}

export interface PollOption {
  id: Id;
  text: string;
}

export interface Poll {
  id: Id;
  question: string;
  options: PollOption[];
  multiple: boolean;
  anonymous: boolean;
  revealed: boolean;
  createdAt: number;
  createdBy: string;
  /** First time the flow moved onto the poll's step. The definition locks from here. */
  openedAt?: number;
  /** First time the flow moved off the step, or the session ended. Answers lock from here. */
  closedAt?: number;
}

export interface PollAnswer {
  pollId: Id;
  userId: string;
  optionIds: Id[];
  updatedAt: number;
  /** Named polls only. */
  name?: string;
  color?: string;
}

/** A board-wide label (docs/kanban.md). `color` is a palette key, so chips follow the theme. */
export interface Label {
  id: Id;
  name: string;
  color: string;
  order: number;
}

export type GridType = 'dots' | 'lines' | 'iso' | 'none';

/**
 * The board's settings. The meta map also holds `feature:<name>` = true for what the board needs that older clients lack
 * (`feature:containers`); a client that does not know one opens the board read-only. Those keys are open-ended, so they
 * are not fields here (see FEATURE_PREFIX in shared/containers.mjs).
 */
export interface BoardMeta {
  name: string;
  schemaVersion: number;
  gridType: GridType;
  gridSize: number;
  snap: boolean;
  headingFont: string;
  bodyFont: string;
  /** Custom sticky colours added on this board, newest first; shared by everyone. */
  stickyColors: string[];
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface User { id: string; name: string; color: string; guest?: boolean }

export const SCHEMA_VERSION = 1;
