/**
 * render.js — draw the swimlane diagram as inline SVG.
 *
 * Inline SVG rather than a charting library: the diagram is the deliverable a
 * BA exports and pastes into a requirements doc, so it has to be a standalone
 * file with no runtime dependency.
 */

import { layout, pathFromPoints, METRICS } from './layout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per-type visual treatment. Keys are node types. */
const STYLE = {
  'event.start': { fill: 'var(--n-start)', stroke: 'var(--n-start-line)', text: 'var(--n-start-text)' },
  'event.start.message': { fill: 'var(--n-start)', stroke: 'var(--n-start-line)', text: 'var(--n-start-text)' },
  'end': { fill: 'var(--n-end)', stroke: 'var(--n-end-line)', text: 'var(--n-end-text)' },
  'end.terminate': { fill: 'var(--n-stop)', stroke: 'var(--n-stop-line)', text: 'var(--n-stop-text)' },
  'gateway.exclusive': { fill: 'var(--n-gate)', stroke: 'var(--n-gate-line)', text: 'var(--n-gate-text)' },
  'gateway.merge': { fill: 'var(--n-merge)', stroke: 'var(--n-merge-line)', text: 'var(--n-merge-text)' },
  'task.approval': { fill: 'var(--n-human)', stroke: 'var(--n-human-line)', text: 'var(--n-human-text)' },
  'task.review': { fill: 'var(--n-human)', stroke: 'var(--n-human-line)', text: 'var(--n-human-text)' },
  'task.assign': { fill: 'var(--n-human)', stroke: 'var(--n-human-line)', text: 'var(--n-human-text)' },
  'task.notify': { fill: 'var(--n-notify)', stroke: 'var(--n-notify-line)', text: 'var(--n-notify-text)' },
  'task.audit': { fill: 'var(--n-audit)', stroke: 'var(--n-audit-line)', text: 'var(--n-audit-text)' },
  _default: { fill: 'var(--n-system)', stroke: 'var(--n-system-line)', text: 'var(--n-system-text)' }
};

const ICON = {
  'task.approval': '✓', 'task.review': '👁', 'task.notify': '✉',
  'task.data.write': '⤓', 'task.data.read': '⤒', 'task.create': '+',
  'task.assign': '→', 'task.audit': '🔒', 'event.timer': '⏱', 'task.terminate': '×'
};

function el(name, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

/** Greedy word wrap to a pixel width, approximating 6.2px per character at 12px. */
function wrap(text, maxWidth, charWidth = 6.15, maxLines = 3) {
  const words = String(text).split(/\s+/);
  const perLine = Math.max(6, Math.floor(maxWidth / charWidth));
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= perLine) { line = candidate; continue; }
    if (line) lines.push(line);
    line = w.length > perLine ? w.slice(0, perLine - 1) + '…' : w;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{1}$/, '…');
    return kept;
  }
  return lines;
}

/**
 * Render the swimlane into `container`.
 * @returns the <svg> element, so the caller can serialise it for download.
 */
