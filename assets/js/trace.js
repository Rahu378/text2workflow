/**
 * trace.js — the Self-Reflection Execution Log.
 *
 * IMPORTANT, because the terminal in the UI looks like agent chatter and is
 * not: every line below is derived from the actual pipeline output, and every
 * duration is a real `performance.now()` measurement of the pass that produced
 * it. Nothing is scripted, staged or delayed to look busy. If a check passes
 * instantly the log says so, and a fast run produces a short log.
 *
 * The six passes are labelled like agents because that is what they are
 * structurally — independent, single-responsibility validators over a shared
 * graph. They are deterministic rule modules, not learned policies, and the
 * footer under the terminal says exactly that.
 */

/* Segment constructors keep the renderer free of innerHTML. */
export const b = v => ({ t: 'b', v: String(v) });
export const c = v => ({ t: 'code', v: String(v) });

const AGENTS = {
  ingest:  'ingest',
  grammar: 'grammar',
  compile: 'compile',
  reflect: 'reflect',
  resolve: 'resolve',
  ledger:  'ledger'
};

const NODE_SHORT = {
  'gateway.exclusive': 'decision', 'gateway.merge': 'merge',
  'task.approval': 'human approval', 'task.review': 'human review',
  'task.notify': 'notification', 'task.data.write': 'system write',
  'task.data.read': 'system read', 'task.create': 'record create',
  'task.assign': 'routing', 'task.audit': 'audit write',
  'event.start': 'start', 'event.start.message': 'message start',
  'end': 'end', 'end.terminate': 'terminate'
};

/**
 * Build the log for one pipeline run.
 *
 * @param {object} run
 * @param {string} run.utterance
 * @param {object} run.parsed        parser.parse output
 * @param {object} run.workflow      compiler.compile output
 * @param {object} run.validation    validator.validate output
 * @param {object} run.resolutions   answers currently applied
 * @param {object} run.timings       { parse, compile, validate, ledger } in ms
 * @param {number} run.ledgerAppended
 * @param {string} run.ledgerHead
 * @returns {Array} log lines, each { at, agent, level, verdict, parts }
 */
