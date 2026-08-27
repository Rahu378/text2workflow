/**
 * app.js — workspace wiring.
 *
 * The whole application is one pure function of two values:
 *
 *     utterance + resolutions  →  workflow + validation
 *
 * Answering a clarifying question adds a key to `resolutions` and re-runs the
 * pipeline from the raw sentence. Nothing is patched in place, so withdrawing
 * an answer is just deleting the key. That is what makes the loop reviewable:
 * the compiled workflow is always fully explained by the sentence plus the
 * visible list of answers.
 */

import { parse } from './parser.js';
import { compile } from './compiler.js';
import { validate, RULES } from './validator.js';
import { renderSwimlane, svgToFile } from './render.js';
import { toMermaid, toSchemaDictionary, toBpmnXml, toMarkdown } from './exporters.js';
import { toInputSchema, toOpenApi, toStepFunctions, toTemporal } from './exporters-runtime.js';
import { describeRetry, describeBreaker } from './resilience.js';
import { AuditLedger, AUDIT_EVENTS } from './audit.js';
import { SAMPLES } from './samples.js';
import { COMPARATORS, fieldCatalogue, describeField, describeOperator, FRIENDLY_OPERATORS, STATUS_VALUES } from './lexicon.js';
import { buildTrace } from './trace.js';
import { simulate, simulationInputs, narrateNode, humanDuration } from './simulate.js';

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  utterance: '',
  resolutions: {},
  parsed: null,
  workflow: null,
  validation: null,
  selectedNode: null,
  zoom: null,          // null = fit to pane
  ledger: new AuditLedger(),
  streamToken: 0,      // cancels an in-flight log stream when a new run starts

  // Plain English is the default. Technical mode is for the engineer who picks
  // the work up afterwards, not for the person describing the process.
  mode: 'plain',

  sim: { inputs: {}, result: null, cursor: 0, playing: false, timer: null },
  exportFormat: 'mermaid'
};

/**
 * Export formats.
 *
 * `note` is not decoration: each of these is a specification or a scaffold, and
 * the caveat needs to be on screen next to the download button rather than in a
 * document nobody opens.
 */
const FORMATS = {
  mermaid: {
    label: 'Mermaid', ext: 'mmd', mime: 'text/plain', lang: 'text',
    build: wf => toMermaid(wf),
    hint: 'Paste into any Markdown renderer that supports Mermaid.',
    note: 'The same graph as the Blueprint, as text. Safe to paste into a ticket, a PR description or a wiki page.'
  },
  openapi: {
    label: 'OpenAPI 3.1', ext: 'openapi.json', mime: 'application/json', lang: 'json',
    build: wf => JSON.stringify(toOpenApi(wf), null, 2),
    hint: 'One path per connector call, plus the engine\'s own task endpoints.',
    note: '<strong>This describes an interface that has not been built.</strong> Every path is a contract the workflow expects a platform team to implement — no credential has been issued and no call has ever been made. The <code>x-resilience</code> block on each operation carries the retry, circuit-breaker and idempotency policy the caller applies, so the implementer knows what behaviour it must tolerate.'
  },
  inputschema: {
    label: 'Input contract', ext: 'input.schema.json', mime: 'application/json', lang: 'json',
    build: wf => JSON.stringify(toInputSchema(wf), null, 2),
    hint: 'JSON Schema 2020-12 for the payload that starts a run.',
    note: 'Every property here is read by a decision in the workflow, so all of them are required — a payload missing one produces a run that cannot evaluate its own gateways. Validate incoming requests against this before starting a workflow.'
  },
  stepfunctions: {
    label: 'Step Functions', ext: 'asl.json', mime: 'application/json', lang: 'json',
    build: wf => JSON.stringify(toStepFunctions(wf), null, 2),
    hint: 'Amazon States Language — Choice states, Retry and Catch blocks.',
    note: '<strong>Placeholder ARNs — never deployed or executed.</strong> Substitute <code>${ConnectorBaseUrl}</code>, <code>${EventBridgeConnectionArn}</code> and <code>${HumanTaskFunctionArn}</code> before use. The <code>Retry</code> blocks are the compiled resilience policy expressed as executable configuration, and human steps use the <code>waitForTaskToken</code> pattern.'
  },
  temporal: {
    label: 'Temporal', ext: 'workflow.ts', mime: 'text/typescript', lang: 'ts',
    build: wf => toTemporal(wf),
    hint: 'TypeScript skeleton with real retry policies.',
    note: '<strong>A scaffold.</strong> The activity implementations in <code>./activities</code> are not written and this file has never run against a Temporal cluster. What is real are the <code>proxyActivities</code> retry policies and timeouts — those are the compiled resilience declarations, not defaults someone has to remember to change.'
  },
  bpmn: {
    label: 'BPMN 2.0', ext: 'bpmn', mime: 'application/xml', lang: 'xml',
    build: wf => toBpmnXml(wf),
    hint: 'Opens in Camunda Modeler or bpmn.io.',
    note: 'Carries the process, lanes, flow nodes and sequence flows, with Camunda extension attributes — <code>failedJobRetryTimeCycle</code> is the compiled retry policy in the form the engine reads. It contains no <code>BPMNDiagram</code> coordinates and is marked <code>isExecutable="false"</code>: a modelling handoff, not a deployable process archive.'
  },
  markdown: {
    label: 'Markdown', ext: 'md', mime: 'text/markdown', lang: 'md',
    build: (wf, v) => toMarkdown(wf, v),
    hint: 'Step table plus the open findings.',
    note: 'A summary for pasting into a ticket, including every finding that is still open.'
  }
};

const $ = id => document.getElementById(id);

/** Plain-English copy by default; the technical wording behind the toggle. */
const plain = () => state.mode === 'plain';
const copyOf = (obj, key) => plain() && obj.plain ? obj.plain[key] : obj[key];

/**
 * What to draw on a node.
 *
 * In plain mode a gateway reads "Invoice amount more than 10,000 USD?" instead
 * of `invoice.amount > 10,000 USD?`. The compiled JSON keeps the technical
 * name — only the drawing changes, so the diagram a BA signs off and the
 * document an engineer implements are still the same graph.
 */
