/**
 * simulate.js — walk a compiled workflow with concrete test values.
 *
 * This answers the question static validation cannot: *"what actually happens
 * when a £6,000 invoice comes in and the manager rejects it?"* The validator
 * proves the graph is well-formed; the simulator shows a person the path their
 * own numbers take through it.
 *
 * It is a graph walk, not an execution engine. Nothing is called, nothing is
 * written, no connector is contacted — see docs/limitations.md.
 */

import { describeField, describeOperator, STATUS_VALUES } from './lexicon.js';

const OP_TEXT = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

/* ------------------------------------------------------------------ */
/* what the simulation needs from the user                             */
/* ------------------------------------------------------------------ */

/**
 * Derive the test-value form from the graph itself: one input per decision the
 * workflow actually makes, and nothing else.
 *
 * @returns {{fields: Array, decisions: Array}}
 */
export function simulationInputs(workflow) {
  const fields = [];
  const decisions = [];
  const seen = new Set();

  for (const node of workflow.nodes) {
    if (node.type !== 'gateway.exclusive' || !node.condition) continue;
    const c = node.condition;

    // An approval-outcome gateway is a human decision, not a data field.
    const owner = workflow.nodes.find(n => n.outcomeGatewayId === node.id);
    if (owner) {
      decisions.push({
        key: c.subject,
        gatewayId: node.id,
        taskId: owner.id,
        label: `${owner.performer?.name || 'Approver'} decision`,
        help: owner.name,
        options: ['Approved', 'Rejected'],
        default: 'Approved'
      });
      seen.add(c.subject);
      continue;
    }

    if (c.unresolved || !c.subject || seen.has(c.subject)) continue;
    seen.add(c.subject);

    const meta = describeField(c.subject);
    const kind = c.valueType === 'money' ? 'currency'
      : c.valueType === 'number' || c.valueType === 'percent' ? 'number'
      : meta.kind === 'choice' ? 'choice' : meta.kind;

    fields.push({
      key: c.subject,
      label: meta.label,
      objectLabel: meta.objectLabel,
      kind,
      currency: c.currency || null,
      options: kind === 'choice' ? (meta.options || STATUS_VALUES) : null,
      // Pre-fill just above the threshold so the first run takes the interesting
      // branch rather than the boring one.
      suggested: suggestValue(c, kind),
      // Sentence-cased once here rather than lowercased at the call site, so
      // "USD" does not come out as "usd".
      testedAs: `${meta.objectLabel} ${meta.label.toLowerCase()} ${describeOperator(c.operator, kind)} ${formatValue(c)}`
    });
  }
  return { fields, decisions };
}

function suggestValue(c, kind) {
  if (kind === 'currency' || kind === 'number') {
    const v = Number(c.value) || 0;
    if (c.operator === 'gt' || c.operator === 'gte') return Math.round(v * 1.2) || 1;
    if (c.operator === 'lt' || c.operator === 'lte') return Math.round(v * 0.8);
    return v;
  }
  return typeof c.value === 'string' ? c.value : '';
}

function formatValue(c) {
  if (c.valueType === 'money' || c.valueType === 'number') {
    return `${Number(c.value).toLocaleString('en-US')}${c.currency ? ' ' + c.currency : ''}`;
  }
  return String(c.value);
}

/* ------------------------------------------------------------------ */
/* evaluation                                                          */
/* ------------------------------------------------------------------ */

function compare(operator, left, right) {
  const bothNumeric = Number.isFinite(Number(left)) && Number.isFinite(Number(right));
  if (bothNumeric) {
    const a = Number(left);
    const b = Number(right);
    switch (operator) {
      case 'gt': return a > b;
      case 'gte': return a >= b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'eq': return a === b;
      case 'neq': return a !== b;
      default: return null;
    }
  }
  const a = String(left).trim().toLowerCase();
  const b = String(right).trim().toLowerCase();
  switch (operator) {
    case 'eq': return a === b;
    case 'neq': return a !== b;
    default: return null;
  }
}

/**
 * Evaluate one gateway against the supplied values.
 * @returns {{result: boolean|null, sentence: string, missing: string|null}}
 */
