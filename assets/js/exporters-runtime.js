/**
 * exporters-runtime.js — the workflow in the shapes external runtimes want.
 *
 * All four exports are derived from the same compiled graph, so the diagram a
 * BA signs off, the JSON an integrator implements and the state machine a
 * platform team deploys cannot drift apart.
 *
 * They are **specifications and scaffolds, not deployable artefacts**. The
 * Step Functions definition carries placeholder ARNs, the Temporal file is a
 * skeleton whose activities are unimplemented, and the OpenAPI document
 * describes an interface nobody has built yet. Each one says so in its own
 * description field, so the caveat travels with the file.
 */

import { describeRetry } from './resilience.js';

/* ================================================================== */
/* 1 · Input contract — JSON Schema for the trigger payload            */
/* ================================================================== */

const JSON_TYPE = {
  currency: { type: 'number', minimum: 0 },
  money: { type: 'number', minimum: 0 },
  number: { type: 'number' },
  percent: { type: 'number', minimum: 0, maximum: 100 },
  duration: { type: 'number', minimum: 0, description: 'seconds' },
  boolean: { type: 'boolean' },
  string: { type: 'string' },
  literal: { type: 'string' },
  unknown: {}
};

/**
 * The schema a caller's trigger payload must satisfy.
 *
 * Only fields the workflow actually reads appear, and they are all required —
 * a decision the engine cannot evaluate is a run that cannot proceed, so
 * "optional" would be a lie.
 */
export function toInputSchema(wf) {
  const properties = {};
  const required = [];

  for (const v of wf.variables) {
    const [head, ...rest] = v.path.split('.');
    const leaf = rest.join('.') || head;
    if (!properties[head]) properties[head] = { type: 'object', properties: {}, required: [], additionalProperties: true };
    const base = { ...(JSON_TYPE[v.type] || JSON_TYPE.string) };
    if (v.currency) {
      base.description = `Amount in ${v.currency}. The workflow compares it against a threshold expressed in ${v.currency}; sending another currency silently mis-routes the run.`;
      base['x-currency'] = v.currency;
    }
    if (v.inferred) {
      base.description = (base.description ? base.description + ' ' : '') +
        'This field name was inferred from the source sentence rather than stated outright — confirm it matches your payload.';
    }
    properties[head].properties[leaf] = base;
    properties[head].required.push(leaf);
    if (!required.includes(head)) required.push(head);
  }

  properties.workflow = {
    type: 'object',
    description: 'Run metadata supplied by the caller or the runtime.',
    properties: {
      correlationId: { type: 'string', description: 'Stable per business transaction. Retry keys are derived from it, so it must not change between attempts.' },
      requestedBy: { type: 'string' }
    },
    required: ['correlationId'],
    additionalProperties: false
  };
  required.push('workflow');

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://text2workflow.local/contracts/${wf.workflowId}/input.schema.json`,
    title: `${wf.name} — trigger payload`,
    description: [
      `Input contract for workflow ${wf.workflowId}, generated from the sentence:`,
      `"${wf.source.utterance}"`,
      '',
      'Every property listed is read by a decision in the workflow. A payload',
      'missing one of them produces a run that cannot evaluate its own gateways.'
    ].join('\n'),
    type: 'object',
    properties,
    required,
    additionalProperties: true
  };
}

/* ================================================================== */
/* 2 · OpenAPI 3.1 — the interface a platform team must implement      */
/* ================================================================== */