export function renderSwimlane(container, wf, opts = {}) {
  const geo = layout(wf);
  container.innerHTML = '';

  // When a simulation has run, everything off the taken path is dimmed rather
  // than hidden — a reader needs to see the road not travelled to trust the one
  // that was.
  const pathNodes = opts.pathNodes ? new Set(opts.pathNodes) : null;
  const pathEdges = opts.pathEdges ? new Set(opts.pathEdges) : null;

  const svg = el('svg', {
    xmlns: SVG_NS,
    viewBox: `0 0 ${geo.width} ${geo.height}`,
    width: geo.width,
    height: geo.height,
    class: 'swimlane',
    role: 'img',
    'aria-label': `Swimlane diagram of ${wf.name}: ${wf.nodes.length} steps across ${geo.lanes.length} lanes`
  }, container);

  const defs = el('defs', {}, svg);
  for (const [id, colour] of [['arrow', 'var(--edge)'], ['arrow-yes', 'var(--edge-yes)'], ['arrow-no', 'var(--edge-no)'], ['arrow-back', 'var(--edge-back)']]) {
    const marker = el('marker', {
      id, viewBox: '0 0 10 10', refX: 9, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse'
    }, defs);
    el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: colour }, marker);
  }

  /* lanes ---------------------------------------------------------- */
  const laneLayer = el('g', { class: 'lanes' }, svg);
  geo.lanes.forEach((lane, i) => {
    el('rect', {
      x: 0, y: lane.y, width: geo.width, height: lane.height,
      class: `lane-band lane-${lane.kind}`, 'data-lane': lane.id,
      fill: i % 2 ? 'var(--lane-alt)' : 'var(--lane)'
    }, laneLayer);
    el('line', { x1: 0, y1: lane.y, x2: geo.width, y2: lane.y, class: 'lane-rule' }, laneLayer);

    el('rect', { x: 0, y: lane.y, width: METRICS.laneLabelWidth, height: lane.height, class: `lane-header lane-header-${lane.kind}` }, laneLayer);
    const label = el('text', {
      x: 18, y: lane.y + lane.height / 2, class: 'lane-label',
      'dominant-baseline': 'middle'
    }, laneLayer);
    label.textContent = lane.name;
    const kind = el('text', {
      x: 18, y: lane.y + lane.height / 2 + 16, class: 'lane-kind', 'dominant-baseline': 'middle'
    }, laneLayer);
    kind.textContent = lane.kind === 'role' ? 'human' : lane.kind === 'engine' ? 'orchestrator' : 'system';
  });
  const lastLane = geo.lanes[geo.lanes.length - 1];
  if (lastLane) el('line', { x1: 0, y1: lastLane.y + lastLane.height, x2: geo.width, y2: lastLane.y + lastLane.height, class: 'lane-rule' }, laneLayer);
  el('line', { x1: METRICS.laneLabelWidth, y1: geo.lanes[0]?.y ?? 0, x2: METRICS.laneLabelWidth, y2: (lastLane?.y ?? 0) + (lastLane?.height ?? 0), class: 'lane-divider' }, laneLayer);

  /* edges ---------------------------------------------------------- */
  const edgeLayer = el('g', { class: 'edges' }, svg);
  for (const e of geo.edges) {
    if (!e.points.length) continue;
    const cls = e.back ? 'back' : e.guard === 'true' ? 'yes' : e.guard === 'false' ? 'no' : 'plain';
    const onPath = !pathEdges || pathEdges.has(e.id);
    el('path', {
      d: pathFromPoints(e.points, e.back ? 12 : 10),
      class: `edge edge-${cls}${pathEdges ? (onPath ? ' edge-live' : ' edge-dim') : ''}`,
      'marker-end': `url(#${cls === 'yes' ? 'arrow-yes' : cls === 'no' ? 'arrow-no' : cls === 'back' ? 'arrow-back' : 'arrow'})`,
      'data-edge': e.id
    }, edgeLayer);

    if (e.label) {
      // Put the label on the first horizontal run so it never sits on a corner.
      const [p0, p1] = e.points;
      const lx = e.back ? (e.points[1][0] + e.points[2][0]) / 2 : (p0[0] + p1[0]) / 2;
      const ly = e.back ? e.points[1][1] - 8 : p0[1] - 9;
      const g = el('g', { class: `edge-label-g${pathEdges && !onPath ? ' edge-dim' : ''}` }, edgeLayer);
      const t = el('text', { x: lx, y: ly, class: `edge-label edge-label-${cls}`, 'text-anchor': 'middle' }, g);
      t.textContent = e.label;
      // Background chip sized from the text, inserted behind it.
      const w = e.label.length * 6.4 + 12;
      const bg = el('rect', { x: lx - w / 2, y: ly - 11, width: w, height: 16, rx: 8, class: 'edge-label-bg' });
      g.insertBefore(bg, t);
    }
  }

  /* nodes ---------------------------------------------------------- */
  const nodeLayer = el('g', { class: 'nodes' }, svg);
  // The graph stores technical names; the UI may want business wording. The
  // JSON is never rewritten — only what is drawn.
  const nameFor = opts.nameFor || (n => n.name);
  for (const p of geo.nodes) {
    const n = p.node;
    const displayName = nameFor(n);
    const style = STYLE[n.type] || STYLE._default;
    const live = !pathNodes || pathNodes.has(n.id);
    const stepIndex = opts.stepOrder ? opts.stepOrder.get(n.id) : null;
    const g = el('g', {
      class: [
        'node',
        `node-${n.type.replace(/\./g, '-')}`,
        opts.highlightId === n.id ? 'node-highlight' : '',
        pathNodes ? (live ? 'node-live' : 'node-dim') : '',
        opts.currentStepId === n.id ? 'node-current' : ''
      ].filter(Boolean).join(' '),
      'data-node': n.id,
      tabindex: 0,
      role: 'button',
      'aria-label': `${displayName}, performed by ${n.performer?.name || 'unassigned'}`
    }, nodeLayer);

    if (p.shape === 'diamond') {
      const s = p.w / 2;
      el('path', {
        d: `M ${p.cx} ${p.cy - s} L ${p.cx + s} ${p.cy} L ${p.cx} ${p.cy + s} L ${p.cx - s} ${p.cy} Z`,
        fill: style.fill, stroke: style.stroke, 'stroke-width': 1.5, class: 'node-shape'
      }, g);
      if (n.type === 'gateway.exclusive') {
        const q = el('text', { x: p.cx, y: p.cy, class: 'gate-glyph', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: style.text }, g);
        q.textContent = '×';
      }
      // Gateway label sits under the diamond so it can be long.
      const lines = wrap(displayName, 210, 5.8, 2);
      lines.forEach((ln, i) => {
        const t = el('text', {
          x: p.cx, y: p.cy + s + 15 + i * 13, class: 'node-caption', 'text-anchor': 'middle'
        }, g);
        t.textContent = ln;
      });
    } else if (p.shape === 'circle') {
      el('circle', { cx: p.cx, cy: p.cy, r: p.w / 2, fill: style.fill, stroke: style.stroke, 'stroke-width': n.type === 'end' || n.type === 'end.terminate' ? 3 : 1.8, class: 'node-shape' }, g);
      const glyph = el('text', { x: p.cx, y: p.cy, class: 'event-glyph', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: style.text }, g);
      glyph.textContent = n.type === 'end.terminate' ? '■' : n.type.startsWith('event.start') ? '▶' : '●';
      const lines = wrap(displayName, 200, 5.8, 2);
      lines.forEach((ln, i) => {
        const t = el('text', { x: p.cx, y: p.cy + p.h / 2 + 15 + i * 13, class: 'node-caption', 'text-anchor': 'middle' }, g);
        t.textContent = ln;
      });
    } else {
      el('rect', {
        x: p.x, y: p.y, width: p.w, height: p.h, rx: 9,
        fill: style.fill, stroke: style.stroke, 'stroke-width': 1.5, class: 'node-shape'
      }, g);
      el('rect', { x: p.x, y: p.y, width: 4, height: p.h, rx: 2, fill: style.stroke, class: 'node-accent' }, g);

      const icon = ICON[n.type];
      if (icon) {
        const t = el('text', { x: p.x + 16, y: p.y + 17, class: 'node-icon', fill: style.stroke }, g);
        t.textContent = icon;
      }
      const lines = wrap(displayName, p.w - 24, 6.05, 3);
      const startY = p.y + p.h / 2 - ((lines.length - 1) * 13) / 2 + 1;
      lines.forEach((ln, i) => {
        const t = el('text', {
          x: p.x + 12, y: startY + i * 13, class: 'node-label',
          fill: style.text, 'dominant-baseline': 'middle'
        }, g);
        t.textContent = ln;
      });

      // Badges for the properties a reviewer looks for.
      const badges = [];
      if (n.sla) badges.push(n.sla.durationSeconds ? fmtDuration(n.sla.durationSeconds) : 'no limit');
      if (n.retry) badges.push(`retry ×${n.retry.maxAttempts}`);
      if (badges.length) {
        const t = el('text', { x: p.x + p.w - 10, y: p.y + p.h - 8, class: 'node-badge', 'text-anchor': 'end' }, g);
        t.textContent = badges.join(' · ');
      }
    }

    // Numbered marker showing the order the simulation visited this step.
    if (stepIndex != null) {
      const bx = p.shape === 'rect' ? p.x + p.w - 11 : p.cx + p.w / 2 - 3;
      const by = p.shape === 'rect' ? p.y + 11 : p.cy - p.h / 2 + 3;
      el('circle', { cx: bx, cy: by, r: 9, class: 'step-marker-bg' }, g);
      const t = el('text', { x: bx, y: by, class: 'step-marker', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
      t.textContent = String(stepIndex);
    }

    if (opts.onNodeClick) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => opts.onNodeClick(n));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); opts.onNodeClick(n); } });
    }
  }

  return svg;
}

function fmtDuration(sec) {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${Math.round(sec / 60)}m`;
}

/** Serialise the rendered SVG with styles inlined enough to open standalone. */
export function svgToFile(svg, cssText) {
  const clone = svg.cloneNode(true);
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = cssText;
  clone.insertBefore(style, clone.firstChild);
  clone.setAttribute('xmlns', SVG_NS);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}