export function evaluateCondition(condition, inputs) {
  if (condition.unresolved) {
    return { result: null, missing: null, sentence: 'This decision was never given a testable condition.' };
  }
  const supplied = inputs[condition.subject];
  if (supplied === undefined || supplied === null || supplied === '') {
    return { result: null, missing: condition.subject, sentence: `No test value was given for ${describeField(condition.subject).label}.` };
  }

  let result = compare(condition.operator, supplied, condition.value);
  if (result === null) {
    return { result: null, missing: null, sentence: `Cannot compare "${supplied}" using "${condition.operator}".` };
  }
  if (condition.negated) result = !result;

  const meta = describeField(condition.subject);
  const shown = meta.kind === 'currency' && Number.isFinite(Number(supplied))
    ? Number(supplied).toLocaleString('en-US') + (condition.currency ? ' ' + condition.currency : '')
    : String(supplied);

  return {
    result,
    missing: null,
    sentence: `${meta.label} is ${shown}, which ${result ? 'does' : 'does not'} satisfy ${OP_TEXT[condition.operator] || condition.operator} ${formatValue(condition)}${condition.negated ? ' (negated)' : ''}.`
  };
}

/* ------------------------------------------------------------------ */
/* the walk                                                            */
/* ------------------------------------------------------------------ */

const MAX_VISITS = 3;
const MAX_STEPS = 200;

/**
 * Walk the workflow with the given values.
 *
 * @param {object} workflow
 * @param {object} inputs   { 'invoice.amount': 6000, 'n1.then.outcome': 'Rejected' }
 * @returns {{status, steps, path, edgePath, missing, summary}}
 */
export function simulate(workflow, inputs = {}) {
  const byId = new Map(workflow.nodes.map(n => [n.id, n]));
  const outgoing = new Map(workflow.nodes.map(n => [n.id, []]));
  for (const e of workflow.edges) outgoing.get(e.from)?.push(e);

  const steps = [];
  const path = [];
  const edgePath = [];
  const visits = new Map();
  const missing = new Set();

  let current = byId.get('n_start');
  let status = 'complete';

  while (current) {
    if (steps.length >= MAX_STEPS) { status = 'runaway'; break; }

    const count = (visits.get(current.id) || 0) + 1;
    visits.set(current.id, count);
    path.push(current.id);

    const step = {
      nodeId: current.id,
      name: current.name,
      type: current.type,
      lane: workflow.participants.find(p => p.id === current.lane)?.name || current.lane,
      performer: current.performer?.name || null,
      note: narrateNode(current),
      repeat: count > 1 ? count : null
    };

    if (count > MAX_VISITS) {
      step.note = `Reached for the ${ordinal(count)} time. With the same decision each time this would loop forever, so the simulation stops here.`;
      step.terminalReason = 'loop';
      steps.push(step);
      status = 'loop';
      break;
    }

    const edges = outgoing.get(current.id) || [];

    if (current.type === 'end' || current.type === 'end.terminate') {
      step.terminalReason = current.type === 'end.terminate' ? 'stopped' : 'finished';
      steps.push(step);
      status = current.type === 'end.terminate' ? 'terminated' : 'complete';
      break;
    }

    if (!edges.length) {
      step.terminalReason = 'dead-end';
      steps.push(step);
      status = 'stuck';
      break;
    }

    let chosen = edges[0];

    if (current.type === 'gateway.exclusive' && current.condition) {
      const verdict = evaluateCondition(current.condition, inputs);
      if (verdict.missing) {
        missing.add(verdict.missing);
        step.note = verdict.sentence;
        step.terminalReason = 'needs-input';
        steps.push(step);
        status = 'needs-input';
        break;
      }
      if (verdict.result === null) {
        step.note = verdict.sentence;
        step.terminalReason = 'unevaluable';
        steps.push(step);
        status = 'blocked';
        break;
      }
      const wanted = verdict.result ? 'true' : 'false';
      chosen = edges.find(e => e.guard === wanted) || edges.find(e => !e.guard) || edges[0];
      step.decision = verdict.result;

      // An approval outcome reads better as a person's choice than as a
      // comparison against a string literal.
      const decidedBy = workflow.nodes.find(n => n.outcomeGatewayId === current.id);
      step.note = decidedBy
        ? `${decidedBy.performer?.name || 'The approver'} chose "${inputs[current.condition.subject]}", so the process takes the "${chosen.label}" path.`
        : `${verdict.sentence} Taking the "${chosen.label || (verdict.result ? 'yes' : 'no')}" path.`;
    } else if (edges.length > 1) {
      // Parallel or unguarded fan-out: follow the first branch and say so.
      step.note = `${step.note} More than one path leaves this step; the simulation follows "${chosen.label || 'the first'}".`;
    }

    steps.push(step);
    edgePath.push(chosen.id);
    current = byId.get(chosen.to);
  }

  return {
    status,
    steps,
    path,
    edgePath,
    missing: [...missing],
    summary: summarise(status, steps, workflow)
  };
}