function displayName(node) {
  if (!plain()) return node.name;
  const c = node.condition;
  if (node.type === 'gateway.exclusive' && c && !c.unresolved) {
    const f = describeField(c.subject);
    const kind = c.valueType === 'money' ? 'currency' : c.valueType === 'number' ? 'number' : f.kind;
    const rhs = (c.valueType === 'money' || c.valueType === 'number')
      ? Number(c.value).toLocaleString('en-US') + (c.currency ? ' ' + c.currency : '')
      : String(c.value);
    // An approval outcome reads as a question about a person, not a field.
    if (f.label === 'Decision') return `Did ${node.performer?.name || 'the approver'} approve?`;
    const subject = `${f.objectLabel} ${f.label.toLowerCase()}`;
    return `${subject.replace(/^./, ch => ch.toUpperCase())} ${describeOperator(c.operator, kind)} ${rhs}?`;
  }
  return node.name;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ------------------------------------------------------------------ */
/* toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, tone = 'info', ttl = 2600) {
  const t = el('div', 'toast');
  t.dataset.tone = tone;
  t.appendChild(el('i'));
  const body = el('span');
  body.textContent = message;
  t.appendChild(body);
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  }, ttl);
}

/* ------------------------------------------------------------------ */
/* pipeline                                                            */
/* ------------------------------------------------------------------ */

async function run({ logUtterance = false, announce = null } = {}) {
  const text = $('utterance').value.trim();
  if (!text) { toast('Describe a process first.', 'warn'); return; }

  const isNew = text !== state.utterance;
  if (isNew) {
    state.utterance = text;
    state.resolutions = {};
    state.selectedNode = null;
    state.zoom = null;
  }

  const before = state.ledger.length;
  $('liveBadge').dataset.running = 'true';
  $('liveBadge').textContent = '';
  $('liveBadge').append(el('i'), document.createTextNode('RUNNING'));

  // Real measurements — these are what the execution log reports.
  const t0 = performance.now();
  // Any change to the sentence or the answers invalidates the previous walk.
  stopPlay();
  state.sim.result = null;
  state.sim.cursor = 0;
  if (isNew) state.sim.inputs = {};

  state.parsed = parse(state.utterance);
  const t1 = performance.now();
  state.workflow = compile(state.parsed, state.resolutions);
  const t2 = performance.now();
  state.validation = validate(state.workflow, state.resolutions);
  const t3 = performance.now();

  if (logUtterance || isNew) {
    await state.ledger.append({
      event: AUDIT_EVENTS.UTTERANCE_SUBMITTED,
      subject: state.workflow.workflowId,
      workflowId: state.workflow.workflowId,
      detail: { utterance: state.utterance, clauses: state.parsed.clauses }
    });
  }
  await state.ledger.append({
    event: AUDIT_EVENTS.WORKFLOW_COMPILED,
    subject: state.workflow.workflowId,
    workflowId: state.workflow.workflowId,
    detail: {
      nodes: state.workflow.nodes.length,
      edges: state.workflow.edges.length,
      participants: state.workflow.participants.length,
      answersApplied: Object.keys(state.resolutions).length
    }
  });
  await state.ledger.append({
    event: AUDIT_EVENTS.VALIDATION_RUN,
    subject: state.workflow.workflowId,
    workflowId: state.workflow.workflowId,
    detail: {
      status: state.validation.status,
      counts: state.validation.counts,
      rulesFired: state.validation.findings.map(f => f.rule)
    }
  });
  if (state.validation.questions.length) {
    await state.ledger.append({
      event: AUDIT_EVENTS.QUESTION_RAISED,
      subject: state.workflow.workflowId,
      workflowId: state.workflow.workflowId,
      detail: { open: state.validation.questions.map(q => ({ id: q.id, rule: q.rule })) }
    });
  }
  const t4 = performance.now();

  const lines = buildTrace({
    utterance: state.utterance,
    parsed: state.parsed,
    workflow: state.workflow,
    validation: state.validation,
    resolutions: state.resolutions,
    timings: { parse: t1 - t0, compile: t2 - t1, validate: t3 - t2, ledger: t4 - t3 },
    ledgerAppended: state.ledger.length - before,
    ledgerHead: state.ledger.head
  });

  renderAll();
  streamLog(lines, isNew);
  if (announce) toast(announce, 'ok');
}

async function answer(question, value, label) {
  state.resolutions = { ...state.resolutions, [question.id]: value };
  await state.ledger.append({
    event: AUDIT_EVENTS.QUESTION_ANSWERED,
    subject: question.id,
    workflowId: state.workflow?.workflowId ?? null,
    detail: { rule: question.rule, questionId: question.id, prompt: question.prompt, answer: label, value }
  });
  await run();
}

async function withdraw(questionId) {
  const { [questionId]: removed, ...rest } = state.resolutions;
  state.resolutions = rest;
  await state.ledger.append({
    event: AUDIT_EVENTS.ANSWER_WITHDRAWN,
    subject: questionId,
    workflowId: state.workflow?.workflowId ?? null,
    detail: { questionId, previousValue: removed }
  });
  await run();
}

/* ------------------------------------------------------------------ */
/* execution log                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reveal the log progressively.
 *
 * The stagger is presentation only — every timestamp printed is the measured
 * one from `buildTrace`, never the wall-clock time at which the line appeared.
 */
function streamLog(lines, clear) {
  const token = ++state.streamToken;
  const term = $('term');
  if (clear) term.innerHTML = '';
  else if (term.childElementCount) term.appendChild(divider());

  let i = 0;
  const step = () => {
    if (token !== state.streamToken) return;
    const budget = Date.now() + 8;
    while (i < lines.length && Date.now() < budget) {
      term.appendChild(logLine(lines[i++]));
    }
    term.scrollTop = term.scrollHeight;
    if (i < lines.length) {
      setTimeout(step, 14);
    } else {
      $('liveBadge').dataset.running = 'false';
      $('liveBadge').textContent = '';
      $('liveBadge').append(el('i'), document.createTextNode('IDLE'));
    }
  };
  step();
}

function divider() {
  const row = el('div', 'term-line');
  row.dataset.level = 'head';
  row.append(el('span', 't'), el('span', 'agent'));
  const msg = el('span', 'msg', `── new run · ${new Date().toLocaleTimeString()} ──`);
  row.appendChild(msg);
  return row;
}

function logLine(line) {
  const row = el('div', 'term-line');
  row.dataset.agent = line.agent;
  row.dataset.level = line.level;

  row.appendChild(el('span', 't', `${line.at.toFixed(2)}`));
  row.appendChild(el('span', 'agent', line.agent));

  const msg = el('span', 'msg');
  if (line.verdict) {
    const v = el('span', 'verdict', line.verdict);
    v.dataset.v = line.verdict;
    msg.appendChild(v);
    msg.appendChild(document.createTextNode(' '));
  }
  for (const part of line.parts) {
    if (typeof part === 'string') { msg.appendChild(document.createTextNode(part)); continue; }
    msg.appendChild(el(part.t === 'b' ? 'b' : 'code', null, part.v));
  }
  row.appendChild(msg);
  return row;
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderStatus();
  renderMeter();
  renderQuestions();
  renderAnswered();
  renderChecks();
  renderDiagram();
  renderJson();
  renderDictionary();
  renderFindings();
  renderLedger();
  renderExports();
  renderSimulator();
  renderInspector();
  renderBadges();
}

const STATUS_TEXT = {
  technical: {
    blocked: n => `${n} blocking question${n === 1 ? '' : 's'}`,
    'needs-review': n => `${n} advisory finding${n === 1 ? '' : 's'}`,
    ready: () => 'All checks passed'
  },
  plain: {
    blocked: n => `${n} question${n === 1 ? '' : 's'} to answer`,
    'needs-review': n => `${n} thing${n === 1 ? '' : 's'} worth a look`,
    ready: () => 'Ready to hand over'
  }
};

function renderStatus() {
  const v = state.validation;
  const pill = $('statusPill');
  pill.dataset.status = v.status;
  const n = v.status === 'blocked' ? v.counts.blocker : v.counts.warning;
  $('statusText').textContent = STATUS_TEXT[state.mode][v.status](n);

  $('wfChip').hidden = false;
  $('wfId').textContent = state.workflow.workflowId;
}

function renderMeter() {
  const text = $('utterance').value;
  const meter = $('meter');
  meter.textContent = '';
  const chars = el('b', null, String(text.length));
  const clauses = el('b', null, String(state.parsed?.clauses.length ?? 0));
  meter.append(chars, document.createTextNode(' chars · '), clauses, document.createTextNode(' clauses'));
  meter.dataset.over = String(text.length > 320);
}

function renderBadges() {
  const v = state.validation;
  const fb = $('findingsBadge');
  fb.textContent = String(v.findings.length);
  fb.dataset.tone = v.counts.blocker ? 'rose' : v.counts.warning ? 'amber' : 'emerald';
  const ab = $('auditBadge');
  ab.textContent = String(state.ledger.length);
  ab.dataset.tone = 'emerald';
  $('ledgerHead').textContent = `head ${state.ledger.head.slice(0, 12)}…`;
  const required = state.validation.questions.filter(q => q.severity !== 'info').length;
  const optional = state.validation.questions.length - required;
  $('openCount').textContent = optional
    ? `${required} open · ${optional} optional`
    : `${required} open`;
  $('answeredCount').textContent = String(Object.keys(state.resolutions).length);
}

function renderQuestions() {
  const host = $('questions');
  host.innerHTML = '';
  const all = state.validation.questions;
  // Info-level questions are offers, not obstacles: a default has already been
  // applied and the workflow is complete without touching them. Mixing them in
  // with blockers would make a finished process look unfinished.
  const qs = all.filter(q => q.severity !== 'info');
  const optional = all.filter(q => q.severity === 'info');

  if (!qs.length) {
    const box = el('div', 'empty-state');
    box.appendChild(el('span', 'big', '✓'));
    const strong = el('strong', null, 'Nothing left to ask.');
    box.appendChild(strong);
    box.appendChild(document.createTextNode(
      state.validation.counts.info
        ? ' Every blocking and advisory check is answered. The Findings tab lists what the engine inferred on its own.'
        : ' Every check passed on the sentence as written.'
    ));
    host.appendChild(box);
    if (optional.length) host.appendChild(optionalSection(optional));
    return;
  }

  qs.forEach((q, qi) => {
    const card = el('div', `question sev-${q.severity}`);
    card.style.animationDelay = `${Math.min(qi, 6) * 28}ms`;
    card.appendChild(el('div', 'qbar'));

    const body = el('div', 'qbody');
    const head = el('div', 'qhead');
    const tag = el('span', 'rule-tag tech-only', q.rule);
    head.appendChild(tag);
    head.appendChild(el('span', 'qtitle', plain() ? q.plainTitle : q.title));
    body.appendChild(head);

    body.appendChild(el('p', 'qprompt', plain() ? (q.plainPrompt || q.prompt) : q.prompt));
    if (plain() && q.plainDetail) body.appendChild(el('p', 'qhelp', q.plainDetail));
    else if (q.help) body.appendChild(el('p', 'qhelp', q.help));

    if (q.kind === 'predicate') {
      body.appendChild(buildPredicateForm(q));
    } else {
      const opts = el('div', 'options');
      (q.options || []).forEach((o, i) => {
        const b = el('button', 'option');
        b.appendChild(el('span', 'idx', String(i + 1)));
        const text = el('span');
        text.appendChild(document.createTextNode(o.label));
        if (o.hint) text.appendChild(el('span', 'hint', o.hint));
        b.appendChild(text);
        b.addEventListener('click', () => answer(q, o.value, o.label));
        opts.appendChild(b);
      });
      body.appendChild(opts);
    }
    card.appendChild(body);
    host.appendChild(card);
  });

  if (optional.length) host.appendChild(optionalSection(optional));
}

/** Collapsed list of "we already chose something sensible" questions. */
function optionalSection(questions) {
  const details = document.createElement('details');
  details.className = 'optional-block';
  const summary = document.createElement('summary');
  summary.appendChild(el('span', 'opt-count', String(questions.length)));
  summary.appendChild(document.createTextNode(
    plain()
      ? ` setting${questions.length === 1 ? '' : 's'} we filled in for you — open to change`
      : ` defaulted polic${questions.length === 1 ? 'y' : 'ies'} — override if needed`));
  details.appendChild(summary);

  const body = el('div', 'opt-body');
  for (const q of questions) {
    const card = el('div', 'question sev-info');
    card.appendChild(el('div', 'qbar'));
    const qb = el('div', 'qbody');
    const head = el('div', 'qhead');
    head.appendChild(el('span', 'rule-tag tech-only', q.rule));
    head.appendChild(el('span', 'qtitle', plain() ? q.plainTitle : q.title));
    qb.appendChild(head);
    qb.appendChild(el('p', 'qprompt', plain() ? (q.plainPrompt || q.prompt) : q.prompt));
    if (plain() && q.plainDetail) qb.appendChild(el('p', 'qhelp', q.plainDetail));

    const opts = el('div', 'options');
    (q.options || []).forEach(o => {
      const b = el('button', 'option');
      const text = el('span');
      text.appendChild(document.createTextNode(o.label));
      if (o.hint) text.appendChild(el('span', 'hint', o.hint));
      b.appendChild(text);
      b.addEventListener('click', () => answer(q, o.value, o.label));
      opts.appendChild(b);
    });
    qb.appendChild(opts);
    card.appendChild(qb);
    body.appendChild(card);
  }
  details.appendChild(body);
  return details;
}

/**
 * Visual condition builder — the no-code replacement for typing
 * `invoice.amount >= 10000`.
 *
 * Three layers, in the order a non-technical user meets them:
 *   1. one-click suggestions inferred from the words they actually wrote;
 *   2. three dropdowns using business names ("Amount · is more than · 5,000");
 *   3. an Advanced panel, collapsed, exposing the raw field path for anyone
 *      who wants it.
 *
 * The read-back line under the controls restates the choice as a sentence, so
 * the person confirms English rather than confirming syntax.
 */
function buildPredicateForm(q) {
  const wrap = el('div', 'builder');

  /* --- layer 1: context-aware quick picks --------------------------- */
  if (q.suggestions?.length) {
    const box = el('div', 'builder-suggest');
    for (const sg of q.suggestions) {
      const b = el('button', 'suggest-btn');
      b.appendChild(el('span', 'lead', 'LIKELY'));
      b.appendChild(el('span', null, sg.label));
      b.addEventListener('click', () => answer(q, sg.value, sg.label));
      box.appendChild(b);
    }
    wrap.appendChild(box);
    wrap.appendChild(el('div', 'builder-or', 'or build it yourself'));
  }

  /* --- layer 2: the three dropdowns --------------------------------- */
  const groups = fieldCatalogue(mentionedObjectIds());
  const flat = groups.flatMap(g => g.fields);

  const fieldRow = el('div', 'builder-row');
  fieldRow.appendChild(el('label', null, 'What should we look at?'));
  const fieldSel = document.createElement('select');
  fieldSel.setAttribute('aria-label', 'Field to check');
  for (const g of groups) {
    const og = document.createElement('optgroup');
    og.label = g.relevant ? `${g.label} — mentioned in your sentence` : g.label;
    for (const f of g.fields) {
      const o = document.createElement('option');
      o.value = f.path;
      o.textContent = `${g.label} · ${f.label}`;
      og.appendChild(o);
    }
    fieldSel.appendChild(og);
  }
  fieldRow.appendChild(fieldSel);
  wrap.appendChild(fieldRow);

  const opRow = el('div', 'builder-row');
  opRow.appendChild(el('label', null, 'How should we compare it?'));
  const opSel = document.createElement('select');
  opSel.setAttribute('aria-label', 'Comparison');
  opRow.appendChild(opSel);
  wrap.appendChild(opRow);

  const valRow = el('div', 'builder-row');
  valRow.appendChild(el('label', null, 'To what?'));
  const valWrap = el('div', 'builder-value');
  valRow.appendChild(valWrap);
  wrap.appendChild(valRow);

  const readback = el('p', 'builder-readback');
  wrap.appendChild(readback);

  /* --- layer 3: advanced ------------------------------------------- */
  const adv = document.createElement('details');
  adv.className = 'builder-advanced';
  const sum = document.createElement('summary');
  sum.textContent = 'Advanced — use a different field name';
  adv.appendChild(sum);
  const advBody = el('div', 'adv-body');
  const advInput = el('input');
  advInput.placeholder = 'e.g. invoice.customFields.riskScore';
  advInput.setAttribute('aria-label', 'Custom field path');
  advBody.appendChild(advInput);
  advBody.appendChild(el('p', 'adv-note',
    'Leave this blank unless your team uses a field that is not in the list above. Anything typed here is used exactly as written.'));
  adv.appendChild(advBody);
  wrap.appendChild(adv);

  /* --- behaviour ---------------------------------------------------- */
  let valueInput = null;
  let currencySel = null;

  const currentField = () => {
    const custom = advInput.value.trim();
    if (custom) return { path: custom, label: describeField(custom).label, kind: 'text', object: 'custom' };
    return flat.find(f => f.path === fieldSel.value) || flat[0];
  };

  function rebuildOperators() {
    const f = currentField();
    const ops = FRIENDLY_OPERATORS[f.kind] || FRIENDLY_OPERATORS.text;
    opSel.textContent = '';
    for (const o of ops) {
      const opt = document.createElement('option');
      opt.value = o.op;
      opt.textContent = o.label;
      opSel.appendChild(opt);
    }
  }

  function rebuildValue() {
    const f = currentField();
    valWrap.textContent = '';
    valWrap.className = 'builder-value';
    currencySel = null;

    if (f.kind === 'choice') {
      valueInput = document.createElement('select');
      valueInput.setAttribute('aria-label', 'Value');
      for (const v of (f.options || STATUS_VALUES)) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        valueInput.appendChild(o);
      }
      valWrap.classList.add('single');
      valWrap.appendChild(valueInput);
    } else if (f.kind === 'currency') {
      valueInput = el('input');
      valueInput.type = 'text';
      valueInput.inputMode = 'decimal';
      valueInput.placeholder = '10,000';
      valueInput.setAttribute('aria-label', 'Amount');
      currencySel = document.createElement('select');
      currencySel.setAttribute('aria-label', 'Currency');
      for (const c of ['USD', 'EUR', 'GBP', 'JPY', 'INR']) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c;
        currencySel.appendChild(o);
      }
      valWrap.append(valueInput, currencySel);
    } else if (f.kind === 'duration') {
      valueInput = el('input');
      valueInput.type = 'number';
      valueInput.min = '0';
      valueInput.placeholder = '30';
      valueInput.setAttribute('aria-label', 'Number of days');
      const unit = el('div', 'unit', 'days');
      valWrap.append(valueInput, unit);
    } else {
      valueInput = el('input');
      valueInput.placeholder = f.kind === 'number' ? '5' : 'type the value';
      valueInput.setAttribute('aria-label', 'Value');
      valWrap.classList.add('single');
      valWrap.appendChild(valueInput);
    }
    [valueInput, currencySel].forEach(n => n && n.addEventListener('input', refresh));
    [valueInput, currencySel].forEach(n => n && n.addEventListener('change', refresh));
    valueInput.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  }

  function reading() {
    const f = currentField();
    const opLabel = describeOperator(opSel.value, f.kind);
    const raw = (valueInput?.value ?? '').trim();
    const shown = f.kind === 'currency' && raw
      ? `${raw}${currencySel ? ' ' + currencySel.value : ''}`
      : f.kind === 'duration' && raw ? `${raw} days`
      : raw;
    return { f, opLabel, raw, shown };
  }

  function refresh() {
    const { f, opLabel, shown } = reading();
    readback.textContent = '';
    readback.appendChild(el('span', 'lead', 'This will check: '));
    const b = el('b', null, `${f.object === 'custom' ? f.label : `${f.object} ${f.label.toLowerCase()}`} ${opLabel} ${shown || '…'}`);
    readback.appendChild(b);
  }

  function apply() {
    const { f, raw } = reading();
    if (!raw) { toast('Fill in a value to compare against.', 'warn'); return; }
    const numeric = Number(raw.replace(/,/g, ''));
    const isNum = Number.isFinite(numeric) && raw !== '';
    const label = readback.textContent.replace('This will check: ', '');

    answer(q, {
      subject: f.path,
      operator: opSel.value,
      value: isNum ? numeric : raw,
      valueType: f.kind === 'currency' ? 'money' : isNum ? 'number' : 'string',
      currency: f.kind === 'currency' && currencySel ? currencySel.value : null
    }, label);
  }

  fieldSel.addEventListener('change', () => { rebuildOperators(); rebuildValue(); refresh(); });
  advInput.addEventListener('input', () => { rebuildOperators(); rebuildValue(); refresh(); });
  opSel.addEventListener('change', refresh);

  rebuildOperators();
  rebuildValue();
  refresh();

  const submit = el('button', 'primary', 'Use this check');
  submit.style.cssText = 'width:100%;margin-top:10px;justify-content:center';
  submit.addEventListener('click', apply);
  wrap.appendChild(submit);
  return wrap;
}

