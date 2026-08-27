/**
 * compiler.js — IR → workflow graph conforming to schema/workflow.v1.schema.json.
 *
 * The compiler is pure: compile(parsed, resolutions) always returns the same
 * graph for the same inputs. That matters because the clarification loop works
 * by adding entries to `resolutions` and recompiling from scratch — there is no
 * mutable half-edited workflow anywhere, so a wrong answer is undone by
 * removing it rather than by unwinding a patch.
 */

import { ROLES, CONNECTORS, OBJECTS, REGULATED_CUES } from './lexicon.js';
import { policyFor, slaFor } from './resilience.js';

export const SCHEMA_VERSION = '1.0.0';
export const ENGINE_LANE = 'sys_engine';

/** Human-readable verbs per node type, used to build canonical step names. */
const VERB = {
  'task.approval': 'Obtain', 'task.review': 'Review', 'task.notify': 'Send',
  'task.data.write': 'Write', 'task.data.read': 'Look up', 'task.create': 'Create',
  'task.assign': 'Assign', 'task.transform': 'Transform', 'task.terminate': 'Close out',
  'event.timer': 'Wait', 'task.generic': 'Do'
};

const OP_BY_TYPE = {
  'task.data.write': 'record.insert',
  'task.data.read': 'record.query',
  'task.create': 'record.create',
  'task.notify': 'message.send',
  'task.assign': 'task.assign'
};

const OPERATORS = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '==', neq: '!=' };

/* ------------------------------------------------------------------ */

function titleCase(s) {
  return String(s).replace(/\b[a-z]/g, c => c.toUpperCase());
}

