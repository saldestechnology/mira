import type { BaseObj, Obj } from './types';
import { isBox } from './types';

/**
 * Objects a connector can start or end on, and that show connection anchors: boxes, except drawings (a path has no edge to
 * attach to), ordinary frames, and the kanban parts that lay out their children: a lane and the kanban container itself (docs/kanban.md, Connectors: connect to
 * its cards, never to a lane or the kanban). Cards stay connectable on purpose.
 */
export function isConnectable(o: Obj | undefined): o is BaseObj {
  return isBox(o) && o.type !== 'path' && o.type !== 'frame' && o.type !== 'lane' && o.type !== 'container';
}