/** Which business records the current sentence actually talks about. */
function mentionedObjectIds() {
  const names = new Set(state.workflow?.nodes.map(n => n.object).filter(Boolean) || []);
  return [...names].map(n => `obj_${n.replace(/\s+/g, '')}`)
    .concat([...names].map(n => {
      // objects whose id does not follow the name (e.g. "purchase order")
      const map = { 'purchase order': 'obj_po', 'expense report': 'obj_expense', 'customer record': 'obj_customer' };
      return map[n] || `obj_${n}`;
    }));
}

function renderAnswered() {
  const keys = Object.keys(state.resolutions);
  $('answeredWrap').hidden = keys.length === 0;
  const host = $('answered');
  host.innerHTML = '';

  const log = state.ledger.entries.filter(e => e.event === AUDIT_EVENTS.QUESTION_ANSWERED);
  for (const key of keys) {
    const last = [...log].reverse().find(e => e.detail.questionId === key);
    const row = el('div', 'answered');
    const body = el('div', 'a-body');
    body.appendChild(el('div', 'a-q', last?.detail.prompt || key));
    body.appendChild(el('div', 'a-a', `→ ${last?.detail.answer ?? JSON.stringify(state.resolutions[key])}`));
    row.appendChild(body);
    const undo = el('button', 'ghost tiny', 'Undo');
    undo.addEventListener('click', () => withdraw(key));
    row.appendChild(undo);
    host.appendChild(row);
  }
}

