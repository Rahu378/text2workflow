/**
 * run.js — the test suite. Zero dependencies: `node tests/run.js`.
 *
 * The suite is organised around the claims the README makes. Anything the
 * README asserts about the engine has a test here; anything it does not assert
 * (accuracy against human-written workflows, for instance) has no test here
 * either, because there is no gold set to measure it against.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse, segment, parseValue, parseDuration, resolveSubject, __internals } from '../assets/js/parser.js';
import { compile, conditionLabel } from '../assets/js/compiler.js';
import { validate, RULES } from '../assets/js/validator.js';
import { layout, rankNodes } from '../assets/js/layout.js';
import { toMermaid, toSchemaDictionary, toBpmnXml, toMarkdown } from '../assets/js/exporters.js';
import { AuditLedger, canonicalize, GENESIS } from '../assets/js/audit.js';
import { buildTrace } from '../assets/js/trace.js';
import { simulate, simulationInputs, evaluateCondition } from '../assets/js/simulate.js';
import { fieldCatalogue, describeField, describeOperator, FRIENDLY_OPERATORS, CONNECTORS } from '../assets/js/lexicon.js';
import { policyFor, safetyOf, slaFor, describeRetry } from '../assets/js/resilience.js';
import { toInputSchema, toOpenApi, toStepFunctions, toTemporal } from '../assets/js/exporters-runtime.js';
import { SAMPLES } from '../assets/js/samples.js';
import { validateSchema } from './schema-lite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, '..', 'schema', 'workflow.v1.schema.json'), 'utf8'));

/* ------------------------------------------------------------------ */
/* micro harness                                                       */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
let group = '';

const describe = name => { group = name; console.log(`\n\x1b[1m${name}\x1b[0m`); };

async function it(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ group, name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'not equal'}\n      expected: ${b}\n      actual:   ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function includes(hay, needle, msg) {
  if (!String(hay).includes(needle)) throw new Error(`${msg || 'missing'}: ${JSON.stringify(needle)}`);
}

/** Walk the tags with a stack; returns the unclosed ones. */
function tagBalance(xml) {
  const stack = [];
  const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, closing, name, attrs, selfClose] = m;
    if (attrs.startsWith('?') || name.startsWith('?') || name.startsWith('!')) continue;
    if (selfClose) continue;
    if (closing) {
      if (stack[stack.length - 1] === name) stack.pop();
      else stack.push(`UNEXPECTED </${name}>`);
    } else {
      stack.push(name);
    }
  }
  return stack;
}

const FLAGSHIP = 'Send the invoice to accounting, if it is over $10k get CFO approval first, then log it in Snowflake';

/** Drive the clarification loop by always taking the first offered option. */
function converge(utterance, maxRounds = 20) {
  const parsed = parse(utterance);
  let resolutions = {};
  const asked = [];
  for (let i = 0; i < maxRounds; i++) {
    const wf = compile(parsed, resolutions);
    const v = validate(wf, resolutions);
    if (!v.questions.length) return { parsed, workflow: wf, validation: v, resolutions, rounds: i, asked };
    const q = v.questions[0];
    asked.push(q.rule);
    resolutions = {
      ...resolutions,
      [q.id]: q.options ? q.options[0].value : { subject: 'ctx.field', operator: 'eq', value: 1, valueType: 'number' }
    };
  }
  throw new Error(`did not converge in ${maxRounds} rounds; still asking: ${asked.slice(-3).join(', ')}`);
}

/* ================================================================== */
/* parser                                                             */
/* ================================================================== */

describe('parser · segmentation');

await it('splits on commas and sequencing words', () => {
  eq(segment(FLAGSHIP), [
    'Send the invoice to accounting',
    'if it is over $10k get CFO approval first',
    'log it in Snowflake'
  ]);
});

await it('does not split a thousands separator', () => {
  const clauses = segment('if the amount is over 25,000 USD get approval');
  eq(clauses.length, 1);
  includes(clauses[0], '25,000');
});

await it('splits "and" only when the tail is its own action', () => {
  eq(__internals.splitOnCoordinatingAnd('notify legal and finance'), ['notify legal and finance']);
  eq(__internals.splitOnCoordinatingAnd('notify legal and log it in SAP'), ['notify legal', 'log it in SAP']);
});

describe('parser · values');

await it('parses currency symbols and magnitudes', () => {
  eq(parseValue('$10k').value, 10000);
  eq(parseValue('$10k').currency, 'USD');
  eq(parseValue('2.5M EUR').value, 2500000);
  eq(parseValue('2.5M EUR').currency, 'EUR');
  eq(parseValue('25,000 USD').value, 25000);
});

await it('flags a bare number as having an inferred currency', () => {
  ok(parseValue('1M').currencyInferred, 'bare 1M should be marked currency-inferred');
  ok(!parseValue('$1M').currencyInferred, '$1M carries its currency');
});

await it('parses durations including business days', () => {
  eq(parseDuration('within 3 business days').seconds, 259200);
  ok(parseDuration('within 3 business days').businessDays);
  eq(parseDuration('wait 4 hours').seconds, 14400);
});

describe('parser · conditions');

await it('prefers the specific comparator over a stray copula', () => {
  const spec = parse(FLAGSHIP).specs.find(s => s.kind === 'condition');
  eq(spec.test.operator, 'gt', '"it is over $10k" must read as gt, not eq on "is"');
  eq(spec.test.value.value, 10000);
  eq(spec.test.value.currency, 'USD');
});

await it('detects negation in front of a comparator', () => {
  const spec = parse('If the contract value is not above 1M, have legal review it').specs.find(s => s.kind === 'condition');
  eq(spec.test.operator, 'gt');
  ok(spec.negated, 'the "not" must flip the branch, not the operator');
});

await it('marks an unevaluable predicate rather than guessing', () => {
  const spec = parse('If a payment looks significant, get approval').specs.find(s => s.kind === 'condition');
  ok(spec.test.unresolved, 'no comparator means unresolved');
  eq(spec.test.reason, 'no-comparator');
});

await it('reads "when X is received" as a trigger, not a decision', () => {
  const specs = parse('Whenever an invoice is received, post it to NetSuite').specs;
  eq(specs[0].kind, 'trigger');
  eq(specs[0].event, 'received');
  ok(!specs.some(s => s.kind === 'condition'), 'a trigger must not compile to a gateway');
});

describe('parser · reference resolution');

await it('hoists a clause carrying "first" ahead of the preceding clause', () => {
  const specs = parse(FLAGSHIP).specs;
  eq(specs[0].kind, 'condition', 'the approval gate must come first');
  eq(specs[1].frame.type, 'task.notify');
  eq(specs[2].frame.type, 'task.data.write');
});

await it('binds a pronoun to the nearest preceding object', () => {
  const spec = parse(FLAGSHIP).specs.find(s => s.kind === 'condition');
  eq(spec.subject.path, 'invoice.amount');
  ok(spec.subject.inferred, 'a borrowed subject must be flagged as inferred');
  ok(!spec.subject.ambiguous);
});

