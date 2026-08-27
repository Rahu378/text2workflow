/**
 * layout.js — turn a workflow graph into swimlane geometry.
 *
 * Left-to-right layered layout: rank = longest path from the start event
 * (back-edges excluded so a resubmit loop cannot push its own target rightwards
 * forever), lane = the participant that performs the step. Nodes sharing a
 * (rank, lane) cell stack vertically inside that lane's band.
 */

export const METRICS = {
  laneLabelWidth: 168,
  // Column width is the single biggest lever on how large the diagram renders
  // once it is scaled to fit a pane. Wide columns look airy at 1:1 and turn the
  // text unreadable at 0.55. This leaves ~38px between boxes — enough for an
  // edge label chip — while keeping the natural canvas narrow enough that a
  // typical pane fits it above 0.6 scale.
  colWidth: 214,
  colGap: 0,
  nodeW: 176,
  nodeH: 62,
  gatewaySize: 64,
  eventSize: 52,
  rowGap: 26,
  // Generous lane padding on purpose: a lane squeezed to the height of one box
  // reads as a strip of text, not as a swimlane. The extra room is what makes
  // the diagram legible when it is scaled down to fit a pane.
  lanePadding: 34,
  topPadding: 34,
  backChannel: 38
};

const GATEWAY_TYPES = new Set(['gateway.exclusive', 'gateway.merge', 'gateway.parallel']);
const EVENT_TYPES = new Set(['event.start', 'event.start.message', 'end', 'end.terminate', 'event.timer']);

export function shapeOf(node) {
  if (GATEWAY_TYPES.has(node.type)) return 'diamond';
  if (EVENT_TYPES.has(node.type)) return 'circle';
  return 'rect';
}

/** Longest-path ranking over the DAG formed by non-back edges. */
export function rankNodes(wf) {
  const rank = new Map(wf.nodes.map(n => [n.id, 0]));
  const forward = wf.edges.filter(e => !e.back);
  const indeg = new Map(wf.nodes.map(n => [n.id, 0]));
  forward.forEach(e => indeg.set(e.to, (indeg.get(e.to) || 0) + 1));

  const queue = wf.nodes.filter(n => (indeg.get(n.id) || 0) === 0).map(n => n.id);
  const order = [];
  const deg = new Map(indeg);
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const e of forward.filter(e => e.from === id)) {
      rank.set(e.to, Math.max(rank.get(e.to), rank.get(id) + 1));
      deg.set(e.to, deg.get(e.to) - 1);
      if (deg.get(e.to) === 0) queue.push(e.to);
    }
  }

  // Any node left over sits in a cycle the topological pass could not order.
  if (order.length < wf.nodes.length) {
    for (const n of wf.nodes) {
      if (order.includes(n.id)) continue;
      const preds = forward.filter(e => e.to === n.id).map(e => rank.get(e.from) ?? 0);
      rank.set(n.id, preds.length ? Math.max(...preds) + 1 : 0);
    }
  }

  // Terminal ends are pushed to the far right so the diagram reads to a finish.
  const maxRank = Math.max(0, ...[...rank.values()]);
  for (const n of wf.nodes) if (n.type === 'end') rank.set(n.id, maxRank);

  return rank;
}

/**
 * Full geometry: lanes with y-bands, nodes with x/y/w/h, edges with waypoints.
 */