function renderChecks() {
  const host = $('checks');
  host.innerHTML = '';
  for (const c of state.validation.checks) {
    const row = el('div', 'check');
    row.dataset.passed = String(c.passed);
    row.appendChild(el('span', 'tick', c.passed ? '✓' : '✗'));
    row.appendChild(el('span', 'label', plain() ? (c.plainLabel || c.label) : c.label));
    row.appendChild(el('span', 'n', c.findingCount ? `${c.findingCount} finding${c.findingCount === 1 ? '' : 's'}` : 'clean'));
    host.appendChild(row);
  }
}

function renderDiagram() {
  const host = $('diagram');
  const sim = state.sim.result;
  const upto = sim ? sim.path.slice(0, state.sim.cursor + 1) : null;
  const stepOrder = sim ? new Map(sim.path.map((id, i) => [id, i + 1])) : null;

  const svg = renderSwimlane(host, state.workflow, {
    highlightId: state.selectedNode,
    pathNodes: sim ? sim.path : null,
    pathEdges: sim ? sim.edgePath : null,
    stepOrder,
    currentStepId: upto ? upto[upto.length - 1] : null,
    nameFor: displayName,
    onNodeClick: node => {
      state.selectedNode = state.selectedNode === node.id ? null : node.id;
      renderDiagram();
      renderInspector();
      if (state.selectedNode) describeNode(node);
    }
  });
  applyZoom(svg);
}

/**
 * Scale by rewriting width/height against a fixed viewBox rather than with a
 * CSS transform, so the scroll container reflows to the scaled size instead of
 * keeping the unscaled footprint.
 */
function applyZoom(svg) {
  const natural = svg.viewBox.baseVal;
  const available = $('diagram').clientWidth - 38;
  // Never shrink past the point where step names stop being readable — a wide
  // process on a narrow pane should scroll sideways, not become a thumbnail.
  const fit = Math.max(0.5, Math.min(1, available / natural.width));
  const scale = state.zoom ?? fit;
  svg.setAttribute('width', Math.round(natural.width * scale));
  svg.setAttribute('height', Math.round(natural.height * scale));
  $('zoomReset').textContent = state.zoom == null ? 'Fit' : `${Math.round(scale * 100)}%`;
}

function currentScale() {
  const svg = $('diagram').querySelector('svg');
  if (!svg) return 1;
  return Number(svg.getAttribute('width')) / svg.viewBox.baseVal.width;
}

function describeNode(node) {
  const row = toSchemaDictionary(state.workflow).find(r => r.nodeId === node.id);
  const binding = typeof row?.binding === 'string' ? row.binding : '—';
  const hint = $('diagramHint');
  hint.textContent = '';
  hint.append(
    document.createTextNode(`${displayName(node)} · ${node.performer?.name || 'unassigned'} · `),
    el('code', null, binding)
  );
}

/* ---- code viewers ---- */

const TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;

/** Tokenise JSON into spans without ever touching innerHTML. */
function renderJsonInto(host, gutterHost, json) {
  host.innerHTML = '';
  gutterHost.innerHTML = '';
  const lines = json.split('\n');
  gutterHost.textContent = lines.map((_, i) => i + 1).join('\n');

  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let last = 0;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(line)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(line.slice(last, m.index)));
      if (m[1] !== undefined) {
        frag.appendChild(el('span', m[2] ? 'tk-key' : 'tk-str', m[1]));
        if (m[2]) frag.appendChild(document.createTextNode(m[2]));
      } else if (m[3] !== undefined) {
        frag.appendChild(el('span', 'tk-bool', m[3]));
      } else if (m[4] !== undefined) {
        frag.appendChild(el('span', 'tk-num', m[4]));
      } else if (m[5] !== undefined) {
        frag.appendChild(el('span', 'tk-punc', m[5]));
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) frag.appendChild(document.createTextNode(line.slice(last)));
    if (i < lines.length - 1) frag.appendChild(document.createTextNode('\n'));
  }
  host.appendChild(frag);
}

function renderJson() {
  renderJsonInto($('jsonBody'), $('jsonGutter'), JSON.stringify(state.workflow, null, 2));
}

function renderExports() {
  const picker = $('formatPicker');
  if (!picker.childElementCount) {
    for (const [key, fmt] of Object.entries(FORMATS)) {
      const b = el('button', 'fmt');
      b.setAttribute('role', 'tab');
      b.appendChild(document.createTextNode(fmt.label));
      b.appendChild(el('span', 'ext', '.' + fmt.ext.split('.').pop()));
      b.addEventListener('click', () => { state.exportFormat = key; renderExports(); });
      picker.appendChild(b);
    }
  }
  [...picker.children].forEach((b, i) => {
    b.setAttribute('aria-selected', String(Object.keys(FORMATS)[i] === state.exportFormat));
  });

  const fmt = FORMATS[state.exportFormat];
  const text = fmt.build(state.workflow, state.validation);

  const note = $('exportNote');
  note.textContent = '';
  // The notes contain <strong>/<code> only, authored here — never user input.
  note.insertAdjacentHTML('afterbegin', fmt.note);

  $('exportHint').textContent = fmt.hint;

  if (fmt.lang === 'json') {
    renderJsonInto($('exportBody'), $('exportGutter'), text);
  } else {
    $('exportBody').textContent = text;
    $('exportGutter').textContent = text.split('\n').map((_, i) => i + 1).join('\n');
  }
}