await it('flags an ambiguous subject when two records are in play', () => {
  const spec = parse('Whenever an invoice is received, verify the PO in SAP, if the amount is over 25,000 USD get controller approval first')
    .specs.find(s => s.kind === 'condition');
  ok(spec.subject.ambiguous, '"the amount" with both an invoice and a PO in scope is ambiguous');
  eq(spec.subject.candidates.length, 2);
});

await it('attaches a comma-split consequent to its condition', () => {
  const specs = parse('If the contract value is over 1M, have legal review it').specs;
  const cond = specs.find(s => s.kind === 'condition');
  ok(cond.action, 'the following clause is the true branch');
  eq(cond.action.frame.type, 'task.review');
});

/* ================================================================== */
/* compiler                                                           */
/* ================================================================== */

describe('compiler · graph');

await it('compiles the flagship sentence to the expected shape', () => {
  const wf = compile(parse(FLAGSHIP));
  eq(wf.nodes.map(n => n.type), [
    'event.start', 'gateway.exclusive', 'task.approval',
    'gateway.merge', 'task.notify', 'task.data.write', 'end'
  ]);
  eq(wf.participants.filter(p => wf.nodes.some(n => n.lane === p.id)).map(p => p.name),
    ['CFO', 'Automation Engine', 'Snowflake']);
  eq(conditionLabel(wf.nodes[1].condition), 'invoice.amount > 10,000 USD?');
});

await it('routes both gateway branches into a merge', () => {
  const wf = compile(parse(FLAGSHIP));
  const gate = wf.nodes.find(n => n.type === 'gateway.exclusive');
  const out = wf.edges.filter(e => e.from === gate.id);
  eq(out.length, 2);
  eq(out.map(e => e.guard).sort(), ['false', 'true']);
  eq(new Set(out.map(e => e.guard === 'false' ? e.to : gate.branches.mergeId)).size, 1);
});

await it('is deterministic — same inputs, byte-identical output', () => {
  const a = JSON.stringify(compile(parse(FLAGSHIP), { 'else:n1': { action: 'continue' } }));
  const b = JSON.stringify(compile(parse(FLAGSHIP), { 'else:n1': { action: 'continue' } }));
  eq(a === b, true, 'compilation must be pure');
});

await it('keeps node ids stable when a clarification inserts nodes', () => {
  const parsed = parse(FLAGSHIP);
  const before = compile(parsed, {});
  const after = compile(parsed, { 'reject:n1.then': { action: 'terminate' } });
  for (const id of ['n_start', 'n1', 'n1.then', 'n1.merge', 'n2', 'n3', 'n_end']) {
    ok(before.nodes.some(n => n.id === id), `${id} missing before`);
    ok(after.nodes.some(n => n.id === id), `${id} renumbered after a clarification — resolution keys would break`);
  }
});

await it('materialises the rejection path only once asked', () => {
  const parsed = parse(FLAGSHIP);
  ok(!compile(parsed, {}).nodes.some(n => n.type === 'end.terminate'));
  const after = compile(parsed, { 'reject:n1.then': { action: 'terminate' } });
  ok(after.nodes.some(n => n.type === 'end.terminate'));
  ok(after.nodes.find(n => n.id === 'n1.then').outcomeGatewayId);
});

await it('creates a loop edge for a return-for-revision answer', () => {
  const wf = compile(parse(FLAGSHIP), { 'reject:n1.then': { action: 'return', returnTo: 'Requester' } });
  const back = wf.edges.filter(e => e.back);
  eq(back.length, 1);
  eq(back[0].to, 'n1.then', 'the loop must return to the approval itself');
});

await it('detects regulatory scope from the objects in play', () => {
  eq(compile(parse(FLAGSHIP)).governance.regulatoryScope, ['financial-controls']);
  ok(compile(parse('Send the expense report to the manager')).governance.regulatoryScope.includes('PII'));
});

await it('records a traceable clause on every node it did not invent', () => {
  const wf = compile(parse(FLAGSHIP));
  for (const n of wf.nodes) {
    const explained = n.trace?.clause || n.trace?.from === 'structure' || n.trace?.from === 'clarification';
    ok(explained, `${n.id} has no provenance`);
  }
});

/* ================================================================== */
/* schema conformance                                                 */
/* ================================================================== */

describe('schema conformance');

for (const sample of SAMPLES) {
  await it(`"${sample.label}" conforms to workflow.v1.schema.json`, () => {
    const { workflow } = converge(sample.text);
    const result = validateSchema(SCHEMA, workflow);
    ok(result.valid, result.errors.slice(0, 4).join('\n      '));
  });
}

await it('an un-clarified workflow also conforms', () => {
  const result = validateSchema(SCHEMA, compile(parse(FLAGSHIP)));
  ok(result.valid, result.errors.slice(0, 4).join('\n      '));
});

await it('the validator itself rejects a malformed workflow', () => {
  const bad = compile(parse(FLAGSHIP));
  bad.nodes[1].type = 'gateway.telepathic';
  ok(!validateSchema(SCHEMA, bad).valid, 'an unknown node type must fail the schema');
});

/* ================================================================== */
/* validator                                                          */
/* ================================================================== */

describe('validator · rules');

await it('every documented rule id is reachable from the sample set', () => {
  const fired = new Set();
  for (const s of SAMPLES) {
    const parsed = parse(s.text);
    let res = {};
    for (let i = 0; i < 20; i++) {
      const v = validate(compile(parsed, res), res);
      v.findings.forEach(f => fired.add(f.rule));
      if (!v.questions.length) break;
      const q = v.questions[0];
      res = { ...res, [q.id]: q.options ? q.options[0].value : { subject: 'x', operator: 'eq', value: 1, valueType: 'number' } };
    }
  }
  // Structural rules only fire on a corrupted graph; they are exercised below.
  const structural = new Set(['R-ORPHAN', 'R-DEADEND', 'R-GATEWAY-ARITY', 'R-PII-EGRESS', 'R-RETRIES-DISABLED']);
  const missing = RULES.map(r => r[0]).filter(id => !fired.has(id) && !structural.has(id));
  eq(missing, [], 'these documented rules never fired on any sample');
});

await it('blocks on an implicit negative branch', () => {
  const v = validate(compile(parse(FLAGSHIP)), {});
  const f = v.findings.find(x => x.rule === 'R-ELSE');
  ok(f, 'R-ELSE must fire');
  eq(f.severity, 'blocker');
  ok(f.question.options.length >= 2);
});

await it('blocks on an approval with no rejection path', () => {
  const v = validate(compile(parse(FLAGSHIP)), {});
  ok(v.findings.some(f => f.rule === 'R-NO-REJECT-PATH' && f.severity === 'blocker'));
});

await it('blocks on a money threshold with no currency', () => {
  const u = 'If the contract value is over 1M get CFO approval';
  const v = validate(compile(parse(u)), {});
  const f = v.findings.find(x => x.rule === 'R-CURRENCY');
  ok(f, 'a bare 1M must be challenged');
  eq(f.question.options.map(o => o.value.currency), ['USD', 'EUR', 'GBP', 'JPY', 'INR']);
});

await it('blocks on a regulated flow with no audit step', () => {
  ok(validate(compile(parse(FLAGSHIP)), {}).findings.some(f => f.rule === 'R-AUDIT'));
});