function ordinal(n) {
  return n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;
}

/**
 * One plain sentence describing what a node does.
 * Exported because the Blueprint inspector shows the same wording — a step
 * should not be described one way in the simulator and another way when you
 * click it.
 */
export function narrateNode(node) {
  switch (node.type) {
    case 'event.start':
    case 'event.start.message':
      return node.triggerEvent?.source && node.triggerEvent.source !== 'manual'
        ? `The process starts when ${node.triggerEvent.source} reports a record was ${node.triggerEvent.event}.`
        : 'The process starts.';
    case 'gateway.exclusive':
      return 'A decision is made here.';
    case 'gateway.merge':
      return 'The branches come back together.';
    case 'task.approval':
      return `${node.performer?.name || 'Someone'} is asked to approve${node.sla?.durationSeconds ? `, within ${humanDuration(node.sla.durationSeconds)}` : ''}.`;
    case 'task.review':
      return `${node.performer?.name || 'Someone'} reviews it.`;
    case 'task.notify':
      return `A notification goes to ${(node.recipients || []).map(r => r.name).join(', ') || 'the recipient'}.`;
    case 'task.data.write':
      return `The record is written to ${node.operation?.connector || 'the system of record'}${node.retry ? `, retrying up to ${node.retry.maxAttempts} times if it fails` : ''}.`;
    case 'task.data.read':
      return `${node.operation?.connector || 'The system'} is checked.`;
    case 'task.create':
      return `A new record is created in ${node.operation?.connector || 'the system'}.`;
    case 'task.assign':
      return `The work is routed to ${node.performer?.name || 'someone'}.`;
    case 'task.audit':
      return 'An audit record of the decision is written.';
    case 'end.terminate':
      return 'The process stops here.';
    case 'end':
      return 'The process finishes.';
    default:
      return node.name;
  }
}

export function humanDuration(sec) {
  if (sec % 86400 === 0) return `${sec / 86400} day${sec / 86400 === 1 ? '' : 's'}`;
  if (sec % 3600 === 0) return `${sec / 3600} hour${sec / 3600 === 1 ? '' : 's'}`;
  return `${Math.round(sec / 60)} minutes`;
}

function summarise(status, steps, workflow) {
  const humanSteps = steps.filter(s => s.type === 'task.approval' || s.type === 'task.review').length;
  const systemSteps = steps.filter(s => s.type.startsWith('task.data') || s.type === 'task.create').length;
  const tail = steps[steps.length - 1];

  switch (status) {
    case 'complete':
      return `The process ran to completion in ${steps.length} steps — ${humanSteps} needing a person, ${systemSteps} touching a system.`;
    case 'terminated':
      return `The process stopped early at "${tail?.name}". This is a designed stop, not a fault.`;
    case 'loop':
      return `The process came back to "${tail?.name}" repeatedly. That is the rework loop working — in real life the requester would change something before resubmitting.`;
    case 'needs-input':
      return `Stopped at "${tail?.name}" because a test value is missing. Fill it in above and run again.`;
    case 'blocked':
      return `Stopped at "${tail?.name}" — this decision has no condition the engine can evaluate. Answer its clarifying question first.`;
    case 'stuck':
      return `Stopped at "${tail?.name}" because nothing follows it. That is a defect in the workflow, not in your test values.`;
    default:
      return `The walk exceeded ${MAX_STEPS} steps and was stopped.`;
  }
}