function currentExport() {
  const fmt = FORMATS[state.exportFormat];
  return {
    fmt,
    text: fmt.build(state.workflow, state.validation),
    filename: `${state.workflow.workflowId}.${fmt.ext}`
  };
}

/* ---- dictionary ---- */

function renderDictionary() {
  const rows = toSchemaDictionary(state.workflow);
  const table = $('dictionary');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['Phrase from your sentence', 'Recognised as', 'Performer', 'Binding', 'Backend contract']) {
    hr.appendChild(el('th', null, h));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    const node = state.workflow.nodes.find(n => n.id === r.nodeId);

    const phrase = el('td', 'phrase');
    if (r.phrase) {
      phrase.textContent = `"${r.phrase}"`;
    } else {
      phrase.className = `phrase origin-${r.origin}`;
      phrase.textContent = r.origin === 'clarification'
        ? 'added by your answer to a clarifying question'
        : 'added by the compiler to keep the graph well-formed';
    }
    tr.appendChild(phrase);

    const type = el('td');
    type.appendChild(el('span', 'tag', r.recognisedAs));
    tr.appendChild(type);

    const perf = el('td');
    const tag = el('span', 'tag', r.performer);
    tag.dataset.kind = node?.performer?.kind === 'role' ? 'human' : node?.performer?.kind === 'system' ? 'system' : 'engine';
    perf.appendChild(tag);
    tr.appendChild(perf);

    tr.appendChild(el('td', 'mono', typeof r.binding === 'string' ? r.binding : '—'));

    const contract = el('td', 'mono', r.contract ? `${r.contract.method} ${r.contract.endpoint}` : '—');
    if (r.contract?.body) contract.title = JSON.stringify(r.contract.body, null, 2);
    tr.appendChild(contract);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

function dictionaryCsv() {
  const rows = toSchemaDictionary(state.workflow);
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['node_id', 'phrase', 'origin', 'recognised_as', 'performer', 'binding', 'method', 'endpoint'];
  const body = rows.map(r => [
    r.nodeId, r.phrase ?? '', r.origin, r.recognisedAs, r.performer,
    typeof r.binding === 'string' ? r.binding : '',
    r.contract?.method ?? '', r.contract?.endpoint ?? ''
  ].map(q).join(','));
  return [head.join(','), ...body].join('\n');
}

/* ---- findings ---- */

function renderFindings() {
  const host = $('findings');
  host.innerHTML = '';
  const v = state.validation;
  $('findingsHint').textContent = plain()
    ? `${v.counts.blocker} must be answered · ${v.counts.warning} worth a look · ${v.counts.info} things we assumed`
    : `${v.counts.blocker} blocking · ${v.counts.warning} advisory · ${v.counts.info} informational · ${RULES.length} rules in the set`;

  if (!v.findings.length) {
    const box = el('div', 'empty-state');
    box.appendChild(el('span', 'big', '✓'));
    box.appendChild(document.createTextNode('Every rule in the set ran and none fired.'));
    host.appendChild(box);
    return;
  }

  for (const f of v.findings) {
    const card = el('div', `finding sev-${f.severity}`);
    const head = el('div', 'f-head');
    head.appendChild(el('span', 'rule-tag tech-only', f.rule));
    head.appendChild(el('span', 'f-title', copyOf(f, 'title')));
    if (f.nodeId) {
      const link = el('button', 'f-node', plain()
        ? (state.workflow.nodes.find(n => n.id === f.nodeId)?.name || f.nodeId).slice(0, 28)
        : f.nodeId);
      link.addEventListener('click', () => {
        state.selectedNode = f.nodeId;
        selectTab('diagram');
        renderDiagram();
        renderInspector();
        const node = state.workflow.nodes.find(n => n.id === f.nodeId);
        if (node) describeNode(node);
      });
      head.appendChild(link);
    }
    card.appendChild(head);
    card.appendChild(el('div', 'f-detail', copyOf(f, 'detail')));
    host.appendChild(card);
  }
}

/* ---- ledger ---- */

const LEDGER_KIND = {
  [AUDIT_EVENTS.UTTERANCE_SUBMITTED]: 'workflow',
  [AUDIT_EVENTS.WORKFLOW_COMPILED]: 'workflow',
  [AUDIT_EVENTS.VALIDATION_RUN]: 'validation',
  [AUDIT_EVENTS.QUESTION_RAISED]: 'validation',
  [AUDIT_EVENTS.QUESTION_ANSWERED]: 'clarification',
  [AUDIT_EVENTS.ANSWER_WITHDRAWN]: 'clarification',
  [AUDIT_EVENTS.SIMULATION_RUN]: 'validation',
  [AUDIT_EVENTS.LEDGER_VERIFIED]: 'ledger',
  [AUDIT_EVENTS.WORKFLOW_EXPORTED]: 'ledger'
};

function renderLedger() {
  const host = $('ledger');
  host.innerHTML = '';
  for (const e of state.ledger.entries.slice().reverse()) {
    const row = el('div', 'ledger-entry');
    row.dataset.kind = LEDGER_KIND[e.event] || 'workflow';
    row.appendChild(el('div', 'seq', String(e.seq).padStart(3, '0')));

    const body = el('div');
    const ev = el('div', 'ev');
    ev.appendChild(el('i'));
    ev.appendChild(document.createTextNode(e.event));
    body.appendChild(ev);
    body.appendChild(el('div', 'meta', `${e.timestamp} · ${e.actor}${e.subject ? ` · ${e.subject}` : ''}`));
    body.appendChild(el('div', 'detail', truncate(JSON.stringify(e.detail), 190)));

    const hash = el('div', 'hash');
    hash.appendChild(document.createTextNode(`prev ${e.prevHash.slice(0, 18)}… → `));
    hash.appendChild(el('b', null, `${e.hash.slice(0, 18)}…`));
    body.appendChild(hash);

    row.appendChild(body);
    host.appendChild(row);
  }
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }



/* ------------------------------------------------------------------ */
/* blueprint inspector                                                 */
/* ------------------------------------------------------------------ */

/**
 * The panel under the diagram.
 *
 * The toolbar has always said "click any step to inspect what it compiled to",
 * but the answer used to appear as one line of hint text while a large empty
 * band sat under the drawing. This puts the answer where the space already was.
 *
 * With nothing selected it shows what the process amounts to overall, so the
 * area is never blank.
 */
function renderInspector() {
  const host = $('inspector');
  if (!host || !state.workflow) return;
  host.textContent = '';

  const node = state.workflow.nodes.find(n => n.id === state.selectedNode);
  if (!node) {
    $('diagramHint').textContent = plain()
      ? 'Click any step to see what it does and where it came from.'
      : 'Click any step to inspect what it compiled to.';
  }
  host.appendChild(node ? inspectNode(node) : inspectWorkflow());
}

function inspectWorkflow() {
  const wf = state.workflow;
  const frag = document.createDocumentFragment();

  const head = el('div', 'insp-head');
  head.appendChild(el('h3', null, wf.name));
  head.appendChild(el('span', 'who', `${new Set(wf.nodes.map(n => n.lane)).size} lanes`));
  head.appendChild(el('span', 'id tech-only', wf.workflowId));
  frag.appendChild(head);

  const humans = wf.nodes.filter(n => n.performer?.kind === 'role').length;
  const systems = wf.nodes.filter(n => n.operation).length;
  const decisions = wf.nodes.filter(n => n.type === 'gateway.exclusive').length;
  const fromAnswers = wf.nodes.filter(n => n.trace?.from === 'clarification').length;

  frag.appendChild(el('p', 'insp-lede',
    `${wf.nodes.length} steps in total: ${decisions} decision${decisions === 1 ? '' : 's'}, ` +
    `${humans} needing a person, ${systems} touching a system. ` +
    (fromAnswers
      ? `${fromAnswers} of them exist because you answered a clarifying question, not because you wrote them.`
      : 'Every step came from your sentence.')));

  const stats = el('div', 'insp-summary');
  const add = (n, label, tone) => {
    const s = el('div', 'stat');
    if (tone) s.dataset.tone = tone;
    s.appendChild(el('b', null, String(n)));
    s.appendChild(el('span', null, label));
    stats.appendChild(s);
  };
  add(wf.nodes.length, 'steps');
  add(decisions, 'decisions');
  add(humans, 'people steps');
  add(systems, 'system calls');
  if (fromAnswers) add(fromAnswers, 'from answers', 'amber');
  frag.appendChild(stats);

  const grid = el('dl', 'insp-grid');
  grid.style.marginTop = '12px';

  if (wf.connectors.length) {
    grid.appendChild(card('Systems used', wf.connectors.map(c => {
      const d = el('dd');
      d.appendChild(document.createTextNode(c.name));
      const sub = el('span', 'sub', plain()
        ? 'a request contract is defined — no live integration is built'
        : `${c.operations.join(', ')} · ${c.status}`);
      d.appendChild(sub);
      return d;
    })));
  }

  const people = wf.participants.filter(p => p.kind === 'role');
  if (people.length) {
    grid.appendChild(card('People involved', [ddText(people.map(p => p.name).join(', '))]));
  }

  if (wf.governance.regulatoryScope.length) {
    const d = el('dd');
    d.appendChild(document.createTextNode(wf.governance.regulatoryScope.join(', ')));
    d.appendChild(el('span', 'sub', 'detected from wording — a prompt for review, not a legal determination'));
    grid.appendChild(card('Regulatory scope', [d]));
  }

  grid.appendChild(card(plain() ? 'Click a step' : 'Inspect', [
    ddText(plain()
      ? 'Select any box in the diagram above to see what it does, who does it, and exactly which words produced it.'
      : 'Select a node to see its binding, backend contract and source clause.')
  ]));

  frag.appendChild(grid);
  return frag;
}

function inspectNode(node) {
  const wf = state.workflow;
  const row = toSchemaDictionary(wf).find(r => r.nodeId === node.id);
  const frag = document.createDocumentFragment();

  const head = el('div', 'insp-head');
  head.appendChild(el('h3', null, displayName(node)));
  head.appendChild(el('span', 'who', node.performer?.name || 'automation engine'));
  head.appendChild(el('span', 'id tech-only', node.id));
  frag.appendChild(head);

  frag.appendChild(el('p', 'insp-lede', narrateNode(node)));

  const grid = el('dl', 'insp-grid');

  /* where it came from — the thing a reviewer most needs to know */
  const origin = row?.origin || 'structure';
  const originCard = el('div', 'insp-card');
  originCard.appendChild(el('dt', null, 'Where this came from'));
  const badge = el('span', 'insp-origin', {
    utterance: 'YOUR SENTENCE', clarification: 'YOUR ANSWER', structure: 'ADDED BY THE ENGINE'
  }[origin]);
  badge.dataset.origin = origin;
  originCard.appendChild(badge);
  if (row?.phrase) {
    originCard.appendChild(ddQuote(`“${row.phrase}”`));
  } else {
    originCard.appendChild(ddNone(origin === 'clarification'
      ? 'This step exists because you answered a clarifying question — it was not in your sentence.'
      : 'A merge point or end event added to keep the process well-formed.'));
  }
  if (node.trace?.hoisted) {
    originCard.appendChild(ddText('Moved ahead of the clause written before it, because of the word “first”.'));
  }
  grid.appendChild(originCard);

  /* what it does at runtime */
  if (node.condition && !node.condition.unresolved) {
    grid.appendChild(card('The check', [
      ddText(displayName(node).replace(/\?$/, '')),
      ddMono(`${node.condition.subject} ${node.condition.operator} ${node.condition.value}${node.condition.currency ? ' ' + node.condition.currency : ''}`, true)
    ]));
  }

  if (node.operation) {
    grid.appendChild(card('System call', [
      ddText(`${node.operation.connector} — ${plain() ? 'a record is written or read here' : node.operation.operation}`),
      ddMono(`${row?.contract?.method || 'POST'} ${row?.contract?.endpoint || ''}`, true)
    ]));
  } else if (row?.contract) {
    grid.appendChild(card(node.type === 'task.notify' ? 'Notification' : 'Task', [
      ddText(node.recipients?.length ? `Goes to ${node.recipients.map(r => r.name).join(', ')}` : 'Assigned as a human task'),
      ddMono(`${row.contract.method} ${row.contract.endpoint}`, true)
    ]));
  }

  /* the operational properties people forget */
  const ops = [];
  if (node.sla) {
    ops.push(ddText(node.sla.durationSeconds
      ? `Must be done within ${humanDuration(node.sla.durationSeconds)}${node.sla.businessDays ? ' (business days)' : ''}, then it ${node.sla.onBreach === 'alert' ? 'alerts someone' : 'escalates'}.`
      : 'No deadline — nothing will chase it.'));
  }
  if (node.outcomeGatewayId) {
    ops.push(ddText('Both outcomes are modelled — a rejection follows its own path.'));
  }
  if (ops.length) grid.appendChild(card('Safeguards', ops));

  if (node.retry) grid.appendChild(resilienceCard(node));

  frag.appendChild(grid);

  const clear = el('button', 'ghost tiny', '← Back to the whole process');
  clear.style.marginTop = '12px';
  clear.addEventListener('click', () => {
    state.selectedNode = null;
    renderDiagram();
    renderInspector();
    $('diagramHint').textContent = plain()
      ? 'Click any step to see what it does and where it came from.'
      : 'Click any step to inspect what it compiled to.';
  });
  frag.appendChild(clear);
  return frag;
}


/**
 * What happens when the system on the other end misbehaves.
 *
 * Each row is tagged `default` or `chosen`, because "the engine picked this"
 * and "a human decided this" are very different things to a reviewer, and the
 * whole point of applying defaults was to stop them being invisible.
 */
function resilienceCard(node) {
  const c = el('div', 'insp-card resilience');
  c.appendChild(el('dt', null, plain() ? 'If something goes wrong' : 'Resilience policy'));
  const rows = el('div', 'res-rows');

  const row = (key, build) => {
    const r = el('div', 'res-row');
    r.appendChild(el('span', 'k', key));
    const v = el('span', 'v');
    build(v);
    r.appendChild(v);
    rows.appendChild(r);
  };

  row(plain() ? 'Retries' : 'Retry', v => {
    v.appendChild(document.createTextNode(describeRetry(node.retry)));
    v.appendChild(srcTag(node.retry.source));
    if (node.retry.note) v.appendChild(el('span', 'sub', node.retry.note));
  });

  if (node.circuitBreaker) {
    row(plain() ? 'If it keeps failing' : 'Circuit breaker', v => {
      v.appendChild(document.createTextNode(describeBreaker(node.circuitBreaker)));
      v.appendChild(srcTag(node.circuitBreaker.source));
    });
  }

  if (node.timeoutSeconds) {
    row(plain() ? 'Give up after' : 'Timeout', v => {
      v.appendChild(document.createTextNode(`${node.timeoutSeconds} seconds per attempt`));
    });
  }

  if (node.idempotency) {
    row(plain() ? 'Duplicate risk' : 'Idempotency', v => {
      if (node.idempotency.operationIsIdempotent) {
        v.appendChild(document.createTextNode(`Safe to repeat — ${node.idempotency.reason}.`));
      } else if (node.idempotency.targetSupportsDeduplication === true) {
        v.appendChild(document.createTextNode(`Not repeatable on its own, but ${node.operation.connector} was confirmed to ignore a repeat carrying the same reference.`));
        v.appendChild(srcTag('clarified'));
      } else if (node.idempotency.targetSupportsDeduplication === false) {
        const w = el('span', 'warn', `${node.operation.connector} cannot spot a repeat, so retries are switched off for this step.`);
        v.appendChild(w);
        v.appendChild(srcTag('clarified'));
      } else {
        const w = el('span', 'warn', `Unconfirmed: ${node.idempotency.reason}. A unique reference is sent with every attempt, but nobody has verified ${node.operation.connector} checks it.`);
        v.appendChild(w);
      }
    });
  }

  if (node.compensation && !node.compensation.reversible) {
    row(plain() ? 'Can it be undone?' : 'Compensation', v => {
      v.appendChild(el('span', 'warn', 'No — this action cannot be reversed once it has happened.'));
    });
  } else if (node.compensation?.configured) {
    row(plain() ? 'If a later step fails' : 'Compensation', v => {
      v.appendChild(document.createTextNode({
        reverse: `Undo this write (${node.compensation.action}).`,
        'manual-reconcile': 'Leave it and alert someone to reconcile.',
        accept: 'Accept the partial state — these systems reconcile separately.'
      }[node.compensation.strategy] || node.compensation.strategy));
      v.appendChild(srcTag('clarified'));
    });
  }

  c.appendChild(rows);
  return c;
}

function srcTag(source) {
  const t = el('span', 'src', source === 'clarified' ? (plain() ? 'you chose this' : 'clarified') : (plain() ? 'our default' : 'default'));
  t.dataset.src = source;
  return t;
}

/* small builders keeping the inspector free of innerHTML */
function card(title, dds) {
  const c = el('div', 'insp-card');
  c.appendChild(el('dt', null, title));
  dds.forEach(d => c.appendChild(d));
  return c;
}
function ddText(text) { return el('dd', null, text); }
function ddQuote(text) { return el('dd', 'quote', text); }
function ddNone(text) { return el('dd', 'none', text); }
function ddMono(text, techOnly) { return el('dd', `mono${techOnly ? ' tech-only' : ''}`, text); }

/* ------------------------------------------------------------------ */
/* simulator                                                           */
/* ------------------------------------------------------------------ */

/**
 * The Test Run tab.
 *
 * Static validation proves the graph is sound. This answers the different
 * question a business owner actually asks — *"what happens to a £6,000 invoice
 * if the manager rejects it?"* — by walking the arrows with their numbers and
 * lighting up the path that gets taken.
 */
function renderSimulator() {
  if (!state.workflow) return;
  const { fields, decisions } = simulationInputs(state.workflow);
  const host = $('simInputs');
  host.textContent = '';

  if (!fields.length && !decisions.length) {
    host.appendChild(emptyBox('🎚', 'This process makes no decisions, so there is nothing to vary. Run the test to walk through it end to end.'));
  }

  host.appendChild(sectionLabel('Example values'));

  for (const f of fields) {
    const box = el('div', 'sim-field');
    const id = `sim-${f.key.replace(/\W/g, '-')}`;

    const label = el('label', null, `${f.objectLabel.replace(/\b[a-z]/, c => c.toUpperCase())} ${f.label.toLowerCase()}`);
    label.setAttribute('for', id);
    box.appendChild(label);

    const why = el('span', 'why');
    why.appendChild(document.createTextNode(`The process checks whether the ${f.testedAs}. `));
    const code = el('code', 'tech-only', f.key);
    why.appendChild(code);
    box.appendChild(why);

    if (state.sim.inputs[f.key] === undefined) state.sim.inputs[f.key] = f.suggested;

    if (f.kind === 'choice') {
      const row = el('div', 'choice-row');
      for (const opt of f.options) {
        const b = el('button', 'choice-btn', opt);
        b.setAttribute('aria-pressed', String(state.sim.inputs[f.key] === opt));
        b.addEventListener('click', () => { state.sim.inputs[f.key] = opt; runSimulation(); });
        row.appendChild(b);
      }
      box.appendChild(row);
    } else {
      const row = el('div', `sim-input-row${f.kind === 'currency' || f.kind === 'duration' ? '' : ' single'}`);
      const input = el('input');
      input.id = id;
      input.value = state.sim.inputs[f.key] ?? '';
      input.inputMode = f.kind === 'currency' || f.kind === 'number' ? 'decimal' : 'text';
      input.addEventListener('input', () => { state.sim.inputs[f.key] = input.value; });
      input.addEventListener('change', runSimulation);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') runSimulation(); });
      row.appendChild(input);
      if (f.kind === 'currency') row.appendChild(el('div', 'unit', f.currency || 'amount'));
      if (f.kind === 'duration') row.appendChild(el('div', 'unit', 'days'));
      box.appendChild(row);
    }
    host.appendChild(box);
  }

  if (decisions.length) {
    host.appendChild(sectionLabel('People decisions'));
    for (const d of decisions) {
      const box = el('div', 'sim-field');
      box.appendChild(el('label', null, d.label));
      box.appendChild(el('span', 'why', `Pretend ${d.help.replace(/^Obtain /, '')} came back as…`));
      if (state.sim.inputs[d.key] === undefined) state.sim.inputs[d.key] = d.default;

      const row = el('div', 'choice-row');
      for (const opt of d.options) {
        const b = el('button', 'choice-btn', opt);
        b.setAttribute('aria-pressed', String(state.sim.inputs[d.key] === opt));
        b.addEventListener('click', () => { state.sim.inputs[d.key] = opt; runSimulation(); });
        row.appendChild(b);
      }
      box.appendChild(row);
      host.appendChild(box);
    }
  }

  renderSimResult();
}

function sectionLabel(text) {
  const p = el('p', 'eyebrow');
  p.appendChild(el('span', null, text));
  p.appendChild(el('span', 'fill'));
  return p;
}

function emptyBox(glyph, text) {
  const box = el('div', 'sim-empty');
  box.appendChild(el('span', 'big', glyph));
  box.appendChild(document.createTextNode(text));
  return box;
}

const VERDICT_ICON = {
  complete: '✅', terminated: '🛑', loop: '🔁',
  'needs-input': '✏️', blocked: '⚠️', stuck: '⚠️', runaway: '⚠️'
};
const VERDICT_TITLE = {
  complete: 'The process ran all the way through',
  terminated: 'The process stopped on purpose',
  loop: 'The process went round in a circle',
  'needs-input': 'We need one more value',
  blocked: 'A decision could not be made',
  stuck: 'The process has nowhere to go',
  runaway: 'The walk did not finish'
};

function renderSimResult() {
  const host = $('simResult');
  host.textContent = '';
  const result = state.sim.result;

  if (!result) {
    host.appendChild(emptyBox('▶', 'Press “Run test” to walk a single case through the process. The path it takes will light up in the Blueprint tab.'));
    return;
  }

  const verdict = el('div', 'sim-verdict');
  verdict.dataset.status = result.status;
  verdict.appendChild(el('span', 'icon', VERDICT_ICON[result.status] || 'ℹ️'));
  const vb = el('div');
  vb.appendChild(el('b', null, VERDICT_TITLE[result.status] || result.status));
  vb.appendChild(document.createTextNode(result.summary));
  verdict.appendChild(vb);
  host.appendChild(verdict);

  const list = el('ol', 'sim-steps');
  result.steps.forEach((step, i) => {
    const li = el('li', 'sim-step');
    li.dataset.active = String(i <= state.sim.cursor);
    if (step.terminalReason) li.dataset.terminal = step.terminalReason;
    if (step.repeat) li.dataset.repeat = 'true';

    li.appendChild(el('span', 'num', String(i + 1)));
    const body = el('div', 'body');
    const node = state.workflow.nodes.find(n => n.id === step.nodeId);
    const name = el('div', 'sname', node ? displayName(node) : step.name);
    if (step.lane) name.appendChild(el('span', 'swho', step.lane));
    body.appendChild(name);
    body.appendChild(el('div', 'snote', step.note));
    li.appendChild(body);

    li.addEventListener('click', () => {
      state.sim.cursor = i;
      state.selectedNode = step.nodeId;
      renderSimResult();
      renderDiagram();
      renderInspector();
    });
    list.appendChild(li);
  });
  host.appendChild(list);
}

async function runSimulation() {
  if (!state.workflow) return;
  const result = simulate(state.workflow, state.sim.inputs);
  state.sim.result = result;
  state.sim.cursor = result.steps.length - 1;

  await state.ledger.append({
    event: AUDIT_EVENTS.SIMULATION_RUN,
    workflowId: state.workflow.workflowId,
    subject: result.status,
    detail: { inputs: state.sim.inputs, status: result.status, steps: result.steps.length, path: result.path }
  });

  renderSimulator();
  renderDiagram();
  renderLedger();
  renderBadges();
  $('simHint').textContent = result.summary;
}

function simStep(delta) {
  const result = state.sim.result;
  if (!result) return;
  state.sim.cursor = Math.max(0, Math.min(result.steps.length - 1, state.sim.cursor + delta));
  state.selectedNode = result.path[state.sim.cursor];
  renderSimResult();
  renderDiagram();
}

function simPlay() {
  const result = state.sim.result;
  if (!result) { runSimulation(); return; }
  if (state.sim.playing) { stopPlay(); return; }
  state.sim.playing = true;
  $('simPlay').textContent = '❚❚ Pause';
  state.sim.cursor = 0;
  renderSimResult();
  renderDiagram();
  state.sim.timer = setInterval(() => {
    if (state.sim.cursor >= result.steps.length - 1) { stopPlay(); return; }
    simStep(1);
  }, 850);
}

function stopPlay() {
  state.sim.playing = false;
  clearInterval(state.sim.timer);
  $('simPlay').textContent = '▶ Play';
}

function clearSimulation() {
  stopPlay();
  state.sim.result = null;
  state.sim.cursor = 0;
  renderSimulator();
  renderDiagram();
  $('simHint').textContent = 'Set some example values and watch which path the process takes.';
}

/* ------------------------------------------------------------------ */
/* language mode                                                       */
/* ------------------------------------------------------------------ */

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $('modePlain').setAttribute('aria-pressed', String(mode === 'plain'));
  $('modeTech').setAttribute('aria-pressed', String(mode === 'technical'));
  try { localStorage.setItem('t2w.mode', mode); } catch { /* private window */ }
  if (state.workflow) renderAll();
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

const TABS = ['diagram', 'simulate', 'json', 'dictionary', 'findings', 'audit', 'exports'];

function selectTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
    $(`panel-${t}`).hidden = t !== name;
  }
  if (name === 'diagram' && state.workflow) renderDiagram();
  if (name === 'simulate' && state.workflow) renderSimulator();
}