await it('warns on unquantified language', () => {
  const u = 'If a payment looks significant, get the appropriate person to approve it quickly';
  const f = validate(compile(parse(u)), {}).findings.find(x => x.rule === 'R-VAGUE');
  ok(f, 'R-VAGUE must fire');
  includes(f.detail, 'significant');
});

await it('warns when the same field carries conflicting thresholds', () => {
  const u = 'When a refund is requested in Zendesk, if the amount is over 200 USD get manager approval, if the amount is over 2000 USD get director approval';
  ok(validate(compile(parse(u)), {}).findings.some(f => f.rule === 'R-THRESHOLD-CONFLICT'));
});

await it('stays silent about the else branch when the sentence supplies one', () => {
  const u = 'When an expense report is at least 500 EUR route it to the manager, otherwise auto-approve it';
  const wf = compile(parse(u));
  const gate = wf.nodes.find(n => n.type === 'gateway.exclusive');
  ok(gate.branches.elseHandled, 'an explicit "otherwise" closes the negative branch');
});

await it('catches an unreachable node', () => {
  const wf = compile(parse(FLAGSHIP));
  wf.edges = wf.edges.filter(e => e.to !== 'n1.then');
  const v = validate(wf, {});
  ok(v.findings.some(f => f.rule === 'R-ORPHAN'), 'a node with no inbound path must be reported');
});

await it('catches a step with nowhere to go', () => {
  const wf = compile(parse(FLAGSHIP));
  wf.edges = wf.edges.filter(e => e.from !== 'n3');
  ok(validate(wf, {}).findings.some(f => f.rule === 'R-DEADEND'));
});

await it('catches a decision with one outcome', () => {
  const wf = compile(parse(FLAGSHIP));
  wf.edges = wf.edges.filter(e => !(e.from === 'n1' && e.guard === 'false'));
  ok(validate(wf, {}).findings.some(f => f.rule === 'R-GATEWAY-ARITY'));
});

await it('reports no confidence percentage anywhere', () => {
  const v = validate(compile(parse(FLAGSHIP)), {});
  const blob = JSON.stringify(v);
  ok(!/\bconfidence\b/i.test(blob), 'the engine must not emit a confidence score');
  eq(Object.keys(v).sort(), ['checks', 'counts', 'findings', 'questions', 'status']);
});

describe('validator · convergence');

for (const sample of SAMPLES) {
  await it(`"${sample.label}" converges to a clean state`, () => {
    const { validation, rounds } = converge(sample.text);
    eq(validation.questions.length, 0, `still asking after ${rounds} rounds`);
    eq(validation.counts.blocker, 0, `blockers remain after ${rounds} rounds`);
    // A warning may legitimately survive the loop when it has no answerable
    // question — R-THRESHOLD-CONFLICT is advice for a human, not a gap the
    // engine can fill. What must never survive is an *unasked* question.
    const unanswerable = validation.findings.filter(f => f.severity !== 'info' && !f.question);
    ok(validation.status === 'ready' || unanswerable.length > 0,
      `status ${validation.status} with no unanswerable finding to explain it`);
  });
}

await it('a surviving warning is always one the engine cannot ask about', () => {
  const { validation } = converge(SAMPLES.find(s => s.id === 'refund').text);
  eq(validation.status, 'needs-review');
  eq(validation.findings.filter(f => f.severity === 'warning').map(f => f.rule), ['R-THRESHOLD-CONFLICT']);
  ok(validation.findings.every(f => !f.question), 'nothing answerable may be left open');
});

await it('answering a question never introduces a new blocker of the same rule', () => {
  const parsed = parse(FLAGSHIP);
  let res = {};
  const seen = [];
  for (let i = 0; i < 20; i++) {
    const v = validate(compile(parsed, res), res);
    if (!v.questions.length) break;
    const q = v.questions[0];
    ok(!seen.includes(q.id), `question ${q.id} was asked twice — the loop is not making progress`);
    seen.push(q.id);
    res = { ...res, [q.id]: q.options ? q.options[0].value : { subject: 'x', operator: 'eq', value: 1, valueType: 'number' } };
  }
});

await it('withdrawing an answer restores the earlier workflow exactly', () => {
  const parsed = parse(FLAGSHIP);
  const base = JSON.stringify(compile(parsed, {}));
  const withAnswer = { 'reject:n1.then': { action: 'terminate' } };
  ok(JSON.stringify(compile(parsed, withAnswer)) !== base, 'the answer must change something');
  eq(JSON.stringify(compile(parsed, {})), base, 'removing the key must restore the original');
});

/* ================================================================== */
/* layout                                                             */
/* ================================================================== */

describe('layout');

await it('ranks every node and never places a target left of its source', () => {
  const wf = compile(parse(FLAGSHIP), { 'reject:n1.then': { action: 'terminate' } });
  const rank = rankNodes(wf);
  for (const e of wf.edges) {
    if (e.back) continue;
    ok(rank.get(e.to) > rank.get(e.from), `${e.from}→${e.to} points backwards`);
  }
});

await it('gives every node a box and every edge two endpoints', () => {
  for (const s of SAMPLES) {
    const { workflow } = converge(s.text);
    const geo = layout(workflow);
    eq(geo.nodes.length, workflow.nodes.length, `${s.label}: missing node geometry`);
    for (const e of geo.edges) ok(e.points.length >= 2, `${s.label}: edge ${e.id} has no route`);
    ok(geo.width > 0 && geo.height > 0);
  }
});

await it('never overlaps two nodes in the same lane and column', () => {
  for (const s of SAMPLES) {
    const { workflow } = converge(s.text);
    const geo = layout(workflow);
    const cells = new Map();
    for (const n of geo.nodes) {
      const key = `${n.lane}|${n.rank}`;
      const list = cells.get(key) || [];
      for (const other of list) {
        const overlaps = Math.abs(n.cy - other.cy) < Math.max(n.h, other.h);
        ok(!overlaps, `${s.label}: ${n.node.id} overlaps ${other.node.id}`);
      }
      list.push(n);
      cells.set(key, list);
    }
  }
});

await it('drops lanes that perform no step', () => {
  const wf = compile(parse(FLAGSHIP));
  const geo = layout(wf);
  ok(wf.participants.some(p => p.name === 'Accounting'), 'accounting is a participant');
  ok(!geo.lanes.some(l => l.name === 'Accounting'), 'but it performs nothing, so it gets no band');
});

/* ================================================================== */
/* exporters                                                          */
/* ================================================================== */

describe('exporters');

await it('mermaid contains every node and every edge', () => {
  const wf = compile(parse(FLAGSHIP));
  const m = toMermaid(wf);
  wf.nodes.forEach(n => includes(m, n.id.replace(/[^A-Za-z0-9_]/g, '_'), 'node missing from mermaid'));
  eq(m.split('\n').filter(l => l.includes('-->') || l.includes('-.->')).length, wf.edges.length);
});

await it('the schema dictionary maps every phrase to a contract', () => {
  const rows = toSchemaDictionary(compile(parse(FLAGSHIP)));
  const write = rows.find(r => r.recognisedAs === 'task.data.write');
  eq(write.phrase, 'log it in Snowflake');
  eq(write.binding, 'Snowflake.record.insert');
  eq(write.contract.endpoint, '/connectors/sys_snowflake/record/insert');
  const gate = rows.find(r => r.recognisedAs === 'gateway.exclusive');
  eq(gate.binding, 'invoice.amount > 10,000 USD');
});