export function layout(wf) {
  const rank = rankNodes(wf);
  // A participant who is only ever a *recipient* (accounting receives an email
  // but performs no step) would otherwise render as an empty band.
  const used = new Set(wf.nodes.map(n => n.lane));
  const laneOrder = wf.participants.map(p => p.id).filter(id => used.has(id));
  const laneIndex = new Map(laneOrder.map((id, i) => [id, i]));

  // Bucket nodes into (lane, rank) cells.
  const cells = new Map();
  for (const n of wf.nodes) {
    const key = `${n.lane}|${rank.get(n.id)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(n);
  }

  // Lane height is driven by its fullest cell.
  const laneRows = new Map(laneOrder.map(id => [id, 1]));
  for (const [key, list] of cells) {
    const lane = key.split('|')[0];
    laneRows.set(lane, Math.max(laneRows.get(lane) ?? 1, list.length));
  }

  const lanes = [];
  let y = METRICS.topPadding;
  for (const id of laneOrder) {
    const rows = laneRows.get(id) ?? 1;
    const height = rows * METRICS.nodeH + (rows - 1) * METRICS.rowGap + METRICS.lanePadding * 2;
    const p = wf.participants.find(x => x.id === id);
    lanes.push({ id, name: p.name, kind: p.kind, y, height, rows });
    y += height;
  }
  const totalHeight = y + METRICS.backChannel + 16;

  const maxRank = Math.max(0, ...[...rank.values()]);
  const totalWidth = METRICS.laneLabelWidth + (maxRank + 1) * METRICS.colWidth + 40;

  const positioned = new Map();
  for (const [key, list] of cells) {
    const [laneId, r] = key.split('|');
    const lane = lanes.find(l => l.id === laneId);
    const colCenter = METRICS.laneLabelWidth + Number(r) * METRICS.colWidth + METRICS.colWidth / 2;
    // Centre the stack within the lane band.
    const stackH = list.length * METRICS.nodeH + (list.length - 1) * METRICS.rowGap;
    let topY = lane.y + (lane.height - stackH) / 2;

    list.forEach(n => {
      const shape = shapeOf(n);
      const w = shape === 'diamond' ? METRICS.gatewaySize : shape === 'circle' ? METRICS.eventSize : METRICS.nodeW;
      const h = shape === 'diamond' ? METRICS.gatewaySize : shape === 'circle' ? METRICS.eventSize : METRICS.nodeH;
      positioned.set(n.id, {
        node: n, shape, rank: Number(r), lane: laneId,
        x: colCenter - w / 2,
        y: topY + (METRICS.nodeH - h) / 2,
        w, h,
        cx: colCenter,
        cy: topY + METRICS.nodeH / 2
      });
      topY += METRICS.nodeH + METRICS.rowGap;
    });
  }

  const edges = wf.edges.map(e => routeEdge(e, positioned, totalHeight));

  return { lanes, nodes: [...positioned.values()], edges, width: totalWidth, height: totalHeight, maxRank };
}

/** Orthogonal routing: out the right side, across a mid-channel, into the left side. */
function routeEdge(edge, positioned, totalHeight) {
  const a = positioned.get(edge.from);
  const b = positioned.get(edge.to);
  if (!a || !b) return { ...edge, points: [], label: edge.label };

  const points = [];

  if (edge.back || b.rank <= a.rank) {
    // Loop back: drop below everything, run left, come up underneath the target.
    const channelY = totalHeight - METRICS.backChannel / 2 - 8;
    points.push([a.cx, a.y + a.h]);
    points.push([a.cx, channelY]);
    points.push([b.cx, channelY]);
    points.push([b.cx, b.y + b.h]);
    return { ...edge, points, back: true, label: edge.label };
  }

  const startX = a.x + a.w;
  const endX = b.x;
  const midX = startX + (endX - startX) / 2;

  points.push([startX, a.cy]);
  if (Math.abs(a.cy - b.cy) < 1) {
    points.push([endX, b.cy]);
  } else {
    points.push([midX, a.cy]);
    points.push([midX, b.cy]);
    points.push([endX, b.cy]);
  }
  return { ...edge, points, back: false, label: edge.label };
}

/** SVG path with rounded corners through a polyline. */
export function pathFromPoints(points, radius = 10) {
  if (points.length < 2) return '';
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const t1 = [cx - ((cx - px) / (inLen || 1)) * r, cy - ((cy - py) / (inLen || 1)) * r];
    const t2 = [cx + ((nx - cx) / (outLen || 1)) * r, cy + ((ny - cy) / (outLen || 1)) * r];
    d += ` L ${t1[0]} ${t1[1]} Q ${cx} ${cy} ${t2[0]} ${t2[1]}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}