TABS.forEach(t => $(`tab-${t}`).addEventListener('click', () => selectTab(t)));

/* ------------------------------------------------------------------ */
/* downloads & clipboard                                               */
/* ------------------------------------------------------------------ */

async function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  await state.ledger.append({
    event: AUDIT_EVENTS.WORKFLOW_EXPORTED,
    workflowId: state.workflow?.workflowId ?? null,
    subject: filename,
    detail: { filename, bytes: content.length, mime }
  });
  renderLedger();
  renderBadges();
  toast(`${filename} downloaded`, 'ok');
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied — ${text.length.toLocaleString()} characters`, 'ok');
  } catch {
    toast('Clipboard blocked by the browser.', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function buildSamples() {
  const host = $('samples');
  SAMPLES.forEach((s, i) => {
    const chip = el('button', 'chip', s.label);
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => {
      $('utterance').value = s.text;
      [...host.children].forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
      showSampleNote(s);
      run();
    });
    host.appendChild(chip);
    if (i === 0) chip.setAttribute('aria-pressed', 'true');
  });
}

function showSampleNote(s) {
  const note = $('sampleNote');
  note.hidden = false;
  note.textContent = '';
  note.append(el('b', null, s.persona), document.createTextNode(` — ${s.demonstrates}`));
}

$('runBtn').addEventListener('click', () => run({ logUtterance: true }));
$('blueprintBtn').addEventListener('click', () => {
  selectTab('diagram');
  run({ logUtterance: true, announce: 'Blueprint regenerated from the current sentence.' });
});
$('resetBtn').addEventListener('click', async () => {
  if (!Object.keys(state.resolutions).length) { toast('No answers to reset.', 'warn'); return; }
  state.resolutions = {};
  await state.ledger.append({
    event: AUDIT_EVENTS.ANSWER_WITHDRAWN,
    workflowId: state.workflow?.workflowId ?? null,
    subject: 'all',
    detail: { reason: 'user reset all answers' }
  });
  await run();
  toast('All answers withdrawn.', 'warn');
});
$('clearLog').addEventListener('click', () => { $('term').innerHTML = ''; });

$('utterance').addEventListener('input', renderMeter);
$('utterance').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run({ logUtterance: true }); }
});

// Number keys answer the top clarification without reaching for the mouse.
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (!/^[1-9]$/.test(e.key)) return;
  const first = $('questions').querySelector('.question:not(.sev-info) .option');
  if (!first) return;
  const opts = first.parentElement.querySelectorAll('.option');
  const pick = opts[Number(e.key) - 1];
  if (pick) { e.preventDefault(); pick.click(); }
});

$('zoomIn').addEventListener('click', () => { state.zoom = Math.min(2.5, currentScale() + 0.15); renderDiagram(); });
$('zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.25, currentScale() - 0.15); renderDiagram(); });
$('zoomReset').addEventListener('click', () => { state.zoom = null; renderDiagram(); });
window.addEventListener('resize', () => { if (state.zoom == null && state.workflow) renderDiagram(); });

$('dlSvg').addEventListener('click', async () => {
  const svg = $('diagram').querySelector('svg');
  if (!svg) return;
  const css = [...document.styleSheets]
    .flatMap(s => { try { return [...s.cssRules].map(r => r.cssText); } catch { return []; } })
    .join('\n');
  await download(`${state.workflow.workflowId}-blueprint.svg`, svgToFile(svg, css), 'image/svg+xml');
});

$('copyJson').addEventListener('click', () => copy(JSON.stringify(state.workflow, null, 2), 'Schema JSON'));
$('dlJson').addEventListener('click', () =>
  download(`${state.workflow.workflowId}.json`, JSON.stringify(state.workflow, null, 2), 'application/json'));
$('copyDict').addEventListener('click', () => copy(dictionaryCsv(), 'Schema dictionary'));
$('copyExport').addEventListener('click', () => {
  const { fmt, text } = currentExport();
  copy(text, fmt.label);
});
$('dlExport').addEventListener('click', () => {
  const { fmt, text, filename } = currentExport();
  download(filename, text, fmt.mime);
});
$('dlLedger').addEventListener('click', () =>
  download(`${state.workflow.workflowId}-audit.json`, JSON.stringify(state.ledger.toJSON(), null, 2), 'application/json'));

$('verifyBtn').addEventListener('click', async () => {
  const result = await state.ledger.verify();
  const banner = $('verifyBanner');
  banner.hidden = false;
  banner.dataset.valid = String(result.valid);
  banner.textContent = result.valid
    ? `Chain intact — ${result.checked} entries re-hashed, every link matches. Head ${state.ledger.head.slice(0, 28)}…`
    : `Chain BROKEN at entry ${result.brokenAt}: ${result.reason}`;
  await state.ledger.append({
    event: AUDIT_EVENTS.LEDGER_VERIFIED,
    workflowId: state.workflow?.workflowId ?? null,
    subject: state.ledger.head,
    detail: { valid: result.valid, checked: result.checked, brokenAt: result.brokenAt }
  });
  renderLedger();
  renderBadges();
  toast(result.valid ? `${result.checked} entries verified` : 'Chain verification failed', result.valid ? 'ok' : 'error');
});

// Demonstrates detection on a *copy*. The real ledger is never modified —
// there is no code path in this app that edits a written entry.
$('tamperBtn').addEventListener('click', async () => {
  const entries = state.ledger.entries;
  if (entries.length < 2) { toast('Not enough entries yet.', 'warn'); return; }
  const target = Math.floor(entries.length / 2);
  const forged = entries.map((e, i) => i === target ? { ...e, detail: { ...e.detail, forged: true } } : e);
  const result = await AuditLedger.fromEntries(forged).verify();
  const banner = $('verifyBanner');
  banner.hidden = false;
  banner.dataset.valid = String(result.valid);
  banner.textContent = result.valid
    ? 'Unexpected: the forged copy verified.'
    : `Detected on a forged copy — entry ${entries[target].seq} was edited, and verification stops at entry ${result.brokenAt}: ${result.reason}. The live ledger below is untouched.`;
  toast('Tamper detected on the forged copy.', 'warn', 3600);
});

/* ------------------------------------------------------------------ */

$('simRun').addEventListener('click', runSimulation);
$('simNext').addEventListener('click', () => { stopPlay(); simStep(1); });
$('simPrev').addEventListener('click', () => { stopPlay(); simStep(-1); });
$('simFirst').addEventListener('click', () => { stopPlay(); state.sim.cursor = 0; renderSimResult(); renderDiagram(); });
$('simPlay').addEventListener('click', simPlay);
$('simClear').addEventListener('click', clearSimulation);

$('modePlain').addEventListener('click', () => setMode('plain'));
$('modeTech').addEventListener('click', () => setMode('technical'));

let storedMode = 'plain';
try { storedMode = localStorage.getItem('t2w.mode') || 'plain'; } catch { /* private window */ }
setMode(storedMode === 'technical' ? 'technical' : 'plain');

buildSamples();
$('utterance').value = SAMPLES[0].text;
showSampleNote(SAMPLES[0]);
run({ logUtterance: true });