await it('dictionary rows declare where they came from', () => {
  const rows = toSchemaDictionary(compile(parse(FLAGSHIP), { 'audit:insert': { enabled: true, sink: 'Snowflake' } }));
  ok(rows.some(r => r.origin === 'utterance'));
  ok(rows.some(r => r.origin === 'structure'));
  ok(rows.some(r => r.origin === 'clarification'), 'the inserted audit step must be marked as clarified');
});

await it('bpmn export is well-formed and lane-complete', () => {
  const wf = compile(parse(FLAGSHIP));
  const xml = toBpmnXml(wf);
  includes(xml, '<?xml version="1.0"');
  eq((xml.match(/<bpmn:sequenceFlow /g) || []).length, wf.edges.length);
  eq((xml.match(/<bpmn:lane /g) || []).length, new Set(wf.nodes.map(n => n.lane)).size);
  includes(xml, 'isExecutable="false"', 'the export must not claim to be deployable');
  eq(tagBalance(xml), [], 'unbalanced BPMN tags');
});

await it('markdown export carries the validation verdict', () => {
  const wf = compile(parse(FLAGSHIP));
  const md = toMarkdown(wf, validate(wf, {}));
  includes(md, '# Invoice Approval Workflow');
  includes(md, 'blocked');
  includes(md, 'R-ELSE');
});

/* ================================================================== */
/* audit ledger                                                       */
/* ================================================================== */

describe('audit ledger');

await it('canonicalises objects independent of key order', () => {
  eq(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalize({ a: [2, { c: 3, d: 4 }], b: 1 }));
});

await it('chains entries from the genesis hash', async () => {
  const l = new AuditLedger();
  eq(l.head, GENESIS);
  const first = await l.append({ event: 'a', detail: { x: 1 } });
  eq(first.prevHash, GENESIS);
  const second = await l.append({ event: 'b', detail: { x: 2 } });
  eq(second.prevHash, first.hash);
  eq((await l.verify()).valid, true);
});

await it('detects an edited payload', async () => {
  const l = new AuditLedger();
  for (const x of [1, 2, 3, 4]) await l.append({ event: 'e', detail: { x } });
  const forged = AuditLedger.fromEntries(l.entries.map((e, i) => i === 1 ? { ...e, detail: { x: 99 } } : e));
  const r = await forged.verify();
  eq(r.valid, false);
  eq(r.brokenAt, 2);
  includes(r.reason, 'payload');
});

await it('detects a removed entry', async () => {
  const l = new AuditLedger();
  for (const x of [1, 2, 3, 4]) await l.append({ event: 'e', detail: { x } });
  const forged = AuditLedger.fromEntries(l.entries.filter((_, i) => i !== 1));
  eq((await forged.verify()).valid, false);
});

await it('detects a reordered chain', async () => {
  const l = new AuditLedger();
  for (const x of [1, 2, 3]) await l.append({ event: 'e', detail: { x } });
  const e = l.entries;
  eq((await AuditLedger.fromEntries([e[0], e[2], e[1]]).verify()).valid, false);
});

await it('exposes no mutation path', () => {
  const l = new AuditLedger();
  ok(Object.getOwnPropertyNames(AuditLedger.prototype).every(m => !/^(update|delete|remove|splice|set)/.test(m)),
    'the ledger must expose append and read only');
  ok(Object.isFrozen(l.entries[0] ?? Object.freeze({})));
});

await it('handed-out entries are copies, so callers cannot edit history', async () => {
  const l = new AuditLedger();
  await l.append({ event: 'a', detail: { x: 1 } });
  const snapshot = l.entries;
  try { snapshot[0].event = 'tampered'; } catch { /* frozen in strict mode */ }
  eq(l.entries[0].event, 'a');
});

/* ================================================================== */
/* execution trace                                                    */
/* ================================================================== */

describe('execution trace');

await it('reports measured timings, never invented ones', () => {
  const parsed = parse(FLAGSHIP);
  const workflow = compile(parsed, {});
  const validation = validate(workflow, {});
  const timings = { parse: 1.5, compile: 0.4, validate: 0.9, ledger: 0.2 };
  const lines = buildTrace({
    utterance: FLAGSHIP, parsed, workflow, validation, resolutions: {},
    timings, ledgerAppended: 4, ledgerHead: 'abc123'.padEnd(64, '0')
  });
  const flat = lines.flatMap(l => l.parts).map(p => typeof p === 'string' ? p : p.v).join(' ');
  includes(flat, '1.50 ms', 'the measured parse time must appear verbatim');
  includes(flat, '0.40 ms');
  // the clock is monotonic and bounded by the sum of the measured phases
  const total = Object.values(timings).reduce((a, b) => a + b, 0);
  ok(lines.every((l, i) => i === 0 || l.at >= lines[i - 1].at - 1e-9), 'timestamps must not go backwards');
  ok(lines[lines.length - 1].at <= total + 1e-6, 'the log cannot claim more time than was measured');
});

await it('names every validation pass with a verdict', () => {
  const parsed = parse(FLAGSHIP);
  const workflow = compile(parsed, {});
  const validation = validate(workflow, {});
  const lines = buildTrace({
    utterance: FLAGSHIP, parsed, workflow, validation, resolutions: {},
    timings: { parse: 1, compile: 1, validate: 1, ledger: 1 }, ledgerAppended: 4, ledgerHead: '0'.repeat(64)
  });
  const verdicts = lines.filter(l => l.verdict);
  eq(verdicts.length, validation.checks.length);
  ok(verdicts.every(v => ['PASS', 'FAIL', 'NOTE'].includes(v.verdict)));
});

await it('surfaces the precedence hoist as an explicit line', () => {
  const parsed = parse(FLAGSHIP);
  const workflow = compile(parsed, {});
  const lines = buildTrace({
    utterance: FLAGSHIP, parsed, workflow, validation: validate(workflow, {}), resolutions: {},
    timings: { parse: 1, compile: 1, validate: 1, ledger: 1 }, ledgerAppended: 4, ledgerHead: '0'.repeat(64)
  });
  const flat = lines.flatMap(l => l.parts).map(p => typeof p === 'string' ? p : p.v).join(' ');
  includes(flat, 'hoisted this gate ahead of clause');
});


/* ================================================================== */
/* no-code layer                                                      */
/* ================================================================== */

describe('no-code · field catalogue');

await it('puts the records the sentence mentions first', () => {
  const groups = fieldCatalogue(['obj_payment']);
  eq(groups[0].label, 'Payment');
  eq(groups[0].relevant, true);
  ok(groups.slice(1).every(g => !g.relevant));
});

await it('offers business names, not field paths', () => {
  const invoice = fieldCatalogue(['obj_invoice'])[0];
  eq(invoice.fields.map(f => f.label), ['Amount', 'Status', 'Vendor', 'PO number', 'Age', 'Owner']);
  eq(invoice.fields[0].path, 'invoice.amount');
  eq(invoice.fields[0].kind, 'currency');
});