function fmtMoney(v) {
  if (v == null) return '';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Render a condition as the label that goes on the diamond. */
export function conditionLabel(cond) {
  if (!cond || cond.unresolved) return `${cond?.raw || 'Condition'}?`;
  const rhs = cond.valueType === 'money'
    ? `${fmtMoney(cond.value)} ${cond.currency || '???'}`
    : cond.valueType === 'duration' ? `${cond.value / 3600} h`
    : cond.valueType === 'percent' ? `${cond.value}%`
    : String(cond.value);
  return `${cond.subject} ${OPERATORS[cond.operator] || cond.operator} ${rhs}?`;
}

/** Build the display name for an action node from its parts. */
function stepName(spec, role, conn) {
  const type = spec.frame.type;
  const objName = spec.object ? spec.object.name : null;

  switch (type) {
    case 'task.approval':
      return role ? `Obtain ${role.name} approval` : 'Obtain approval';
    case 'task.review':
      return role ? `${role.name} reviews ${objName || 'the item'}` : `Review ${objName || 'the item'}`;
    case 'task.notify': {
      const to = role?.name || conn?.name;
      return `Send ${objName || 'notification'}${to ? ` to ${to}` : ''}`;
    }
    case 'task.data.write':
      return `Log ${objName || 'record'}${conn ? ` in ${conn.name}` : ''}`;
    case 'task.data.read':
      return `Check ${objName || 'record'}${conn ? ` in ${conn.name}` : ''}`;
    case 'task.create':
      return `Create ${objName || 'record'}${conn ? ` in ${conn.name}` : ''}`;
    case 'task.assign':
      return `Route ${objName || 'item'}${role ? ` to ${role.name}` : ''}`;
    case 'event.timer':
      return `Wait ${spec.duration?.raw || ''}`.trim();
    case 'task.terminate':
      return `Close ${objName || 'the case'}`;
    default:
      return titleCaseFirst(spec.text);
  }
}

function titleCaseFirst(s) {
  const t = String(s).trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/* ------------------------------------------------------------------ */
/* graph builder                                                       */
/* ------------------------------------------------------------------ */

class Graph {
  constructor() {
    this.nodes = [];
    this.edges = [];
    this.participants = new Map();
    this.connectors = new Map();
    this.variables = new Map();
    this._edgeSeq = 0;
  }

  addNode(node) { this.nodes.push(node); return node; }

  connect(from, to, opts = {}) {
    if (!from || !to) return null;
    const edge = {
      id: `e${++this._edgeSeq}`,
      from: typeof from === 'string' ? from : from.id,
      to: typeof to === 'string' ? to : to.id,
      label: opts.label ?? null,
      guard: opts.guard ?? null
    };
    this.edges.push(edge);
    return edge;
  }

  participant(id, name, kind, lane) {
    if (!this.participants.has(id)) this.participants.set(id, { id, name, kind, lane: lane || name });
    return this.participants.get(id);
  }

  connector(entry, operation) {
    if (!this.connectors.has(entry.id)) {
      this.connectors.set(entry.id, {
        id: entry.id, name: entry.name, category: entry.category,
        operations: [], status: entry.status || 'unregistered'
      });
    }
    const c = this.connectors.get(entry.id);
    if (operation && !c.operations.includes(operation)) c.operations.push(operation);
    return c;
  }

  variable(v) {
    if (!v?.path || v.path === 'UNRESOLVED') return;
    const existing = this.variables.get(v.path);
    if (!existing) this.variables.set(v.path, v);
    else if (v.currency && !existing.currency) existing.currency = v.currency;
  }
}

/* ------------------------------------------------------------------ */

/** Where does this step happen? Drives the swimlane. */
function assignLane(g, type, role, conn) {
  if (type === 'task.approval' || type === 'task.review' || type === 'task.assign') {
    if (role) {
      g.participant(role.id, role.name, 'role', role.lane);
      return { lane: role.id, performer: { kind: 'role', id: role.id, name: role.name } };
    }
    g.participant('role_unassigned', 'Unassigned', 'role', 'Unassigned');
    return { lane: 'role_unassigned', performer: { kind: 'role', id: null, name: null } };
  }

  if (conn && type !== 'task.notify') {
    g.participant(conn.id, conn.name, 'system', conn.name);
    return { lane: conn.id, performer: { kind: 'system', id: conn.id, name: conn.name } };
  }

  g.participant(ENGINE_LANE, 'Automation Engine', 'engine', 'Automation Engine');
  return { lane: ENGINE_LANE, performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' } };
}

/** Build one task node from an action spec. */
function buildTask(g, spec, id, resolutions) {
  const type = spec.frame.type;

  // A clarifying answer supplies what the sentence left out. Without this the
  // question would be asked forever: the validator would keep finding the same
  // gap because the compiler never read the answer.
  const roleAnswer = resolutions[`assignee:${id}`];
  const connAnswer = resolutions[`connector:${id}`];
  const role = spec.roles[0] || (roleAnswer ? ROLES.find(r => r.id === roleAnswer.roleId) : null);
  const conn = spec.connectors[0] || (connAnswer ? CONNECTORS.find(c => c.id === connAnswer.connectorId) : null);

  const { lane, performer } = assignLane(g, type, role, conn);

  let operation = null;
  let resilience = null;
  if (conn) {
    const op = OP_BY_TYPE[type] || conn.defaultOp;
    g.connector(conn, op);
    // Failure behaviour is attached up front rather than left blank. A step
    // with no policy silently drops a record on the first timeout; a
    // conservative default is strictly better, and the validator still asks
    // the user to confirm it.
    resilience = policyFor(conn, op, id, {
      ...(resolutions[`retry:${id}`] || {}),
      ...(resolutions[`dedupe:${id}`] || {})
    });
    const compensation = resolutions['compensation:strategy'];
    if (compensation) {
      resilience.compensation = { ...resilience.compensation, configured: true, strategy: compensation.strategy };
    }
    operation = {
      connectorId: conn.id,
      connector: conn.name,
      operation: op,
      // The payload is a declared contract, not a captured API response.
      payload: buildPayload(spec, resilience)
    };
  }

  const recipients = type === 'task.notify'
    ? spec.roles.map(r => { g.participant(r.id, r.name, 'role', r.lane); return { id: r.id, name: r.name, kind: 'role' }; })
    : [];
  const sourcedFrom = [roleAnswer && 'assignee', connAnswer && 'connector'].filter(Boolean);

  const slaAnswer = resolutions[`sla:${id}`];
  const isHumanStep = type === 'task.approval' || type === 'task.review';

  const node = {
    id,
    type,
    name: stepName(spec, role, conn),
    lane,
    performer,
    object: spec.object ? spec.object.name : null,
    operation,

    sla: slaAnswer
      ? { durationSeconds: slaAnswer.seconds, businessDays: !!slaAnswer.businessDays, onBreach: slaAnswer.onBreach || 'escalate', escalateTo: slaAnswer.escalateTo || null, source: 'clarified' }
      : spec.duration
        ? { durationSeconds: spec.duration.seconds, businessDays: spec.duration.businessDays, onBreach: 'escalate', escalateTo: null, source: 'utterance' }
        // A default deadline so the blueprint is never silent about time. It is
        // a guess at policy, not a standard, so R-NO-SLA still asks.
        : isHumanStep ? slaFor(role) : null,
    retry: resilience ? resilience.retry : null,
    timeoutSeconds: resilience ? resilience.timeoutSeconds : null,
    circuitBreaker: resilience ? resilience.circuitBreaker : null,
    idempotency: resilience ? resilience.idempotency : null,
    compensation: resilience ? resilience.compensation : null,
    trace: {
      clause: spec.text,
      cue: spec.frame.cue,
      inferredObject: !!spec.objectInherited,
      ...(sourcedFrom.length ? { clarified: sourcedFrom } : {})
    }
  };

  if (recipients.length) node.recipients = recipients;

  if (type === 'event.timer' && spec.duration) {
    node.timer = { durationSeconds: spec.duration.seconds, businessDays: spec.duration.businessDays };
  }
  return g.addNode(node);
}

/** The JSON body the connector call would carry. */
function buildPayload(spec, resilience) {
  const obj = spec.object;
  const fields = {};
  if (obj) {
    fields.objectType = obj.name;
    fields.objectId = `{{${obj.id.replace('obj_', '')}.id}}`;
    if (obj.amountField) fields.amount = `{{${obj.amountField}}}`;
  }
  fields.correlationId = '{{workflow.correlationId}}';
  fields.emittedBy = '{{workflow.id}}';
  // Without this a retry of a non-idempotent write posts the record twice.
  if (resilience?.idempotency?.keyRequired) {
    fields.idempotencyKey = resilience.idempotency.key;
  }
  return fields;
}

/** Normalise a parsed test + resolutions into the condition object. */
function buildCondition(spec, gatewayId, resolutions) {
  const test = spec.test;
  if (test.unresolved) {
    const answer = resolutions[`predicate:${gatewayId}`];
    if (!answer) {
      return { unresolved: true, raw: test.raw, reason: test.reason };
    }
    return {
      unresolved: false, subject: answer.subject, operator: answer.operator,
      value: answer.value, valueType: answer.valueType || 'string',
      currency: answer.currency || null, negated: !!spec.negated, source: 'clarified'
    };
  }

  const chosen = resolutions[`subject:${gatewayId}`];
  const subject = chosen?.path || spec.subject.path;
  const currency = resolutions[`currency:${gatewayId}`]?.currency
    ?? test.value?.currency ?? null;

  // "over 10k" is money with the unit left off; "over 5" is a count. Only the
  // first deserves a currency question, so a magnitude suffix or a subject that
  // resolves to a known amount field is required before the flag is set.
  const subjectIsMonetary = OBJECTS.some(o => o.amountField && o.amountField === subject);
  const currencyMissing = !!test.value?.currencyInferred
    && (test.value?.magnitude || subjectIsMonetary)
    && !resolutions[`currency:${gatewayId}`];

  return {
    unresolved: false,
    subject,
    subjectInferred: chosen ? false : !!spec.subject.inferred,
    operator: test.operator,
    value: test.value?.value ?? null,
    valueType: currencyMissing || currency ? 'money' : (test.value?.kind ?? 'literal'),
    currency,
    currencyInferred: currencyMissing,
    negated: !!spec.negated,
    raw: test.raw,
    source: chosen || resolutions[`currency:${gatewayId}`] ? 'clarified' : 'parsed'
  };
}

/**
 * Place a task and return the node the flow should continue from.
 *
 * An approval has two real-world outcomes, but a sentence like "get CFO
 * approval" only describes one of them. Once the user answers the rejection
 * question, the outcome gateway is materialised here.
 */
function placeTask(g, spec, ids, resolutions) {
  const task = buildTask(g, spec, ids.base, resolutions);
  if (task.type !== 'task.approval' && task.type !== 'task.review') return { entry: task, exit: task, extra: [] };

  const answer = resolutions[`reject:${task.id}`];
  if (!answer) return { entry: task, exit: task, extra: [] };

  const gate = g.addNode({
    id: `${ids.base}.outcome`, type: 'gateway.exclusive',
    name: `${task.performer?.name || 'Approver'} approved?`,
    lane: task.lane, performer: task.performer,
    condition: { unresolved: false, subject: `${task.id}.outcome`, operator: 'eq', value: 'approved', valueType: 'literal', source: 'clarified' },
    // The rejection question just answered *is* the negative branch, so
    // R-ELSE must not ask about this gateway again.
    branches: { positive: 'Approved', negative: 'Rejected', elseHandled: true },
    trace: { clause: null, from: 'clarification' }
  });
  g.connect(task, gate);

  if (answer.action === 'terminate') {
    const stop = g.addNode({
      id: `${ids.base}.rejected`, type: 'end.terminate', name: 'Rejected — process ends',
      lane: task.lane, performer: task.performer, trace: { clause: null, from: 'clarification' }
    });
    g.connect(gate, stop, { label: 'Rejected', guard: 'false' });
  } else if (answer.action === 'return') {
    const revise = g.addNode({
      id: `${ids.base}.revise`, type: 'task.assign', name: `Return to ${answer.returnTo || 'requester'} for revision`,
      lane: 'role_requester', performer: { kind: 'role', id: 'role_requester', name: answer.returnTo || 'Requester' },
      trace: { clause: null, from: 'clarification' }
    });
    g.participant('role_requester', answer.returnTo || 'Requester', 'role', answer.returnTo || 'Requester');
    g.connect(gate, revise, { label: 'Rejected', guard: 'false' });
    const back = g.connect(revise, task, { label: 'Resubmit' });
    if (back) back.back = true;
  } else if (answer.action === 'escalate') {
    const esc = g.addNode({
      id: `${ids.base}.escalation`, type: 'task.approval', name: `Escalate to ${answer.escalateTo || 'next level'}`,
      lane: task.lane, performer: task.performer, trace: { clause: null, from: 'clarification' }
    });
    g.connect(gate, esc, { label: 'Rejected', guard: 'false' });
    g.connect(esc, gate, { label: 'Re-decide' }).back = true;
  }

  gate.branches.rejectionHandled = true;
  task.outcomeGatewayId = gate.id;
  return { entry: task, exit: gate, extra: [] };
}

/* ------------------------------------------------------------------ */

/**
 * Compile a parse result into a workflow graph.
 * @param {object} parsed  result of parser.parse()
 * @param {object} resolutions  answers from the clarification loop
 */
export function compile(parsed, resolutions = {}) {
  const g = new Graph();
  const specs = parsed.specs;

  const trigger = specs.find(s => s.kind === 'trigger');
  trigger?.connectors?.forEach(c => g.connector(c, 'event.subscribe'));

  const start = g.addNode({
    id: 'n_start',
    type: trigger ? 'event.start.message' : 'event.start',
    name: trigger ? titleCaseFirst(trigger.text) : 'Workflow triggered',
    lane: ENGINE_LANE,
    performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
    triggerEvent: trigger ? { event: trigger.event, source: trigger.connectors[0]?.name || 'manual', object: trigger.objects[0]?.name || null } : { event: 'manual', source: 'manual', object: null },
    trace: trigger
      ? { clause: trigger.text }
      : { clause: null, from: 'structure' }
  });
  g.participant(ENGINE_LANE, 'Automation Engine', 'engine', 'Automation Engine');

  /** open tails waiting to be wired into the next step */
  let tails = [{ node: start, label: null }];
  let lastGateway = null;
  // Node ids are derived from clause position, not from a running counter, so
  // that answering a question (which inserts nodes) never renumbers the nodes
  // other answers are keyed to.
  let specIndex = 0;

  const attach = node => {
    tails.forEach(t => g.connect(t.node, node, { label: t.label, guard: t.guard }));
    tails = [{ node, label: null }];
  };

  for (const spec of specs) {
    if (spec.kind === 'trigger') continue;
    const base = `n${++specIndex}`;

    if (spec.kind === 'action') {
      const placed = placeTask(g, spec, { base }, resolutions);
      tails.forEach(t => g.connect(t.node, placed.entry, { label: t.label, guard: t.guard }));
      tails = [{ node: placed.exit, label: placed.exit.type === 'gateway.exclusive' ? placed.exit.branches.positive : null, guard: placed.exit.type === 'gateway.exclusive' ? 'true' : null }];
      continue;
    }

    if (spec.kind === 'condition') {
      const gid = base;
      const condition = buildCondition(spec, gid, resolutions);
      if (condition.subject) g.variable({
        path: condition.subject,
        type: condition.valueType === 'money' ? 'currency' : condition.valueType === 'percent' ? 'number' : condition.valueType,
        // Only present when known — an absent key is honest, `undefined` is not.
        ...(condition.currency ? { currency: condition.currency } : {}),
        source: 'condition',
        inferred: !!condition.subjectInferred
      });

      const gateway = g.addNode({
        id: gid,
        type: 'gateway.exclusive',
        name: conditionLabel(condition),
        lane: ENGINE_LANE,
        performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
        condition,
        trace: {
          clause: spec.text,
          hoisted: spec.hoistedFrom != null,
          // Carried through so the validator can offer the alternatives it saw.
          candidates: spec.subject?.candidates || null,
          subjectRaw: spec.subject?.raw || null
        }
      });
      attach(gateway);

      const yesLabel = spec.negated ? 'No' : 'Yes';
      const noLabel = spec.negated ? 'Yes' : 'No';

      const branchTails = [];
      if (spec.action) {
        const placed = placeTask(g, spec.action, { base: `${base}.then` }, resolutions);
        g.connect(gateway, placed.entry, { label: yesLabel, guard: 'true' });
        branchTails.push(placed.exit.type === 'gateway.exclusive'
          ? { node: placed.exit, label: placed.exit.branches.positive, guard: 'true' }
          : { node: placed.exit, label: null });
      } else {
        branchTails.push({ node: gateway, label: yesLabel, guard: 'true' });
      }

      // The negative path stays open until an `else` clause claims it, or the
      // merge closes it. `elseOpen` is what rule R-ELSE reports on.
      const elseAnswer = resolutions[`else:${gid}`];
      let negativeTail = { node: gateway, label: noLabel, guard: 'false' };

      if (elseAnswer?.action === 'terminate') {
        const stop = g.addNode({
          id: `${base}.stop`, type: 'end.terminate',
          name: elseAnswer.name || 'Stop — condition not met',
          lane: ENGINE_LANE, performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
          trace: { clause: null, from: 'clarification' }
        });
        g.connect(gateway, stop, { label: noLabel, guard: 'false' });
        negativeTail = null;
      }

      const merge = g.addNode({
        id: `${base}.merge`, type: 'gateway.merge', name: 'Merge',
        lane: ENGINE_LANE, performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
        trace: { clause: null, from: 'structure' }
      });
      branchTails.forEach(t => g.connect(t.node, merge, { label: t.label, guard: t.guard }));
      if (negativeTail) g.connect(negativeTail.node, merge, { label: negativeTail.label, guard: negativeTail.guard });

      gateway.branches = { positive: yesLabel, negative: noLabel, mergeId: merge.id, elseHandled: !!elseAnswer || false };
      lastGateway = gateway;
      tails = [{ node: merge, label: null }];
      continue;
    }

    if (spec.kind === 'else') {
      if (!lastGateway || !spec.action) continue;
      const node = buildTask(g, spec.action, base, resolutions);
      // Re-route the gateway's negative edge through the else branch.
      const negEdge = g.edges.find(e => e.from === lastGateway.id && e.guard === 'false');
      if (negEdge) {
        const mergeId = negEdge.to;
        negEdge.to = node.id;
        g.connect(node, mergeId, { label: null });
      } else {
        g.connect(lastGateway, node, { label: lastGateway.branches.negative, guard: 'false' });
        g.connect(node, lastGateway.branches.mergeId, { label: null });
      }
      lastGateway.branches.elseHandled = true;
      lastGateway.branches.elseNodeId = node.id;
      continue;
    }
  }

  // Optional audit step, inserted only when the compliance question is answered.
  if (resolutions['audit:insert']?.enabled) {
    const sink = resolutions['audit:insert'].sink || 'Audit Ledger';
    // The audit write is an external call like any other, so it gets the same
    // failure policy. A dropped audit record is exactly the kind of silent gap
    // this rule existed to close.
    const auditPolicy = policyFor(
      { id: 'sys_audit', name: sink, category: 'warehouse' },
      'ledger.append',
      'n_audit',
      resolutions['retry:n_audit']
    );
    const auditNode = g.addNode({
      id: 'n_audit', type: 'task.audit',
      name: `Write immutable audit record${resolutions['audit:insert'].sink ? ` to ${sink}` : ''}`,
      lane: ENGINE_LANE, performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
      operation: {
        connectorId: 'sys_audit', connector: sink,
        operation: 'ledger.append',
        payload: {
          workflowId: '{{workflow.id}}', correlationId: '{{workflow.correlationId}}',
          actor: '{{step.performer}}', decision: '{{step.outcome}}', prevHash: '{{ledger.head}}',
          idempotencyKey: auditPolicy.idempotency.key
        }
      },
      retry: auditPolicy.retry,
      timeoutSeconds: auditPolicy.timeoutSeconds,
      circuitBreaker: auditPolicy.circuitBreaker,
      idempotency: auditPolicy.idempotency,
      compensation: auditPolicy.compensation,
      trace: { clause: null, from: 'clarification' }
    });
    attach(auditNode);
  }

  const end = g.addNode({
    id: 'n_end', type: 'end', name: 'Process complete',
    lane: ENGINE_LANE, performer: { kind: 'engine', id: ENGINE_LANE, name: 'Automation Engine' },
    trace: { clause: null, from: 'structure' }
  });
  attach(end);

  const regimes = detectRegimes(parsed.utterance, g);

  return {
    schemaVersion: SCHEMA_VERSION,
    workflowId: workflowIdFor(parsed.utterance),
    name: deriveName(parsed, g),
    source: {
      utterance: parsed.utterance,
      clauses: parsed.clauses,
      parser: 'text2workflow-grammar/1.0',
      deterministic: true
    },
    participants: orderParticipants([...g.participants.values()], g.nodes),
    connectors: [...g.connectors.values()],
    variables: [...g.variables.values()],
    nodes: g.nodes,
    edges: g.edges,
    governance: {
      regulatoryScope: regimes,
      auditTrail: {
        enabled: true,
        mode: 'hash-chained-append-only',
        algorithm: 'SHA-256',
        // Every state change is recorded; no API is exposed to mutate or delete.
        mutableByOperators: false,
        explicitAuditStep: g.nodes.some(n => n.type === 'task.audit')
      }
    },
    resolutions
  };
}

function detectRegimes(utterance, g) {
  const lower = utterance.toLowerCase();
  const found = new Set();
  for (const cue of REGULATED_CUES) if (lower.includes(cue.term)) found.add(cue.regime);
  const touchesMoney = g.nodes.some(n => n.object && OBJECTS.find(o => o.name === n.object)?.money);
  if (touchesMoney) found.add('financial-controls');
  const touchesPii = g.nodes.some(n => n.object && OBJECTS.find(o => o.name === n.object)?.pii);
  if (touchesPii) found.add('PII');
  return [...found];
}

function orderParticipants(list, nodes) {
  // Lane order: humans first (in order of first use), engine, then systems.
  const firstUse = new Map();
  nodes.forEach((n, i) => { if (!firstUse.has(n.lane)) firstUse.set(n.lane, i); });
  const rank = p => (p.kind === 'role' ? 0 : p.kind === 'engine' ? 1 : 2);
  return list.sort((a, b) => rank(a) - rank(b) || (firstUse.get(a.id) ?? 999) - (firstUse.get(b.id) ?? 999));
}

function deriveName(parsed, g) {
  const obj = g.nodes.map(n => n.object).find(Boolean);
  const hasApproval = g.nodes.some(n => n.type === 'task.approval');
  const base = obj ? titleCase(obj) : 'Business Process';
  return hasApproval ? `${base} Approval Workflow` : `${base} Automation`;
}

/** Stable id so the same sentence always yields the same workflow id. */
function workflowIdFor(utterance) {
  let h = 2166136261;
  for (let i = 0; i < utterance.length; i++) {
    h ^= utterance.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'wf_' + (h >>> 0).toString(16).padStart(8, '0');
}

export const __internals = { stepName, buildPayload, workflowIdFor, detectRegimes };