function schemaFromPayload(payload) {
  const properties = {};
  for (const [key, value] of Object.entries(payload || {})) {
    const binding = typeof value === 'string' && /^\{\{.+\}\}$/.test(value);
    properties[key] = {
      type: 'string',
      ...(binding ? { description: `Bound at runtime from ${value}` } : { example: value })
    };
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/** Every distinct connector call plus the engine's own task endpoints. */
export function toOpenApi(wf) {
  const paths = {};
  const schemas = { WorkflowContext: toInputSchema(wf) };
  const seen = new Set();

  for (const node of wf.nodes) {
    if (!node.operation) continue;
    const path = `/connectors/${node.operation.connectorId}/${node.operation.operation.replace(/\./g, '/')}`;
    if (seen.has(path)) continue;
    seen.add(path);

    const schemaName = `${node.operation.connectorId}_${node.operation.operation.replace(/\./g, '_')}_Request`
      .replace(/[^A-Za-z0-9_]/g, '');
    schemas[schemaName] = schemaFromPayload(node.operation.payload);

    const headers = [];
    if (node.idempotency?.keyRequired) {
      headers.push({
        name: node.idempotency.header,
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description: `Stable across retries of one step. ${node.idempotency.reason}. The caller retries up to ${node.retry.maxAttempts} times, so the implementation MUST treat a repeat with the same value as the same request.`
      });
    }

    paths[path] = {
      post: {
        operationId: `${node.operation.connectorId}_${node.operation.operation.replace(/\./g, '_')}`,
        summary: `${node.operation.connector} — ${node.operation.operation}`,
        description: [
          `Called by step \`${node.id}\` ("${node.name}").`,
          '',
          `**Failure behaviour the caller applies:** ${describeRetry(node.retry)}.`,
          node.circuitBreaker
            ? `The caller stops sending after ${node.circuitBreaker.failureThreshold} failures in ${node.circuitBreaker.samplingWindowSeconds}s and resumes after ${node.circuitBreaker.openSeconds}s.`
            : '',
          `**Request timeout:** ${node.timeoutSeconds}s.`
        ].filter(Boolean).join('\n'),
        tags: [node.operation.connector],
        parameters: headers,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } }
        },
        responses: {
          200: { description: 'Accepted and applied.' },
          409: { description: 'Duplicate of a request already applied, identified by the idempotency key. The caller treats this as success.' },
          429: { description: 'Rate limited. Counts as a retryable failure and feeds the circuit breaker.' },
          500: { description: 'Retryable failure.' },
          503: { description: 'Retryable failure. Trips the circuit breaker faster than a 500.' }
        },
        'x-resilience': {
          timeoutSeconds: node.timeoutSeconds,
          retry: node.retry,
          circuitBreaker: node.circuitBreaker,
          idempotency: node.idempotency
        }
      }
    };
  }

  const humanSteps = wf.nodes.filter(n => n.type === 'task.approval' || n.type === 'task.review');
  if (humanSteps.length) {
    schemas.HumanTaskRequest = {
      type: 'object',
      required: ['assignee', 'subject', 'correlationId'],
      additionalProperties: false,
      properties: {
        assignee: { type: 'string', enum: [...new Set(humanSteps.map(n => n.performer?.id).filter(Boolean))] },
        subject: { type: 'string' },
        correlationId: { type: 'string' },
        dueInSeconds: { type: ['integer', 'null'] },
        onBreach: { enum: ['escalate', 'alert', 'none'] },
        outcomes: { type: 'array', items: { type: 'string' } }
      }
    };
    paths['/tasks/human'] = {
      post: {
        operationId: 'createHumanTask',
        summary: 'Create a task for a person and wait for their decision',
        description: 'Long-running. The implementation is expected to return a task token immediately and signal the workflow when the person responds.',
        tags: ['Engine'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/HumanTaskRequest' } } } },
        responses: {
          202: { description: 'Task created; the outcome arrives asynchronously.' },
          400: { description: 'Unknown assignee.' }
        }
      }
    };
  }

  if (wf.nodes.some(n => n.type === 'task.notify')) {
    schemas.NotificationRequest = {
      type: 'object',
      required: ['recipients', 'subject', 'correlationId'],
      additionalProperties: false,
      properties: {
        recipients: { type: 'array', items: { type: 'string' } },
        channel: { type: 'string' },
        subject: { type: 'string' },
        correlationId: { type: 'string' }
      }
    };
    paths['/notifications/send'] = {
      post: {
        operationId: 'sendNotification',
        summary: 'Send a notification',
        tags: ['Engine'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationRequest' } } } },
        responses: { 202: { description: 'Queued.' } }
      }
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${wf.name} — connector interface`,
      version: '1.0.0',
      description: [
        `Generated from workflow \`${wf.workflowId}\`, compiled from the sentence:`,
        '',
        `> ${wf.source.utterance}`,
        '',
        '**This describes an interface that has not been built.** Every path here',
        'is a contract the workflow expects a platform team to implement. No',
        'credential has been issued and no call has ever been made against any of',
        'these endpoints. Server URLs are placeholders.',
        '',
        'The `x-resilience` block on each operation carries the retry, circuit',
        'breaker and idempotency policy the caller applies, so the implementation',
        'knows what behaviour it must tolerate.'
      ].join('\n')
    },
    servers: [{ url: 'https://{host}/v1', variables: { host: { default: 'orchestrator.internal', description: 'Placeholder — no such host exists.' } } }],
    tags: [...new Set(wf.connectors.map(c => c.name))].map(name => ({ name })).concat([{ name: 'Engine' }]),
    paths,
    components: { schemas }
  };
}