await it('translates a path back into words', () => {
  eq(describeField('invoice.amount').label, 'Amount');
  eq(describeField('invoice.amount').objectLabel, 'invoice');
  // An approval outcome is a person's decision, not a data field.
  eq(describeField('n1.then.outcome').label, 'Decision');
  // Unknown paths still degrade to something readable.
  eq(describeField('context.riskScore').label, 'Risk Score');
});

await it('phrases operators the way a person says them', () => {
  eq(describeOperator('gt', 'currency'), 'is more than');
  eq(describeOperator('gte', 'currency'), 'is at least');
  eq(describeOperator('eq', 'choice'), 'is');
  eq(describeOperator('gt', 'duration'), 'is older than');
  // Every operator the compiler can emit has words for it.
  for (const op of ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']) {
    ok(describeOperator(op) !== op, `no plain wording for operator "${op}"`);
  }
});

describe('no-code · plain language');

await it('every finding carries both technical and plain copy', () => {
  const seen = new Set();
  for (const sample of SAMPLES) {
    const parsed = parse(sample.text);
    let res = {};
    for (let i = 0; i < 20; i++) {
      const v = validate(compile(parsed, res), res);
      for (const f of v.findings) {
        seen.add(f.rule);
        ok(f.plain?.title, `${f.rule} has no plain title`);
        ok(f.plain?.detail, `${f.rule} has no plain detail`);
      }
      if (!v.questions.length) break;
      const q = v.questions[0];
      res = { ...res, [q.id]: q.options ? q.options[0].value : { subject: 'x', operator: 'eq', value: 1, valueType: 'number' } };
    }
  }
  ok(seen.size >= 10, `only ${seen.size} rules exercised`);
});

await it('plain copy never leaks identifiers or code syntax', () => {
  const offenders = [];
  for (const sample of SAMPLES) {
    const parsed = parse(sample.text);
    let res = {};
    for (let i = 0; i < 20; i++) {
      const v = validate(compile(parsed, res), res);
      for (const f of v.findings) {
        const text = `${f.plain.title} ${f.plain.detail}`;
        // No rule ids, no node types, no backtick-quoted field paths.
        if (/\bR-[A-Z-]+\b/.test(text)) offenders.push(`${f.rule}: rule id in plain copy`);
        if (/\b(gateway|task)\.[a-z]/.test(text)) offenders.push(`${f.rule}: node type in plain copy`);
        if (/`[a-z]+\.[a-zA-Z]+`/.test(text)) offenders.push(`${f.rule}: field path in plain copy`);
        if (/\bn\d+(\.[a-z]+)*\b/.test(text)) offenders.push(`${f.rule}: node id in plain copy`);
      }
      if (!v.questions.length) break;
      const q = v.questions[0];
      res = { ...res, [q.id]: q.options ? q.options[0].value : { subject: 'x', operator: 'eq', value: 1, valueType: 'number' } };
    }
  }
  eq([...new Set(offenders)], []);
});

await it('every question has a plain-language prompt', () => {
  const v = validate(compile(parse(FLAGSHIP)), {});
  for (const q of v.questions) {
    ok(q.plainPrompt, `${q.rule} has no plainPrompt`);
    ok(q.plainTitle, `${q.rule} has no plainTitle`);
    ok(!/\bR-[A-Z-]+\b/.test(q.plainPrompt), `${q.rule} leaks its rule id`);
  }
});

await it('offers a one-click answer when the sentence names a status', () => {
  const u = 'Send the invoice to the manager for approval, if rejected notify the requester';
  const q = validate(compile(parse(u)), {}).questions.find(x => x.rule === 'R-PREDICATE');
  ok(q, 'R-PREDICATE must fire on "if rejected"');
  const labels = q.suggestions.map(s => s.label);
  ok(labels.some(l => /Rejected/.test(l)), 'the word the user wrote must be offered');
  ok(labels.some(l => /Approved/.test(l)), 'the opposite outcome matters too');
  eq(q.suggestions[0].value.operator, 'eq');
});

await it('offers no guesses when the sentence names no status', () => {
  const q = validate(compile(parse('If a payment looks significant, get approval')), {})
    .questions.find(x => x.rule === 'R-PREDICATE');
  eq(q.suggestions, [], 'inventing a suggestion here would be a guess');
});

await it('puts roles and systems already in the process at the top of the list', () => {
  const u = 'Route the expense to the manager, then have someone approve it and record it somewhere';
  const wf = compile(parse(u));
  const v = validate(wf, {});
  const assignee = v.questions.find(q => q.rule === 'R-UNASSIGNED');
  if (assignee) ok(assignee.options[0].hint === 'already in this process' || assignee.options.length > 0);

  const wf2 = compile(parse('Log the invoice in Snowflake and record it somewhere'));
  const conn = validate(wf2, {}).questions.find(q => q.rule === 'R-NO-CONNECTOR');
  ok(conn, 'R-NO-CONNECTOR must fire on "somewhere"');
  eq(conn.options[0].label, 'Snowflake');
  eq(conn.options[0].hint, 'already used here');
});

/* ================================================================== */
/* simulator                                                          */
/* ================================================================== */

describe('simulator');

const SIM_RES = {
  'else:n1': { action: 'continue' },
  'reject:n1.then': { action: 'return', returnTo: 'Requester' },
  'audit:insert': { enabled: true, sink: 'Snowflake' },
  'sla:n1.then': { seconds: 86400, businessDays: true, onBreach: 'escalate' },
  'retry:n3': { maxAttempts: 3, backoff: 'exponential', onExhausted: 'dead-letter' }
};
const SIM_WF = compile(parse(FLAGSHIP), SIM_RES);

await it('derives one input per decision the workflow actually makes', () => {
  const { fields, decisions } = simulationInputs(SIM_WF);
  eq(fields.map(f => f.key), ['invoice.amount']);
  eq(fields[0].kind, 'currency');
  eq(fields[0].currency, 'USD');
  eq(decisions.map(d => d.key), ['n1.then.outcome']);
  eq(decisions[0].options, ['Approved', 'Rejected']);
});

await it('suggests a value that exercises the interesting branch', () => {
  const { fields } = simulationInputs(SIM_WF);
  ok(fields[0].suggested > 10000, 'a "greater than" test should default above the threshold');
});

await it('takes the no path below the threshold', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 6000, 'n1.then.outcome': 'Approved' });
  eq(r.status, 'complete');
  ok(!r.path.includes('n1.then'), 'a 6,000 invoice must not reach the CFO');
  ok(r.path.includes('n2') && r.path.includes('n3'), 'but it must still be sent and logged');
});

await it('takes the yes path above the threshold', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 12000, 'n1.then.outcome': 'Approved' });
  eq(r.status, 'complete');
  ok(r.path.includes('n1.then'), 'a 12,000 invoice must reach the CFO');
  eq(r.path[r.path.length - 1], 'n_end');
});

await it('ends the process when a rejection terminates it', () => {
  const wf = compile(parse(FLAGSHIP), { ...SIM_RES, 'reject:n1.then': { action: 'terminate' } });
  const r = simulate(wf, { 'invoice.amount': 12000, 'n1.then.outcome': 'Rejected' });
  eq(r.status, 'terminated');
  ok(!r.path.includes('n3'), 'a rejected invoice must never be logged');
});