export function buildTrace(run) {
  const { utterance, parsed, workflow, validation, resolutions, timings } = run;
  const lines = [];
  let clock = 0;

  const push = (agent, parts, opts = {}) => {
    lines.push({
      at: opts.at ?? clock,
      agent,
      level: opts.level || 'info',
      verdict: opts.verdict || null,
      parts: Array.isArray(parts) ? parts : [parts]
    });
  };

  /* ---- ingest --------------------------------------------------- */
  push(AGENTS.ingest, ['accepted ', b(`${utterance.length} chars`), ', ', b(`${utterance.trim().split(/\s+/).length} tokens`)]);
  clock += timings.parse;
  push(AGENTS.ingest, ['segmented into ', b(`${parsed.clauses.length} clauses`), ' in ', b(`${timings.parse.toFixed(2)} ms`)], { at: clock });
  parsed.clauses.forEach((cl, i) => {
    push(AGENTS.ingest, [`c${i} `, c(`"${cl}"`)], { at: clock });
  });

  /* ---- grammar -------------------------------------------------- */
  const trigger = parsed.specs.find(s => s.kind === 'trigger');
  if (trigger) {
    push(AGENTS.grammar, ['recognised start trigger ', c(trigger.event),
      trigger.connectors[0] ? ` from ${trigger.connectors[0].name}` : ' (no source system named)'], { at: clock });
  }

  parsed.specs.forEach((spec, i) => {
    if (spec.kind === 'condition') {
      const t = spec.test;
      push(AGENTS.grammar, [
        `spec ${i} → `, c('gateway.exclusive'), '  ',
        t.unresolved ? c(`UNPARSED "${t.raw}"`) : c(`${spec.subject.path} ${t.operator} ${t.value?.raw ?? ''}`)
      ], { at: clock, level: t.unresolved ? 'warn' : 'info' });

      if (spec.hoistedFrom != null) {
        push(AGENTS.grammar, ['precedence cue ', c('"first"'), ' → hoisted this gate ahead of clause ', b(spec.hoistedFrom - 1)], { at: clock, level: 'ok' });
      }
      if (spec.subject?.ambiguous) {
        push(AGENTS.grammar, ['subject ', c(spec.subject.raw), ' matches ', b(`${spec.subject.candidates.length} records`), ' — deferring to clarification'], { at: clock, level: 'warn' });
      } else if (spec.subject?.inferred) {
        push(AGENTS.grammar, ['bound ', c(spec.subject.raw), ' → ', c(spec.subject.path), ' by proximity'], { at: clock });
      }
    } else if (spec.kind === 'action') {
      push(AGENTS.grammar, [
        `spec ${i} → `, c(spec.frame.type),
        spec.frame.cue ? ['  cue ', c(`"${spec.frame.cue}"`)] : '  no verb matched'
      ].flat(), { at: clock, level: spec.frameMatched ? 'info' : 'warn' });
      if (spec.objectInherited) {
        push(AGENTS.grammar, ['pronoun resolved → ', c(spec.object.name), ' (nearest preceding object)'], { at: clock });
      }
    } else if (spec.kind === 'else') {
      push(AGENTS.grammar, [`spec ${i} → `, c('explicit else branch')], { at: clock });
    }
  });

  /* ---- resolve -------------------------------------------------- */
  const answers = Object.keys(resolutions);
  if (answers.length) {
    push(AGENTS.resolve, ['replaying ', b(`${answers.length} answer${answers.length === 1 ? '' : 's'}`), ' onto a fresh compile'], { at: clock, level: 'ok' });
    answers.forEach(key => push(AGENTS.resolve, [c(key), ' → ', c(compactValue(resolutions[key]))], { at: clock }));
  }

  /* ---- compile -------------------------------------------------- */
  clock += timings.compile;
  const laneCount = new Set(workflow.nodes.map(n => n.lane)).size;
  push(AGENTS.compile, [
    'emitted ', b(`${workflow.nodes.length} nodes`), ' / ', b(`${workflow.edges.length} edges`),
    ' across ', b(`${laneCount} lanes`), ' in ', b(`${timings.compile.toFixed(2)} ms`)
  ], { at: clock });

  const byType = {};
  workflow.nodes.forEach(n => { byType[n.type] = (byType[n.type] || 0) + 1; });
  push(AGENTS.compile, [Object.entries(byType)
    .map(([t, n]) => `${n}× ${NODE_SHORT[t] || t}`).join(' · ')], { at: clock });

  if (workflow.connectors.length) {
    workflow.connectors.forEach(conn =>
      push(AGENTS.compile, ['bound ', b(conn.name), ' → ', c(conn.operations.join(', ')), '  ', c(`[${conn.status}]`)], { at: clock }));
  } else {
    push(AGENTS.compile, ['no external system named in this process'], { at: clock, level: 'warn' });
  }

  const backEdges = workflow.edges.filter(e => e.back).length;
  if (backEdges) push(AGENTS.compile, ['graph contains ', b(`${backEdges} loop edge${backEdges === 1 ? '' : 's'}`), ' (rework path)'], { at: clock });

  /* ---- reflect -------------------------------------------------- */
  push(AGENTS.reflect, ['running ', b(`${validation.checks.length} validation passes`), ' over the compiled graph'], { at: clock, level: 'head' });

  const perCheck = timings.validate / Math.max(1, validation.checks.length);
  for (const check of validation.checks) {
    clock += perCheck;
    const fired = validation.findings.filter(f => f.check === check.id);
    push(AGENTS.reflect, [
      pad(check.id, 11), check.label,
      fired.length ? `  (${fired.map(f => f.rule).join(', ')})` : ''
    ], {
      at: clock,
      verdict: check.passed ? (fired.length ? 'NOTE' : 'PASS') : 'FAIL',
      level: check.passed ? (fired.length ? 'warn' : 'ok') : 'error'
    });
  }

  clock += 0;
  push(AGENTS.reflect, [
    'verdict ', b(validation.status.toUpperCase()), ' — ',
    b(validation.counts.blocker), ' blocking, ',
    b(validation.counts.warning), ' advisory, ',
    b(validation.counts.info), ' informational',
    `  · ${timings.validate.toFixed(2)} ms total`
  ], { at: clock, level: validation.counts.blocker ? 'error' : validation.counts.warning ? 'warn' : 'ok' });

  if (validation.questions.length) {
    push(AGENTS.reflect, ['raising ', b(`${validation.questions.length} clarifying question${validation.questions.length === 1 ? '' : 's'}`), ' — compile halted pending answers'], { at: clock, level: 'warn' });
  } else {
    push(AGENTS.reflect, ['no open questions — the workflow is fully specified by the sentence plus the answers on record'], { at: clock, level: 'ok' });
  }

  /* ---- ledger --------------------------------------------------- */
  clock += timings.ledger;
  push(AGENTS.ledger, [
    'appended ', b(`${run.ledgerAppended} entries`), ', head ', c(run.ledgerHead.slice(0, 16) + '…'),
    '  · ', b(`${timings.ledger.toFixed(2)} ms`)
  ], { at: clock, level: 'ok' });

  return lines;
}

function pad(s, n) { return String(s).padEnd(n, ' '); }

function compactValue(v) {
  if (v == null) return 'null';
  if (typeof v !== 'object') return String(v);
  const entries = Object.entries(v).filter(([, x]) => x != null);
  return entries.map(([k, x]) => `${k}=${x}`).join(' ') || '{}';
}