/* ================================================================== */
/* 3 · AWS Step Functions — Amazon States Language                     */
/* ================================================================== */

const ASL_NUMERIC = { gt: 'NumericGreaterThan', gte: 'NumericGreaterThanEquals', lt: 'NumericLessThan', lte: 'NumericLessThanEquals', eq: 'NumericEquals' };
const ASL_STRING = { eq: 'StringEquals', gt: 'StringGreaterThan', lt: 'StringLessThan' };

function aslName(id) {
  return id.replace(/[^A-Za-z0-9]/g, '_');
}

/** One Choice rule from a compiled condition. */
function aslChoiceRule(condition, nextState) {
  const varPath = `$.${condition.subject}`;
  const numeric = condition.valueType === 'money' || condition.valueType === 'number' || condition.valueType === 'percent';
  const key = numeric ? ASL_NUMERIC[condition.operator] : ASL_STRING[condition.operator];

  let rule;
  if (!key) {
    // `neq` has no direct comparator; ASL expresses it as Not(Equals).
    const inner = numeric ? 'NumericEquals' : 'StringEquals';
    rule = { Not: { Variable: varPath, [inner]: condition.value } };
  } else {
    rule = { Variable: varPath, [key]: condition.value };
  }
  if (condition.negated) rule = rule.Not ? { Variable: varPath, [numeric ? 'NumericEquals' : 'StringEquals']: condition.value } : { Not: rule };
  return { ...rule, Next: nextState, Comment: condition.raw || undefined };
}

/**
 * Translate the graph into a Step Functions state machine.
 *
 * The retry policy maps cleanly onto ASL's own `Retry` block — which is the
 * point of exporting here rather than to a generic format: the resilience
 * declarations become executable configuration instead of documentation.
 */