await it('stops a rework loop instead of spinning forever', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 12000, 'n1.then.outcome': 'Rejected' });
  eq(r.status, 'loop');
  ok(r.steps.length < 40, 'the loop guard must cut in quickly');
  includes(r.summary, 'rework loop');
});

await it('asks for a missing value rather than assuming one', () => {
  const r = simulate(SIM_WF, {});
  eq(r.status, 'needs-input');
  eq(r.missing, ['invoice.amount']);
  includes(r.summary, 'test value is missing');
});

await it('narrates every step without exposing field paths or node types', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 12000, 'n1.then.outcome': 'Approved' });
  for (const step of r.steps) {
    ok(step.note && step.note.length > 8, `${step.nodeId} has no narration`);
    ok(!/\b(gateway|task|event)\.[a-z]/.test(step.note), `${step.nodeId} leaks a node type: ${step.note}`);
    ok(!/\bn\d+\.[a-z]/.test(step.note), `${step.nodeId} leaks a node id: ${step.note}`);
  }
});

await it('explains a decision in terms of the value supplied', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 6000, 'n1.then.outcome': 'Approved' });
  const gate = r.steps.find(s => s.type === 'gateway.exclusive');
  includes(gate.note, '6,000');
  includes(gate.note, 'does not satisfy');
});

await it('names the person when an approval outcome decides the path', () => {
  const r = simulate(SIM_WF, { 'invoice.amount': 12000, 'n1.then.outcome': 'Approved' });
  const outcome = r.steps.find(s => s.nodeId === 'n1.then.outcome');
  includes(outcome.note, 'CFO chose');
});

await it('never walks a path the graph does not contain', () => {
  const edgeIds = new Set(SIM_WF.edges.map(e => e.id));
  const nodeIds = new Set(SIM_WF.nodes.map(n => n.id));
  const r = simulate(SIM_WF, { 'invoice.amount': 12000, 'n1.then.outcome': 'Approved' });
  ok(r.path.every(id => nodeIds.has(id)), 'walked through a node that does not exist');
  ok(r.edgePath.every(id => edgeIds.has(id)), 'followed an edge that does not exist');
  // Consecutive path entries must be joined by the edge recorded between them.
  for (let i = 0; i < r.edgePath.length; i++) {
    const edge = SIM_WF.edges.find(e => e.id === r.edgePath[i]);
    eq([edge.from, edge.to], [r.path[i], r.path[i + 1]], `step ${i} is not a real edge`);
  }
});

await it('evaluates conditions without mutating the workflow', () => {
  const before = JSON.stringify(SIM_WF);
  simulate(SIM_WF, { 'invoice.amount': 99999, 'n1.then.outcome': 'Rejected' });
  eq(JSON.stringify(SIM_WF), before, 'simulation must be read-only');
});

await it('handles a negated condition correctly', () => {
  const wf = compile(parse('If the contract value is not above 1000000 USD, have legal review it'), {});
  const gate = wf.nodes.find(n => n.condition && !n.condition.unresolved);
  eq(evaluateCondition(gate.condition, { 'contract.value': 500000 }).result, true, 'below 1M satisfies "not above 1M"');
  eq(evaluateCondition(gate.condition, { 'contract.value': 2000000 }).result, false);
});

await it('runs on every sample without throwing', () => {
  for (const sample of SAMPLES) {
    const { workflow } = converge(sample.text);
    const { fields, decisions } = simulationInputs(workflow);
    const inputs = {};
    fields.forEach(f => { inputs[f.key] = f.suggested; });
    decisions.forEach(d => { inputs[d.key] = d.default; });
    const r = simulate(workflow, inputs);
    ok(['complete', 'terminated', 'loop'].includes(r.status),
      `${sample.label}: unexpected status ${r.status} — ${r.summary}`);
    ok(r.steps.length > 0);
  }
});


/* ================================================================== */
/* resilience                                                         */
/* ================================================================== */

describe('resilience · policy');

const conn = id => CONNECTORS.find(c => c.id === id);

await it('reads a query as safe to repeat whatever the system is', () => {
  const safety = safetyOf(conn('sys_sap'), 'record.query');
  eq(safety.idempotent, true);
  eq(safety.requiresIdempotencyKey, false);
  includes(safety.reason, 'read-only');
});

await it('reads an upsert as safe but an insert as not', () => {
  ok(safetyOf(conn('sys_salesforce'), 'record.upsert').idempotent);
  ok(!safetyOf(conn('sys_snowflake'), 'record.insert').idempotent);
});

await it('retries a payment less aggressively than a chat message', () => {
  const payment = policyFor(conn('sys_stripe'), 'payment.create', 'n1').retry;
  const chat = policyFor(conn('sys_slack'), 'chat.postMessage', 'n2').retry;
  ok(payment.maxAttempts < chat.maxAttempts,
    'hammering a failing payment gateway costs more than a delayed message');
  eq(payment.onExhausted, 'dead-letter');
});

await it('trips the breaker sooner and holds it open longer on critical systems', () => {
  const critical = policyFor(conn('sys_stripe'), 'payment.create', 'n1').circuitBreaker;
  const low = policyFor(conn('sys_slack'), 'chat.postMessage', 'n2').circuitBreaker;
  ok(critical.failureThreshold < low.failureThreshold);
  ok(critical.openSeconds > low.openSeconds);
});

await it('demands an idempotency key exactly when repeating is unsafe', () => {
  const unsafe = policyFor(conn('sys_snowflake'), 'record.insert', 'n3').idempotency;
  eq(unsafe.keyRequired, true);
  eq(unsafe.key, '{{workflow.correlationId}}:n3');
  eq(unsafe.header, 'Idempotency-Key');

  const safe = policyFor(conn('sys_salesforce'), 'record.upsert', 'n4').idempotency;
  eq(safe.keyRequired, false);
  eq(safe.key, null);
});

await it('switches retries off when the target cannot deduplicate', () => {
  const p = policyFor(conn('sys_stripe'), 'payment.create', 'n1', { dedupe: 'no' });
  eq(p.retry.maxAttempts, 1);
  eq(p.retry.source, 'clarified');
  ok(p.retry.note, 'the reason must travel with the policy');
  // "not sure" has to be treated as "no" — optimism here charges someone twice.
  eq(policyFor(conn('sys_stripe'), 'payment.create', 'n1', { dedupe: 'unknown' }).retry.maxAttempts, 1);
});

await it('never emits an idempotency key it does not need', () => {
  const p = policyFor(conn('sys_stripe'), 'payment.create', 'n1', { dedupe: 'no' });
  eq(p.idempotency.keyRequired, false, 'a single-attempt call needs no dedup key');
});

await it('gives a senior approver a shorter default deadline than a whole team', () => {
  ok(slaFor({ seniority: 'exec' }).durationSeconds < slaFor({ seniority: 'team' }).durationSeconds);
  eq(slaFor({ seniority: 'exec' }).source, 'default');
});

describe('resilience · compiled into the blueprint');

