// Types for shared/containers.mjs. The browser imports the module without an extension ('../shared/containers') so
// TypeScript finds this file; the server imports 'containers.mjs' directly.

export interface Rect { x: number; y: number; w: number; h: number }

/** What the rank helpers read from a lane or a card. */
export interface Ranked {
  id: string;
  parent?: string;
  rank?: string;
  updatedAt?: number;
}

/** A change to write to one child: its parent and a rank that carries that parent. */
export interface RankPatch { id: string; parent: string; rank: string }

/** What a layout reads from a container. */
export interface ContainerFields {
  id: string;
  x?: number;
  y?: number;
  z?: string;
  layout?: string;
  laneW?: number;
}

/** What a layout reads from a card. */
export interface CardFields extends Ranked {
  h?: number;
}

export interface ContainerLayout {
  layout: string;
  /** The container's own size. Its position is the stored x and y. */
  w: number;
  h: number;
  /** The container, its lanes and its cards, in world coordinates. */
  rects: Map<string, Rect>;
  /** Lane ids, left to right. */
  lanes: string[];
  /** Card ids per lane, top to bottom. Cards of deleted lanes are at the end of the first lane. */
  cards: Map<string, string[]>;
  /** Lane ids, then each lane's card ids: the paint order of everything inside the container. */
  order: string[];
  /** The add-lane button's place, right of the last lane and level with its header. */
  addLane: Rect;
}

export type WipMode = 'warn' | 'block';

export interface WipVerdict {
  ok: boolean;
  /** The lane would hold more cards than its limit. */
  over: boolean;
  /** Cards the lane would hold after the drop. */
  count: number;
  limit: number | null;
  mode: WipMode;
}

export const CONTAINER_TYPES: readonly ['container', 'lane', 'card'];
export function isContainerType(type: string): boolean;

export const OWNER_KINDS: readonly ['person', 'agent'];
export const STAGES: readonly ['todo', 'doing', 'done'];
export const DEFAULT_KANBAN_LANES: readonly [
  { readonly name: 'To do'; readonly stage: 'todo' },
  { readonly name: 'Doing'; readonly stage: 'doing' },
  { readonly name: 'Done'; readonly stage: 'done' },
];
export const CARD_LINK_MAX: 2000;
export const OWNER_NAME_MAX: 80;
export function cleanCardTitle(value: unknown): string;
export function cleanOwnerName(value: unknown): string;
export function codePointLength(value: string): number;
export function isSafeHttpUrl(value: unknown): value is string;
export function isDueDate(value: unknown): value is string;

export const FEATURES: { readonly containers: 'containers'; readonly tracker: 'tracker' };
export const KNOWN_FEATURES: readonly string[];
export const FEATURE_PREFIX: 'feature:';
export function featureKey(name: string): string;
export function isFeatureKey(key: string): boolean;
export function featuresOf(meta: unknown): string[];
export function unknownFeatures(meta: unknown): string[];

export const LIMITS: {
  readonly containers: 50;
  readonly lanes: 20;
  readonly cardsPerLane: 500;
  readonly cards: 2000;
  readonly title: 200;
  readonly description: 4000;
  readonly labels: 30;
  readonly labelsPerCard: 10;
  readonly labelName: 40;
  readonly laneName: 60;
  readonly containerName: 80;
  readonly laneWMin: 200;
  readonly laneWMax: 480;
  readonly wipMin: 1;
  readonly wipMax: 99;
};

export function cleanLabelName(value: unknown): string;
export function cleanLaneName(value: unknown): string;
export function labelNameTaken(labels: Iterable<{ id?: string; name?: string }>, name: unknown, exceptId?: string | null): boolean;
export function isLaneStage(value: unknown): value is 'todo' | 'doing' | 'done';
export function isWipLimit(value: unknown): value is number;
export function validLabelColor(value: unknown): string | null;

export const LABEL_COLORS: readonly ['yellow', 'orange', 'pink', 'violet', 'blue', 'teal', 'green', 'grey'];

export function kanbanColor(value: unknown, fallback?: string | null): string | null;
export const LABEL_DEFAULT_COLOR: 'grey';

export function validLabel(value: unknown): { id: string; name: string; color: string; order: number } | null;

export function splitRank(rank: unknown): { key: string; parent: string } | null;
export function rankBetween(prev: string | null | undefined, next: string | null | undefined, parentId: string): string;
export function ranksBetween(prev: string | null | undefined, next: string | null | undefined, n: number, parentId: string): string[];
export function isMixedRank(child: Ranked): boolean;
export function sortedChildren<T extends Ranked>(children: Iterable<T>): T[];
export function needsNormalising(children: Iterable<Ranked>, parentId?: string): boolean;
export function normaliseRanks(children: Iterable<Ranked>, parentId: string): RankPatch[];
export function planInsert(children: Iterable<Ranked>, parentId: string, index: number, count?: number): { ranks: string[]; repairs: RankPatch[] };

export const KANBAN: {
  readonly laneW: 280;
  readonly laneGap: 16;
  readonly pad: 12;
  readonly header: 48;
  readonly cardGap: 8;
  readonly minBody: 160;
  readonly containerHeader: 48;
  readonly lanePad: 8;
  readonly dropZone: 56;
  readonly addLaneGap: 8;
  readonly addLaneW: 32;
  readonly emptyLane: 56;
  readonly cardH: 72;
};

export function hasLayout(name: unknown): boolean;
export function layoutContainer(container: ContainerFields, lanes: Iterable<Ranked>, cards: Iterable<CardFields>): ContainerLayout | null;
export function orphanHome(containers: Iterable<ContainerFields>): string | null;
export function layoutAll(objects: Iterable<{ id: string; type: string; parent?: string }>): { layouts: Map<string, ContainerLayout>; rects: Map<string, Rect> };

export function wipCheck(lane: { wip?: number; wipMode?: string }, cards: Iterable<{ id: string }>, moving: Iterable<string>): WipVerdict;

export const TEMPLATE_STRIPPED: readonly string[];
export function templateLabels(list: unknown): { id: string; name: string; color: string }[];
export function templateKanbanFields(o: Record<string, unknown>, what: string, ctx: { types: Map<string, string>; labels: Set<string> }): Record<string, unknown>;
export function checkTemplateKanbanLimits(objects: Iterable<{ id: string; type: string; parent?: unknown }>): void;