export function toStepFunctions(wf) {
  const States = {};
  const outgoing = new Map(wf.nodes.map(n => [n.id, []]));
  wf.edges.forEach(e => outgoing.get(e.from)?.push(e));

  const nextOf = id => {
    const edges = outgoing.get(id) || [];
    return edges.length ? aslName(edges[0].to) : null;
  };

  for (const node of wf.nodes) {
    const name = aslName(node.id);
    const edges = outgoing.get(node.id) || [];

    if (node.type === 'end') { States[name] = { Type: 'Succeed', Comment: node.name }; continue; }
    if (node.type === 'end.terminate') {
      States[name] = { Type: 'Fail', Error: 'ProcessStopped', Cause: node.name };
      continue;
    }

    if (node.type === 'gateway.exclusive' && node.condition && !node.condition.unresolved) {
      const yes = edges.find(e => e.guard === 'true');
      const no = edges.find(e => e.guard === 'false');
      // ASL raises States.NoChoiceMatched at runtime when a Choice has no
      // Default, so one is always emitted — a Fail state if the graph genuinely
      // has no negative branch, which R-GATEWAY-ARITY would already have
      // reported as a blocker.
      let fallback;
      if (no) {
        fallback = aslName(no.to);
      } else {
        fallback = `${name}__unmatched`;
        States[fallback] = {
          Type: 'Fail',
          Error: 'NoChoiceMatched',
          Cause: `"${node.name}" has no defined path for the negative case.`
        };
      }
      States[name] = {
        Type: 'Choice',
        Comment: node.name,
        Choices: yes ? [aslChoiceRule(node.condition, aslName(yes.to))] : [],
        Default: fallback
      };
      continue;
    }

    if (node.type === 'gateway.merge' || node.type === 'gateway.exclusive' || node.type.startsWith('event.start')) {
      States[name] = { Type: 'Pass', Comment: node.name, ...(nextOf(node.id) ? { Next: nextOf(node.id) } : { End: true }) };
      continue;
    }

    if (node.type === 'event.timer' && node.timer) {
      States[name] = { Type: 'Wait', Seconds: node.timer.durationSeconds, Comment: node.name, ...(nextOf(node.id) ? { Next: nextOf(node.id) } : { End: true }) };
      continue;
    }

    /* --- a real task ------------------------------------------------ */
    const isHuman = node.type === 'task.approval' || node.type === 'task.review';
    const state = {
      Type: 'Task',
      Comment: node.name,
      Resource: isHuman
        ? 'arn:aws:states:::lambda:invoke.waitForTaskToken'
        : 'arn:aws:states:::http:invoke',
      Parameters: isHuman
        ? {
          // Placeholder ARN: nothing is deployed.
          FunctionName: '${HumanTaskFunctionArn}',
          Payload: {
            'assignee': node.performer?.id || null,
            'subject': node.name,
            'taskToken.$': '$$.Task.Token',
            'correlationId.$': '$.workflow.correlationId'
          }
        }
        : {
          ApiEndpoint: `\${ConnectorBaseUrl}/connectors/${node.operation?.connectorId || 'engine'}/${(node.operation?.operation || 'invoke').replace(/\./g, '/')}`,
          Method: 'POST',
          Authentication: { ConnectionArn: '${EventBridgeConnectionArn}' },
          RequestBody: node.operation?.payload || {},
          ...(node.idempotency?.keyRequired
            ? { Headers: { [node.idempotency.header]: node.idempotency.key } }
            : {})
        },
      ...(node.timeoutSeconds ? { TimeoutSeconds: node.timeoutSeconds } : {}),
      ...(isHuman && node.sla?.durationSeconds ? { HeartbeatSeconds: node.sla.durationSeconds } : {})
    };

    if (node.retry && node.retry.maxAttempts > 1) {
      state.Retry = [{
        ErrorEquals: ['States.Timeout', 'States.TaskFailed', 'States.Http.StatusCode.429', 'States.Http.StatusCode.500', 'States.Http.StatusCode.503'],
        IntervalSeconds: node.retry.initialIntervalSeconds || 1,
        MaxAttempts: node.retry.maxAttempts - 1,
        BackoffRate: node.retry.backoffCoefficient || 2,
        ...(node.retry.maxIntervalSeconds ? { MaxDelaySeconds: node.retry.maxIntervalSeconds } : {}),
        ...(node.retry.jitter && node.retry.jitter !== 'none' ? { JitterStrategy: 'FULL' } : {})
      }];
    }

    const failureState = `${name}__failed`;
    state.Catch = [{ ErrorEquals: ['States.ALL'], Next: failureState, ResultPath: '$.error' }];
    States[failureState] = node.retry?.onExhausted === 'drop'
      ? { Type: 'Pass', Comment: `${node.name} failed and was dropped`, ...(nextOf(node.id) ? { Next: nextOf(node.id) } : { End: true }) }
      : {
        Type: 'Fail',
        Error: node.retry?.onExhausted === 'dead-letter' ? 'DeadLettered' : 'StepFailed',
        Cause: `"${node.name}" exhausted its retries. Configured action: ${node.retry?.onExhausted || 'fail'}.`
      };

    const next = nextOf(node.id);
    if (next) state.Next = next; else state.End = true;
    States[name] = state;
  }

  return {
    Comment: [
      `${wf.name}. Generated from: "${wf.source.utterance}".`,
      'PLACEHOLDER ARNs — this definition has never been deployed or executed.',
      'Substitute ${ConnectorBaseUrl}, ${EventBridgeConnectionArn} and',
      '${HumanTaskFunctionArn} before use.'
    ].join(' '),
    StartAt: aslName('n_start'),
    QueryLanguage: 'JSONPath',
    States
  };
}