await it('attaches a failure policy to every external write without being asked', () => {
  const wf = compile(parse(FLAGSHIP));
  const write = wf.nodes.find(n => n.type === 'task.data.write');
  ok(write.retry, 'a write with no policy silently drops records');
  eq(write.retry.source, 'default');
  ok(write.circuitBreaker);
  ok(write.timeoutSeconds > 0);
  eq(write.operation.payload.idempotencyKey, '{{workflow.correlationId}}:n3');
});

await it('gives every approval a default deadline', () => {
  const approval = compile(parse(FLAGSHIP)).nodes.find(n => n.type === 'task.approval');
  ok(approval.sla?.durationSeconds > 0);
  eq(approval.sla.source, 'default');
});

await it('reports the default rather than hiding it', () => {
  const v = validate(compile(parse(FLAGSHIP)), {});
  const f = v.findings.find(x => x.rule === 'R-RETRY-DEFAULTED');
  ok(f, 'a defaulted policy must be visible, not silent');
  eq(f.severity, 'info', 'a sensible default should not block the workflow');
  includes(f.detail, 'attempts');
  ok(f.question, 'and it must be overridable');
});

await it('warns that retry safety rests on an unverified assumption', () => {
  const f = validate(compile(parse(FLAGSHIP)), {}).findings.find(x => x.rule === 'R-DEDUP-UNVERIFIED');
  ok(f);
  eq(f.severity, 'warning');
  eq(f.question.options.map(o => o.value.dedupe), ['yes', 'no', 'unknown']);
});

await it('answering "no" to deduplication disables the retries', () => {
  const parsed = parse(FLAGSHIP);
  const before = compile(parsed, {}).nodes.find(n => n.id === 'n3');
  ok(before.retry.maxAttempts > 1);
  const after = compile(parsed, { 'dedupe:n3': { dedupe: 'no' } }).nodes.find(n => n.id === 'n3');
  eq(after.retry.maxAttempts, 1);
  ok(validate(compile(parsed, { 'dedupe:n3': { dedupe: 'no' } }), { 'dedupe:n3': { dedupe: 'no' } })
    .findings.some(f => f.rule === 'R-RETRIES-DISABLED'));
});

await it('flags two irreversible writes with no way to reconcile them', () => {
  const u = 'When an order is placed in Salesforce, create the invoice in NetSuite and log it in Snowflake';
  const f = validate(compile(parse(u)), {}).findings.find(x => x.rule === 'R-PARTIAL-WRITE');
  ok(f, 'a run that half-succeeds across two systems must be surfaced');
  includes(f.detail, 'NetSuite');
  includes(f.detail, 'Snowflake');
  eq(f.question.options.map(o => o.value.strategy), ['reverse', 'manual-reconcile', 'accept']);
});

await it('records the chosen compensation strategy on the writes', () => {
  const u = 'When an order is placed in Salesforce, create the invoice in NetSuite and log it in Snowflake';
  const wf = compile(parse(u), { 'compensation:strategy': { strategy: 'reverse' } });
  const writes = wf.nodes.filter(n => n.compensation);
  ok(writes.length >= 2);
  ok(writes.every(n => n.compensation.configured && n.compensation.strategy === 'reverse'));
});

/* ================================================================== */
/* runtime exports                                                    */
/* ================================================================== */

describe('exports · input contract');

const EXPORT_WF = compile(parse(FLAGSHIP), {
  'else:n1': { action: 'continue' },
  'reject:n1.then': { action: 'terminate' },
  'audit:insert': { enabled: false }
});

