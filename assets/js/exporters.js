/**
 * exporters.js — the compiled graph in the formats other tools want.
 *
 * The workflow JSON is the source of truth; every export below is derived from
 * it, so the diagram a BA signs off and the JSON an integrator implements
 * cannot drift apart.
 */

import { camundaRetryCycle } from './exporters-runtime.js';

const OPERATORS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };

const MERMAID_SHAPE = {
  'gateway.exclusive': (id, label) => `${id}{"${label}"}`,
  'gateway.merge': (id) => `${id}{" "}`,
  'event.start': (id, label) => `${id}(["${label}"])`,
  'event.start.message': (id, label) => `${id}(["${label}"])`,
  'end': (id, label) => `${id}(["${label}"])`,
  'end.terminate': (id, label) => `${id}(["${label}"])`
};

/**
 * Escape for an XML attribute value.
 *
 * The ampersand must go first or it would double-escape the entities added
 * after it. This matters more than it looks: a gateway is named
 * `invoice.amount > 10,000 USD?`, and an unescaped `>` closes the tag early
 * and produces XML no modeller can open.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\r\n]+/g, ' ');
}

/** Mermaid labels are quoted strings, not XML — they need different escaping. */
function mesc(s) {
  return String(s).replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

function safeId(id) {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Mermaid flowchart, grouped into subgraphs so the lanes survive. */
export function toMermaid(wf) {
  const lines = ['flowchart LR'];
  const used = new Set(wf.nodes.map(n => n.lane));

  for (const p of wf.participants.filter(p => used.has(p.id))) {
    lines.push(`  subgraph ${safeId(p.id)}["${mesc(p.name)}"]`);
    lines.push('    direction LR');
    for (const n of wf.nodes.filter(n => n.lane === p.id)) {
      const shape = MERMAID_SHAPE[n.type];
      lines.push('    ' + (shape ? shape(safeId(n.id), mesc(n.name)) : `${safeId(n.id)}["${mesc(n.name)}"]`));
    }
    lines.push('  end');
  }

  for (const e of wf.edges) {
    const arrow = e.back ? '-.->' : '-->';
    lines.push(`  ${safeId(e.from)} ${arrow}${e.label ? `|${mesc(e.label)}|` : ''} ${safeId(e.to)}`);
  }
  return lines.join('\n');
}

/**
 * The Schema Dictionary: one row per clause, showing the phrase, what it was
 * recognised as, and the exact backend call it maps to. This is the artefact a
 * BA hands an integrator.
 */
export function toSchemaDictionary(wf) {
  const rows = [];
  for (const n of wf.nodes) {
    if (n.type === 'gateway.merge') continue;
    const phrase = n.trace?.clause || null;
    rows.push({
      nodeId: n.id,
      phrase,
      origin: phrase ? 'utterance' : (n.trace?.from === 'clarification' ? 'clarification' : 'structure'),
      recognisedAs: n.type,
      performer: n.performer?.name || '—',
      binding: bindingFor(n),
      contract: contractFor(n)
    });
  }
  return rows;
}

function bindingFor(n) {
  if (n.condition && !n.condition.unresolved) {
    const rhs = n.condition.valueType === 'money'
      ? `${Number(n.condition.value).toLocaleString('en-US')} ${n.condition.currency || '???'}`
      : String(n.condition.value);
    return `${n.condition.subject} ${OPERATORS[n.condition.operator] || n.condition.operator} ${rhs}`;
  }
  if (n.condition?.unresolved) return `UNRESOLVED: ${n.condition.raw}`;
  if (n.operation) return `${n.operation.connector}.${n.operation.operation}`;
  if (n.triggerEvent) return `${n.triggerEvent.source}:${n.triggerEvent.event}`;
  if (n.recipients?.length) return `notify → ${n.recipients.map(r => r.name).join(', ')}`;
  if (n.performer?.kind === 'role' && n.performer.id) return `humanTask.assign(${n.performer.id})`;
  return '—';
}

function contractFor(n) {
  if (n.operation) {
    return {
      method: 'POST',
      endpoint: `/connectors/${n.operation.connectorId}/${n.operation.operation.replace(/\./g, '/')}`,
      body: n.operation.payload,
      retry: n.retry || null
    };
  }
  if (n.type === 'task.approval' || n.type === 'task.review') {
    return {
      method: 'POST',
      endpoint: '/tasks/human',
      body: {
        assignee: n.performer?.id || null,
        subject: n.name,
        dueInSeconds: n.sla?.durationSeconds ?? null,
        onBreach: n.sla?.onBreach ?? null,
        outcomes: n.outcomeGatewayId ? ['approved', 'rejected'] : ['approved']
      },
      retry: null
    };
  }
  if (n.type === 'task.notify') {
    return {
      method: 'POST',
      endpoint: '/notifications/send',
      body: {
        recipients: (n.recipients || []).map(r => r.id),
        channel: n.operation?.connector ?? 'default',
        subject: n.name,
        correlationId: '{{workflow.correlationId}}'
      },
      retry: n.retry || null
    };
  }
  if (n.type === 'gateway.exclusive') {
    return {
      method: 'EVAL',
      endpoint: '/engine/decide',
      body: { expression: bindingFor(n), onTrue: null, onFalse: null },
      retry: null
    };
  }
  return null;
}

/**
 * BPMN 2.0 XML with Camunda extension attributes.
 *
 * Enough for Camunda Modeler or bpmn.io to open and auto-lay-out. It carries no
 * `BPMNDiagram` visual coordinates and is marked `isExecutable="false"` — a
 * modelling handoff, not a deployable process archive.
 *
 * The Camunda attributes are the useful part: `failedJobRetryTimeCycle` is the
 * compiled retry policy expressed in the form the engine actually reads, so the
 * resilience declarations survive the handoff instead of becoming a comment.
 */
export function toBpmnXml(wf) {
  const t = {
    'event.start': 'startEvent', 'event.start.message': 'startEvent',
    'end': 'endEvent', 'end.terminate': 'endEvent',
    'gateway.exclusive': 'exclusiveGateway', 'gateway.merge': 'exclusiveGateway',
    'event.timer': 'intermediateCatchEvent'
  };

  const el = n => {
    const isHuman = n.type === 'task.approval' || n.type === 'task.review';
    const tag = t[n.type] || (isHuman ? 'userTask' : 'serviceTask');
    const attrs = [`id="${safeId(n.id)}"`, `name="${esc(n.name)}"`];

    if (isHuman) {
      if (n.performer?.id) attrs.push(`camunda:candidateGroups="${esc(n.performer.id)}"`);
      attrs.push(`camunda:formKey="embedded:app:forms/${safeId(n.id)}.html"`);
      if (n.sla?.durationSeconds) attrs.push(`camunda:dueDate="\${dateTime('P${Math.round(n.sla.durationSeconds / 86400)}D')}"`);
    } else if (tag === 'serviceTask') {
      attrs.push('camunda:asyncBefore="true"');
      if (n.operation) attrs.push(`camunda:type="external" camunda:topic="${esc(n.operation.connectorId + '.' + n.operation.operation)}"`);
      if (n.retry) attrs.push(`camunda:failedJobRetryTimeCycle="${camundaRetryCycle(n.retry)}"`);
    }

    const body = [];
    if (n.timeoutSeconds || n.idempotency?.keyRequired || n.circuitBreaker) {
      body.push('      <bpmn:extensionElements>');
      body.push('        <camunda:properties>');
      if (n.timeoutSeconds) body.push(`          <camunda:property name="timeoutSeconds" value="${n.timeoutSeconds}" />`);
      if (n.idempotency?.keyRequired) {
        body.push(`          <camunda:property name="idempotencyHeader" value="${esc(n.idempotency.header)}" />`);
        body.push(`          <camunda:property name="idempotencyKey" value="${esc(n.idempotency.key)}" />`);
      }
      if (n.circuitBreaker) {
        body.push(`          <camunda:property name="circuitBreaker.failureThreshold" value="${n.circuitBreaker.failureThreshold}" />`);
        body.push(`          <camunda:property name="circuitBreaker.openSeconds" value="${n.circuitBreaker.openSeconds}" />`);
      }
      body.push('        </camunda:properties>');
      body.push('      </bpmn:extensionElements>');
    }

    return body.length
      ? `      <bpmn:${tag} ${attrs.join(' ')}>\n${body.join('\n')}\n      </bpmn:${tag}>`
      : `      <bpmn:${tag} ${attrs.join(' ')} />`;
  };

  const flows = wf.edges.map((e, i) =>
    `      <bpmn:sequenceFlow id="flow_${i + 1}" sourceRef="${safeId(e.from)}" targetRef="${safeId(e.to)}"${e.label ? ` name="${esc(e.label)}"` : ''} />`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  targetNamespace="https://text2workflow.local/schema"
                  id="defs_${wf.workflowId}">
  <bpmn:collaboration id="collab_${wf.workflowId}">
    <bpmn:participant id="pool_main" name="${esc(wf.name)}" processRef="${wf.workflowId}" />
  </bpmn:collaboration>
  <bpmn:process id="${wf.workflowId}" name="${esc(wf.name)}" isExecutable="false">
    <bpmn:laneSet id="lanes_${wf.workflowId}">
${wf.participants.filter(p => wf.nodes.some(n => n.lane === p.id)).map(p => `      <bpmn:lane id="${safeId(p.id)}" name="${esc(p.name)}">
${wf.nodes.filter(n => n.lane === p.id).map(n => `        <bpmn:flowNodeRef>${safeId(n.id)}</bpmn:flowNodeRef>`).join('\n')}
      </bpmn:lane>`).join('\n')}
    </bpmn:laneSet>
${wf.nodes.map(el).join('\n')}
${flows.join('\n')}
  </bpmn:process>
</bpmn:definitions>`;
}

/** Camunda reads `${dateTime()...}` expressions; keep the syntax out of the template literal. */
function dateTime(iso) {
  return `dateTime().plus('${iso}')`;
}

/** Markdown summary for pasting into a ticket. */
export function toMarkdown(wf, validation) {
  const rows = toSchemaDictionary(wf);
  const lines = [
    `# ${wf.name}`, '',
    `**Workflow ID:** \`${wf.workflowId}\`  `,
    `**Source sentence:** "${wf.source.utterance}"  `,
    `**Validation status:** ${validation.status} — ${validation.counts.blocker} blocking, ${validation.counts.warning} advisory  `,
    `**Regulatory scope:** ${wf.governance.regulatoryScope.join(', ') || 'none detected'}`,
    '', '## Steps', '',
    '| # | Step | Performer | Maps to |', '|---|---|---|---|'
  ];
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.nodeId} — ${wf.nodes.find(n => n.id === r.nodeId).name} | ${r.performer} | \`${typeof r.binding === 'string' ? r.binding : ''}\` |`));

  if (validation.findings.length) {
    lines.push('', '## Open findings', '');
    validation.findings.forEach(f => lines.push(`- **${f.severity.toUpperCase()} ${f.rule}** — ${f.title}: ${f.detail}`));
  }
  return lines.join('\n');
}