/* ================================================================== */
/* 4 · Temporal — TypeScript workflow skeleton                         */
/* ================================================================== */

function tsIdent(id) {
  const clean = id.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
  return clean.charAt(0).toLowerCase() + clean.slice(1);
}

const TS_OP = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '===', neq: '!==' };

/**
 * A Temporal workflow skeleton.
 *
 * Temporal's RetryPolicy is a near one-to-one match for the compiled retry
 * declarations, so the generated `proxyActivities` calls carry the real
 * numbers rather than defaults someone has to remember to change.
 */
export function toTemporal(wf) {
  const activities = [];
  const seenActivity = new Set();

  for (const node of wf.nodes) {
    if (!node.operation && node.type !== 'task.approval' && node.type !== 'task.review' && node.type !== 'task.notify') continue;
    const name = tsIdent(node.operation ? `${node.operation.connectorId}_${node.operation.operation}` : node.type);
    if (seenActivity.has(name)) continue;
    seenActivity.add(name);
    activities.push({ name, node });
  }

  const lines = [];
  lines.push('/**');
  lines.push(` * ${wf.name}`);
  lines.push(' *');
  lines.push(` * Generated by Text2Workflow from workflow ${wf.workflowId}:`);
  lines.push(` *   "${wf.source.utterance}"`);
  lines.push(' *');
  lines.push(' * SCAFFOLD. The activity implementations in ./activities are not written,');
  lines.push(' * and this file has never been run against a Temporal cluster. What is');
  lines.push(' * real here are the retry policies and timeouts — they are the compiled');
  lines.push(' * resilience declarations, not placeholders.');
  lines.push(' */');
  lines.push('');
  lines.push("import { proxyActivities, condition, defineSignal, setHandler, log } from '@temporalio/workflow';");
  lines.push("import type * as activities from './activities';");
  lines.push('');

  // one proxy per distinct retry policy, so the numbers stay meaningful
  const groups = new Map();
  for (const { node } of activities) {
    // A node can carry an operation without a policy if it was hand-built.
    // Grouping on a missing policy would produce `undefined.maxAttempts`.
    if (!node.operation || !node.retry) continue;
    const key = JSON.stringify({ r: node.retry, t: node.timeoutSeconds });
    if (!groups.has(key)) groups.set(key, { node, names: [] });
    groups.get(key).names.push(tsIdent(`${node.operation.connectorId}_${node.operation.operation}`));
  }

  let proxyIndex = 0;
  const proxyFor = new Map();
  for (const [, group] of groups) {
    const proxyName = groups.size === 1 ? 'acts' : `acts${++proxyIndex}`;
    group.names.forEach(n => proxyFor.set(n, proxyName));
    const r = group.node.retry;
    lines.push(`// ${group.node.operation.connector}: ${describeRetry(r)}`);
    lines.push(`const ${proxyName} = proxyActivities<typeof activities>({`);
    lines.push(`  startToCloseTimeout: '${group.node.timeoutSeconds || 30} seconds',`);
    lines.push('  retry: {');
    lines.push(`    maximumAttempts: ${r.maxAttempts},`);
    lines.push(`    initialInterval: '${r.initialIntervalSeconds || 1} seconds',`);
    lines.push(`    backoffCoefficient: ${r.backoffCoefficient || 2},`);
    lines.push(`    maximumInterval: '${r.maxIntervalSeconds || 60} seconds',`);
    lines.push('  },');
    lines.push('});');
    lines.push('');
  }

  const humans = wf.nodes.filter(n => n.type === 'task.approval' || n.type === 'task.review');
  for (const h of humans) {
    lines.push(`export const ${tsIdent(h.id)}Signal = defineSignal<['approved' | 'rejected']>('${tsIdent(h.id)}Decision');`);
  }
  if (humans.length) lines.push('');

  lines.push('export interface WorkflowInput {');
  for (const v of wf.variables) lines.push(`  ${v.path.split('.')[0]}: { ${v.path.split('.').slice(1).join('.')}: ${v.type === 'currency' || v.type === 'number' ? 'number' : 'string'} };`);
  lines.push('  workflow: { correlationId: string };');
  lines.push('}');
  lines.push('');

  lines.push(`export async function ${tsIdent(wf.name)}(input: WorkflowInput): Promise<string> {`);

  for (const h of humans) {
    lines.push(`  let ${tsIdent(h.id)}Outcome: 'approved' | 'rejected' | undefined;`);
    lines.push(`  setHandler(${tsIdent(h.id)}Signal, (d) => { ${tsIdent(h.id)}Outcome = d; });`);
  }
  if (humans.length) lines.push('');

  // Linear emission with conditionals — a readable skeleton rather than a
  // faithful graph interpreter, which is what a scaffold should be.
  const emitted = new Set();
  const walk = (id, indent) => {
    const node = wf.nodes.find(n => n.id === id);
    if (!node || emitted.has(id)) return;
    emitted.add(id);
    const pad = '  '.repeat(indent);
    const out = wf.edges.filter(e => e.from === id && !e.back);

    if (node.type === 'gateway.exclusive' && node.condition && !node.condition.unresolved) {
      const owner = wf.nodes.find(n => n.outcomeGatewayId === node.id);
      const test = owner
        ? `${tsIdent(owner.id)}Outcome === 'approved'`
        : `input.${node.condition.subject} ${TS_OP[node.condition.operator] || '==='} ${typeof node.condition.value === 'number' ? node.condition.value : `'${node.condition.value}'`}`;
      lines.push(`${pad}if (${test}) {`);
      const yes = out.find(e => e.guard === 'true');
      if (yes) walk(yes.to, indent + 1);
      const no = out.find(e => e.guard === 'false');
      if (no && !emitted.has(no.to)) {
        lines.push(`${pad}} else {`);
        walk(no.to, indent + 1);
      }
      lines.push(`${pad}}`);
      return;
    }

    if (node.type === 'task.approval' || node.type === 'task.review') {
      lines.push(`${pad}await acts${''}HumanTask?.({ assignee: '${node.performer?.id || 'unassigned'}', subject: ${JSON.stringify(node.name)} });`.replace('acts' + 'HumanTask?.', 'requestDecision'));
      lines.push(`${pad}await condition(() => ${tsIdent(node.id)}Outcome !== undefined${node.sla?.durationSeconds ? `, '${node.sla.durationSeconds} seconds'` : ''});`);
    } else if (node.operation) {
      const fn = tsIdent(`${node.operation.connectorId}_${node.operation.operation}`);
      lines.push(`${pad}await ${proxyFor.get(fn) || 'acts'}.${fn}(${JSON.stringify(node.operation.payload)});`);
    } else if (node.type === 'end.terminate') {
      lines.push(`${pad}return ${JSON.stringify(node.name)};`);
      return;
    } else if (node.type === 'end') {
      lines.push(`${pad}return 'complete';`);
      return;
    } else if (node.type !== 'gateway.merge' && !node.type.startsWith('event.start')) {
      lines.push(`${pad}log.info(${JSON.stringify(node.name)});`);
    }

    out.forEach(e => walk(e.to, indent));
  };
  walk('n_start', 1);

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/* ================================================================== */
/* 5 · Camunda-flavoured BPMN extension attributes                     */
/* ================================================================== */

/** ISO 8601 repeating interval — Camunda's failed-job retry cycle format. */
export function camundaRetryCycle(retry) {
  if (!retry || retry.maxAttempts <= 1) return 'R0/PT0S';
  return `R${retry.maxAttempts - 1}/PT${retry.initialIntervalSeconds || 1}S`;
}