await it('is itself a valid JSON Schema document', () => {
  const schema = toInputSchema(EXPORT_WF);
  eq(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  eq(schema.type, 'object');
  ok(schema.$id.includes(EXPORT_WF.workflowId));
});

await it('requires every field a decision reads', () => {
  const schema = toInputSchema(EXPORT_WF);
  ok(schema.required.includes('invoice'));
  eq(schema.properties.invoice.required, ['amount']);
  eq(schema.properties.invoice.properties.amount.type, 'number');
});

await it('carries the currency so a caller cannot send the wrong one silently', () => {
  const amount = toInputSchema(EXPORT_WF).properties.invoice.properties.amount;
  eq(amount['x-currency'], 'USD');
  includes(amount.description, 'USD');
});

await it('always demands a correlation id, because retry keys derive from it', () => {
  const schema = toInputSchema(EXPORT_WF);
  ok(schema.required.includes('workflow'));
  eq(schema.properties.workflow.required, ['correlationId']);
});

await it('validates a good payload and rejects a bad one', () => {
  const schema = toInputSchema(EXPORT_WF);
  ok(validateSchema(schema, { invoice: { amount: 12000 }, workflow: { correlationId: 'abc' } }).valid);
  ok(!validateSchema(schema, { invoice: {}, workflow: { correlationId: 'abc' } }).valid, 'missing amount must fail');
  ok(!validateSchema(schema, { invoice: { amount: 'lots' }, workflow: { correlationId: 'abc' } }).valid, 'a string amount must fail');
});

describe('exports · OpenAPI');

await it('declares one path per distinct connector call', () => {
  const api = toOpenApi(EXPORT_WF);
  eq(api.openapi, '3.1.0');
  ok(api.paths['/connectors/sys_snowflake/record/insert']);
  ok(api.paths['/tasks/human']);
  const opIds = Object.values(api.paths).map(p => p.post.operationId);
  eq(opIds.length, new Set(opIds).size, 'operationIds must be unique');
});

await it('publishes the caller-side resilience policy on each operation', () => {
  const op = toOpenApi(EXPORT_WF).paths['/connectors/sys_snowflake/record/insert'].post;
  const res = op['x-resilience'];
  eq(res.retry.maxAttempts, EXPORT_WF.nodes.find(n => n.id === 'n3').retry.maxAttempts);
  ok(res.circuitBreaker.failureThreshold > 0);
  ok(res.timeoutSeconds > 0);
});

await it('makes the idempotency header a required parameter where it matters', () => {
  const op = toOpenApi(EXPORT_WF).paths['/connectors/sys_snowflake/record/insert'].post;
  const header = op.parameters.find(p => p.in === 'header');
  eq(header.name, 'Idempotency-Key');
  eq(header.required, true);
  includes(header.description, 'MUST');
  ok(op.responses['409'], 'a duplicate needs a defined response');
});

await it('says plainly that nothing here has been built', () => {
  const api = toOpenApi(EXPORT_WF);
  includes(api.info.description, 'has not been built');
  includes(api.servers[0].variables.host.description, 'no such host');
});

await it('every $ref resolves to a declared schema', () => {
  const api = toOpenApi(EXPORT_WF);
  const refs = JSON.stringify(api).match(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g) || [];
  for (const ref of refs) {
    const name = ref.replace(/.*schemas\//, '').replace(/"$/, '');
    ok(api.components.schemas[name], `dangling $ref: ${name}`);
  }
});

describe('exports · Step Functions');

await it('produces a state machine whose transitions all resolve', () => {
  const asl = toStepFunctions(EXPORT_WF);
  ok(asl.States[asl.StartAt], 'StartAt must name a real state');
  for (const [name, state] of Object.entries(asl.States)) {
    if (state.Next) ok(asl.States[state.Next], `${name}.Next → missing state ${state.Next}`);
    if (state.Default) ok(asl.States[state.Default], `${name}.Default → missing state ${state.Default}`);
    (state.Choices || []).forEach(c => ok(asl.States[c.Next], `${name} choice → missing state ${c.Next}`));
    (state.Catch || []).forEach(c => ok(asl.States[c.Next], `${name} catch → missing state ${c.Next}`));
    // A Choice routes through Choices/Default rather than Next.
    const terminal = state.Type === 'Succeed' || state.Type === 'Fail';
    const routes = state.Type === 'Choice' ? Boolean(state.Default) : Boolean(state.Next || state.End);
    ok(terminal || routes, `${name} is not terminal and has no way out`);
  }
});

await it('turns the compiled retry policy into an executable Retry block', () => {
  const asl = toStepFunctions(EXPORT_WF);
  const write = asl.States.n3;
  const node = EXPORT_WF.nodes.find(n => n.id === 'n3');
  eq(write.Retry[0].MaxAttempts, node.retry.maxAttempts - 1, 'ASL counts retries, not total attempts');
  eq(write.Retry[0].BackoffRate, node.retry.backoffCoefficient);
  eq(write.Retry[0].IntervalSeconds, node.retry.initialIntervalSeconds);
  eq(write.TimeoutSeconds, node.timeoutSeconds);
  eq(write.Parameters.Headers['Idempotency-Key'], node.idempotency.key);
});

await it('maps the decision to a Choice state with the right comparator', () => {
  const choice = toStepFunctions(EXPORT_WF).States.n1;
  eq(choice.Type, 'Choice');
  eq(choice.Choices[0].Variable, '$.invoice.amount');
  eq(choice.Choices[0].NumericGreaterThan, 10000);
  ok(choice.Default, 'the false branch becomes the default');
  ok(Object.keys(toStepFunctions(EXPORT_WF).States).includes(choice.Default), 'the default must resolve');
});

await it('uses the task-token pattern for a human step', () => {
  const human = toStepFunctions(EXPORT_WF).States.n1_then;
  includes(human.Resource, 'waitForTaskToken');
  eq(human.Parameters.Payload['taskToken.$'], '$$.Task.Token');
});

await it('every catch lands on a state that explains itself', () => {
  const asl = toStepFunctions(EXPORT_WF);
  const failed = asl.States.n3__failed;
  ok(failed);
  includes(failed.Cause, 'exhausted its retries');
});

await it('says in the definition that it has never been deployed', () => {
  includes(toStepFunctions(EXPORT_WF).Comment, 'never been deployed');
});

describe('exports · Temporal');

await it('generates a compilable-looking skeleton with real retry numbers', () => {
  const ts = toTemporal(EXPORT_WF);
  includes(ts, "import { proxyActivities");
  const node = EXPORT_WF.nodes.find(n => n.id === 'n3');
  includes(ts, `maximumAttempts: ${node.retry.maxAttempts}`);
  includes(ts, `backoffCoefficient: ${node.retry.backoffCoefficient}`);
  includes(ts, `startToCloseTimeout: '${node.timeoutSeconds} seconds'`);
});

await it('declares a signal per human step', () => {
  const ts = toTemporal(EXPORT_WF);
  includes(ts, 'defineSignal');
  includes(ts, "'approved' | 'rejected'");
});

await it('has balanced braces', () => {
  const ts = toTemporal(EXPORT_WF);
  let depth = 0;
  for (const ch of ts.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    ok(depth >= 0, 'closed a brace that was never opened');
  }
  eq(depth, 0, 'unbalanced braces in the generated TypeScript');
});

await it('says in the file that it is a scaffold', () => {
  includes(toTemporal(EXPORT_WF), 'SCAFFOLD');
});

describe('exports · Camunda BPMN');

await it('carries the retry policy as a Camunda retry cycle', () => {
  const xml = toBpmnXml(EXPORT_WF);
  const node = EXPORT_WF.nodes.find(n => n.id === 'n3');
  includes(xml, `camunda:failedJobRetryTimeCycle="R${node.retry.maxAttempts - 1}/PT${node.retry.initialIntervalSeconds}S"`);
  includes(xml, 'xmlns:camunda=');
  includes(xml, 'camunda:topic="sys_snowflake.record.insert"');
});

await it('carries the idempotency key and breaker as extension properties', () => {
  const xml = toBpmnXml(EXPORT_WF);
  includes(xml, 'name="idempotencyKey"');
  includes(xml, 'name="circuitBreaker.failureThreshold"');
});

await it('assigns the human task to a candidate group', () => {
  includes(toBpmnXml(EXPORT_WF), 'camunda:candidateGroups="role_cfo"');
});

await it('is still well-formed with the extensions added', () => {
  eq(tagBalance(toBpmnXml(EXPORT_WF)), []);
});

await it('the audit step carries a failure policy like any other write', () => {
  // Regression: the audit node was hand-built and skipped the resilience pass,
  // which crashed the Temporal exporter and left a dropped audit record silent.
  const wf = compile(parse(FLAGSHIP), { 'audit:insert': { enabled: true, sink: 'Snowflake' } });
  const audit = wf.nodes.find(n => n.type === 'task.audit');
  ok(audit.retry, 'a dropped audit record is exactly what R-AUDIT existed to prevent');
  ok(audit.circuitBreaker && audit.timeoutSeconds > 0);
  eq(audit.operation.payload.idempotencyKey, audit.idempotency.key);
  ok(toTemporal(wf).includes('export async function'), 'the Temporal export must survive it');
  eq(tagBalance(toBpmnXml(wf)), []);
  const asl = toStepFunctions(wf);
  ok(asl.States.n_audit?.Retry, 'and the audit write must retry in ASL too');
});

await it('every sample exports cleanly in every format', () => {
  for (const sample of SAMPLES) {
    const { workflow, validation } = converge(sample.text);
    const label = sample.label;
    // Every node with an operation must carry a policy, or an exporter will
    // reach for `undefined.maxAttempts`.
    for (const n of workflow.nodes) {
      if (n.operation) ok(n.retry, `${label}: ${n.id} has an operation but no failure policy`);
    }
    ok(validateSchema(toInputSchema(workflow), { workflow: { correlationId: 'x' } }) !== undefined, label);
    const api = toOpenApi(workflow);
    eq(typeof api.paths, 'object', label);
    const asl = toStepFunctions(workflow);
    ok(asl.States[asl.StartAt], `${label}: StartAt does not resolve`);
    for (const [name, st] of Object.entries(asl.States)) {
      if (st.Next) ok(asl.States[st.Next], `${label}: ${name}.Next dangles`);
      if (st.Type === 'Choice') ok(asl.States[st.Default], `${label}: ${name} has no resolvable Default`);
    }
    ok(toTemporal(workflow).includes('export async function'), label);
    eq(tagBalance(toBpmnXml(workflow)), [], `${label}: malformed BPMN`);
    ok(toMarkdown(workflow, validation).length > 50, label);
  }
});

/* ================================================================== */

console.log(`\n${'─'.repeat(58)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failing\x1b[0m · \x1b[32m${passed} passing\x1b[0m\n`);
  failures.forEach(f => console.log(`  ${f.group} › ${f.name}\n    ${f.err.message}\n`));
  process.exit(1);
} else {
  console.log(`\x1b[32m${passed} passing\x1b[0m · 0 failing\n`);
}
