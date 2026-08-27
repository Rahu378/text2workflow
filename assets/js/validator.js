/**
 * validator.js — the self-reflection pass.
 *
 * It runs over the *compiled graph*, not over the sentence, so it catches
 * structural defects (a gateway branch that goes nowhere, an approval with no
 * rejection path) as well as semantic gaps (a threshold with no currency).
 *
 * Three deliberate design choices:
 *
 *  1. Every finding that a human could resolve carries a `question`. The UI
 *     answers it, the answer goes into `resolutions`, and the workflow is
 *     recompiled from scratch. That is the loop.
 *
 *  2. Every finding carries BOTH a technical description and a `plain` one.
 *     The technical text names rules and node types; the plain text says the
 *     same thing to someone who has never seen a BPMN diagram. Neither is a
 *     watered-down version of the other — the plain text is what the product
 *     actually shows by default.
 *
 *  3. There is no confidence percentage. The engine reports *which* checks
 *     passed and which did not; it does not claim a calibrated probability
 *     that the workflow is correct, because nothing here has been measured
 *     against a labelled gold set.
 */

import { VAGUE_TERMS, ROLES, CONNECTORS, STATUS_HINTS, describeField, describeOperator } from './lexicon.js';
import { describeRetry, describeBreaker } from './resilience.js';

const CURRENCY_OPTIONS = [
  { code: 'USD', label: 'US Dollars ($)' },
  { code: 'EUR', label: 'Euros (€)' },
  { code: 'GBP', label: 'British Pounds (£)' },
  { code: 'JPY', label: 'Japanese Yen (¥)' },
  { code: 'INR', label: 'Indian Rupees (₹)' }
];

const SEVERITY_RANK = { blocker: 0, warning: 1, info: 2 };

function finding(o) {
  return { severity: 'warning', nodeId: null, question: null, plain: null, ...o };
}

/** Money and counts, written the way a person reads them. */
function money(value, currency) {
  const n = Number(value).toLocaleString('en-US');
  return currency ? `${n} ${currency}` : n;
}

/** "the invoice amount" rather than `invoice.amount`. */
function friendly(path) {
  const f = describeField(path);
  return `the ${f.objectLabel} ${f.label.toLowerCase()}`.replace(/\s+/g, ' ');
}

/** A whole condition as a sentence: "the invoice amount is more than 10,000 USD". */
function conditionSentence(c) {
  if (!c || c.unresolved) return c?.raw || 'this condition';
  const f = describeField(c.subject);
  const kind = c.valueType === 'money' ? 'currency' : c.valueType === 'number' ? 'number' : f.kind;
  const rhs = (c.valueType === 'money' || c.valueType === 'number')
    ? money(c.value, c.currency)
    : `"${c.value}"`;
  return `${friendly(c.subject)} ${describeOperator(c.operator, kind)} ${rhs}`;
}

/* ------------------------------------------------------------------ */
/* structural checks                                                   */
/* ------------------------------------------------------------------ */

function checkReachability(wf) {
  const out = new Map();
  wf.nodes.forEach(n => out.set(n.id, []));
  wf.edges.forEach(e => out.get(e.from)?.push(e.to));

  const seen = new Set();
  const stack = ['n_start'];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    (out.get(id) || []).forEach(n => stack.push(n));
  }

  const findings = [];
  for (const n of wf.nodes) {
    if (!seen.has(n.id)) {
      findings.push(finding({
        rule: 'R-ORPHAN', severity: 'blocker', nodeId: n.id,
        title: 'Unreachable step',
        detail: `"${n.name}" cannot be reached from the trigger. No path of edges connects it to the start event.`,
        plain: {
          title: 'A step can never happen',
          detail: `Nothing in the process leads to "${n.name}". As the process is written today, that step would simply never run.`
        }
      }));
    }
    const isTerminal = n.type === 'end' || n.type === 'end.terminate';
    if (!isTerminal && (out.get(n.id) || []).length === 0) {
      findings.push(finding({
        rule: 'R-DEADEND', severity: 'blocker', nodeId: n.id,
        title: 'Step has no outgoing path',
        detail: `"${n.name}" is not an end event but nothing follows it. The process would stop here with no completion state.`,
        plain: {
          title: 'The process trails off',
          detail: `After "${n.name}" there is nothing. The work would sit there with no-one told it had finished.`
        }
      }));
    }
    if (n.type === 'gateway.exclusive') {
      const branches = (out.get(n.id) || []).length;
      if (branches < 2) {
        findings.push(finding({
          rule: 'R-GATEWAY-ARITY', severity: 'blocker', nodeId: n.id,
          title: 'Decision has only one outcome',
          detail: `"${n.name}" is an exclusive decision but only ${branches} path leaves it. A decision with one outcome is not a decision.`,
          plain: {
            title: 'A yes/no question with only one answer',
            detail: `"${n.name}" asks a question, but only one route leads away from it. Whichever way the answer goes, the same thing happens — so the question changes nothing.`
          }
        }));
      }
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* conditions                                                          */
/* ------------------------------------------------------------------ */

/** Status words in the raw text → quick-pick buttons instead of a form. */
function statusSuggestions(raw) {
  const lower = String(raw || '').toLowerCase();
  const hits = [];
  for (const hint of STATUS_HINTS) {
    if (hint.match.some(m => lower.includes(m)) && !hits.includes(hint.value)) hits.push(hint.value);
  }
  // "if approved" implies the opposite branch matters too.
  if (hits.includes('Approved') && !hits.includes('Rejected')) hits.push('Rejected');
  if (hits.includes('Rejected') && !hits.includes('Approved')) hits.unshift('Approved');
  return hits;
}

function checkConditions(wf, resolutions) {
  const findings = [];
  const gateways = wf.nodes.filter(n => n.type === 'gateway.exclusive' && n.condition);

  for (const g of gateways) {
    const c = g.condition;

    if (c.unresolved) {
      const suggestions = statusSuggestions(c.raw);
      const subjectObject = wf.nodes.map(n => n.object).find(Boolean);
      findings.push(finding({
        rule: 'R-PREDICATE', severity: 'blocker', nodeId: g.id,
        title: 'Condition could not be turned into a test',
        detail: `"${c.raw}" has no comparison the engine can evaluate. A runtime needs a field, an operator and a value.`,
        plain: {
          title: 'We need to know how to check this',
          detail: `You wrote "${c.raw}". A person knows what that means, but the process has to check something specific — a number, a status, a name — against a specific value. Tell us what to look at and what it should be.`
        },
        question: {
          id: `predicate:${g.id}`,
          kind: 'predicate',
          prompt: `How should "${c.raw}" be checked?`,
          plainPrompt: `When the process reaches this point, what should it look at to decide?`,
          help: 'Pick the piece of information to check, how to compare it, and what to compare it against.',
          // If the phrase mentions a status, offer it as one click first.
          suggestions: suggestions.map(v => ({
            label: `${subjectObject ? subjectObject.replace(/\b[a-z]/, ch => ch.toUpperCase()) : 'Record'} status is "${v}"`,
            value: {
              subject: `${subjectObject ? subjectObject.replace(/\s+/g, '') : 'record'}.status`,
              operator: 'eq', value: v, valueType: 'string'
            }
          })),
          mentionedObjects: [...new Set(wf.nodes.map(n => n.object).filter(Boolean))]
        }
      }));
      continue;
    }

    if (c.valueType === 'money' && !c.currency) {
      findings.push(finding({
        rule: 'R-CURRENCY', severity: 'blocker', nodeId: g.id,
        title: 'Threshold has no currency',
        detail: `The value ${Number(c.value).toLocaleString('en-US')} carries no currency. "over 1M" means different things in USD and JPY, and a mismatch here silently mis-routes every approval.`,
        plain: {
          title: 'Which currency is that?',
          detail: `You wrote a limit of ${Number(c.value).toLocaleString('en-US')}, but not whether that means dollars, euros or something else. One million yen and one million dollars are very different limits, so the process would route approvals wrongly without knowing.`
        },
        question: {
          id: `currency:${g.id}`,
          kind: 'choice',
          prompt: `Which currency is the ${Number(c.value).toLocaleString('en-US')} threshold in?`,
          plainPrompt: `Your limit of ${Number(c.value).toLocaleString('en-US')} — is that in…?`,
          options: CURRENCY_OPTIONS.map(o => ({ label: o.label, value: { currency: o.code } }))
        }
      }));
    }

    if (c.subjectInferred && !resolutions[`subject:${g.id}`]) {
      const candidates = g.trace?.candidates;
      const wrote = g.trace?.subjectRaw || c.raw;
      const ambiguous = candidates?.length > 1;
      findings.push(finding({
        rule: 'R-SUBJECT-INFERRED',
        severity: ambiguous ? 'blocker' : 'info',
        nodeId: g.id,
        title: ambiguous ? 'Ambiguous subject' : 'Subject inferred from earlier text',
        detail: ambiguous
          ? `The sentence mentions more than one record before this test, so "${wrote}" could refer to any of them.`
          : `"${wrote}" was bound to \`${c.subject}\` by carrying the object forward from an earlier clause.`,
        plain: ambiguous
          ? {
            title: 'Which one did you mean?',
            detail: `You mentioned ${candidates.map(cd => `a ${cd.name}`).join(' and ')} before writing "${wrote}". We can't tell which one you meant, and picking the wrong one would check the wrong number.`
          }
          : {
            title: `We took "${wrote}" to mean ${friendly(c.subject)}`,
            detail: `Your sentence didn't name it outright, so we used the ${describeField(c.subject).objectLabel} you mentioned just before. Worth a glance to confirm.`
          },
        question: ambiguous ? {
          id: `subject:${g.id}`,
          kind: 'choice',
          prompt: `Which record does "${wrote}" refer to?`,
          plainPrompt: `When you wrote "${wrote}", which one did you mean?`,
          options: candidates.map(cd => ({
            label: `The ${cd.name}`,
            hint: cd.path,
            value: { path: cd.path, objectId: cd.id }
          }))
        } : null
      }));
    }

    if (!g.branches?.elseHandled && !resolutions[`else:${g.id}`]) {
      const sentence = conditionSentence(c);
      findings.push(finding({
        rule: 'R-ELSE', severity: 'blocker', nodeId: g.id,
        title: 'Negative branch is implicit',
        detail: `The sentence says what happens when ${c.subject} ${c.operator} ${c.value}. It never says what happens when it does not. The compiler assumed "skip the extra step and carry on" — that assumption needs to be confirmed, not inherited.`,
        plain: {
          title: 'What happens the rest of the time?',
          detail: `You told us what to do when ${sentence}. You didn't say what to do when it isn't. We've assumed the process just carries on without the extra step — but that is our guess, not your policy.`
        },
        question: {
          id: `else:${g.id}`,
          kind: 'choice',
          prompt: `When "${g.name.replace(/\?$/, '')}" is false, what should happen?`,
          plainPrompt: `And when ${sentence} is NOT true?`,
          options: [
            { label: 'Carry on with the rest of the process', hint: 'skip the extra step', value: { action: 'continue' } },
            { label: 'Stop here — nothing further happens', hint: 'ends the process', value: { action: 'terminate' } }
          ]
        }
      }));
    }
  }

  // Two gates on the same field with contradictory thresholds.
  const bySubject = new Map();
  for (const g of gateways) {
    if (g.condition.unresolved) continue;
    const list = bySubject.get(g.condition.subject) || [];
    list.push(g);
    bySubject.set(g.condition.subject, list);
  }
  for (const [subject, list] of bySubject) {
    if (list.length < 2) continue;
    const values = [...new Set(list.map(g => `${g.condition.operator}:${g.condition.value}`))];
    if (values.length > 1) {
      findings.push(finding({
        rule: 'R-THRESHOLD-CONFLICT', severity: 'warning', nodeId: list[1].id,
        title: 'Two different thresholds on the same field',
        detail: `\`${subject}\` is tested ${list.length} times with different comparisons (${values.join(', ')}). Overlapping bands are the most common source of an approval being both required and skipped.`,
        plain: {
          title: 'Two different limits on the same thing',
          detail: `${friendly(subject).replace(/^the/, 'The')} is checked ${list.length} times against different limits — ${list.map(g => conditionSentence(g.condition).replace(friendly(subject) + ' ', '')).join(', and ')}. That may be exactly right, but overlapping limits are the usual reason an approval gets skipped by accident. Worth reading twice.`
        }
      }));
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */

/** Roles already in play come first — most of the time it is one of those. */
function roleOptions(wf) {
  const inPlay = new Set(wf.participants.filter(p => p.kind === 'role').map(p => p.id));
  const ordered = [
    ...ROLES.filter(r => inPlay.has(r.id)),
    ...ROLES.filter(r => !inPlay.has(r.id) && r.seniority !== 'external')
  ];
  return ordered.slice(0, 14).map(r => ({
    label: r.name,
    hint: inPlay.has(r.id) ? 'already in this process' : null,
    value: { roleId: r.id, name: r.name }
  }));
}

/** Same idea for systems: prefer ones this workflow already talks to. */
function connectorOptions(wf) {
  const inPlay = new Set(wf.connectors.map(c => c.id));
  const ordered = [
    ...CONNECTORS.filter(c => inPlay.has(c.id)),
    ...CONNECTORS.filter(c => !inPlay.has(c.id))
  ];
  return ordered.slice(0, 14).map(c => ({
    label: c.name,
    hint: inPlay.has(c.id) ? 'already used here' : c.category,
    value: { connectorId: c.id, name: c.name }
  }));
}

function checkApprovals(wf, resolutions) {
  const findings = [];
  for (const n of wf.nodes) {
    if (n.type !== 'task.approval' && n.type !== 'task.review') continue;
    const verb = n.type === 'task.approval' ? 'approve' : 'review';

    if (!n.performer?.id) {
      findings.push(finding({
        rule: 'R-UNASSIGNED', severity: 'blocker', nodeId: n.id,
        title: 'Approval has no named approver',
        detail: `"${n.name}" does not name a role. The engine cannot route a task to nobody, and an unassigned approval is an unauditable one.`,
        plain: {
          title: 'Nobody is named to do this',
          detail: `"${n.name}" doesn't say who does it. The process has to put the task in somebody's queue, and later nobody could say who was responsible for the decision.`
        },
        question: {
          id: `assignee:${n.id}`,
          kind: 'choice',
          prompt: `Who performs "${n.name}"?`,
          plainPrompt: `Who should ${verb} this?`,
          options: roleOptions(wf)
        }
      }));
    }

    if (!n.outcomeGatewayId && !resolutions[`reject:${n.id}`]) {
      const who = n.performer?.name || 'the approver';
      findings.push(finding({
        rule: 'R-NO-REJECT-PATH', severity: 'blocker', nodeId: n.id,
        title: 'Approval has no rejection path',
        detail: `"${n.name}" has two possible outcomes but the workflow only models one. As compiled, a rejection would fall through to the next step exactly like an approval — the control does nothing.`,
        plain: {
          title: `What if ${who} says no?`,
          detail: `Right now the process only describes what happens when ${who} says yes. If they say no, the work would carry straight on as though they had approved it — so the approval step wouldn't actually stop anything.`
        },
        question: {
          id: `reject:${n.id}`,
          kind: 'choice',
          prompt: `If ${who} rejects, what happens?`,
          plainPrompt: `If ${who} says no, what should happen?`,
          options: [
            { label: 'The request is turned down and the process ends', value: { action: 'terminate' } },
            { label: 'It goes back to the requester to fix and resubmit', hint: 'creates a rework loop', value: { action: 'return', returnTo: 'Requester' } },
            { label: 'It escalates to someone more senior', value: { action: 'escalate', escalateTo: 'next level' } }
          ]
        }
      }));
    }

    if (n.sla?.source === 'default' && !resolutions[`sla:${n.id}`]) {
      const who = n.performer?.name || 'the approver';
      const days = Math.round((n.sla.durationSeconds || 0) / 86400);
      findings.push(finding({
        rule: 'R-NO-SLA', severity: 'warning', nodeId: n.id,
        title: 'Approval deadline was defaulted, not stated',
        detail: `"${n.name}" carries a placeholder deadline of ${days} business day${days === 1 ? '' : 's'} so the blueprint is not silent about time. Unlike the retry defaults this is a guess at *policy*, not a technical standard, and it should be confirmed.`,
        plain: {
          title: `We put a ${days}-day deadline on this — is that right?`,
          detail: `Your sentence didn't say how long ${who} has. We've filled in ${days} business day${days === 1 ? '' : 's'} so the process chases it automatically instead of letting it sit forever, but that number is ours, not your policy.`
        },
        question: {
          id: `sla:${n.id}`,
          kind: 'choice',
          prompt: `How long may "${n.name}" wait before it escalates?`,
          plainPrompt: `How long should we wait for ${who} before chasing it?`,
          options: [
            { label: '4 hours', value: { seconds: 14400, businessDays: false, onBreach: 'escalate' } },
            { label: '1 business day', value: { seconds: 86400, businessDays: true, onBreach: 'escalate' } },
            { label: '3 business days', value: { seconds: 259200, businessDays: true, onBreach: 'escalate' } },
            { label: 'No deadline — leave it open', hint: 'nothing will chase it', value: { seconds: null, businessDays: false, onBreach: 'none' } }
          ]
        }
      }));
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* connectors                                                          */
/* ------------------------------------------------------------------ */

function checkConnectors(wf, resolutions) {
  const findings = [];
  const needsSystem = ['task.data.write', 'task.data.read', 'task.create'];
  const VERB = { 'task.data.write': 'saved to', 'task.data.read': 'looked up in', 'task.create': 'created in' };

  for (const n of wf.nodes) {
    if (needsSystem.includes(n.type) && !n.operation) {
      findings.push(finding({
        rule: 'R-NO-CONNECTOR', severity: 'blocker', nodeId: n.id,
        title: 'Step names no system of record',
        detail: `"${n.name}" reads or writes data but does not say where. There is no endpoint to generate.`,
        plain: {
          title: 'Which system?',
          detail: `"${n.name}" moves information around, but doesn't say which system it goes to. Without that, there's nothing for anyone to build.`
        },
        question: {
          id: `connector:${n.id}`,
          kind: 'choice',
          prompt: `Which system does "${n.name}" use?`,
          plainPrompt: `Where should this be ${VERB[n.type] || 'handled in'}?`,
          options: connectorOptions(wf)
        }
      }));
    }

    if (!n.operation || !n.retry) continue;
    const conn = n.operation.connector;
    const isWrite = n.type === 'task.data.write' || n.type === 'task.create';

    /* --- the default policy, stated rather than assumed --------------- */
    if (n.retry.source === 'default' && !resolutions[`retry:${n.id}`]) {
      findings.push(finding({
        rule: 'R-RETRY-DEFAULTED', severity: 'info', nodeId: n.id,
        title: 'Failure policy applied from the standard profile',
        detail: `"${n.name}" inherited the ${n.circuitBreaker ? `${n.retry.source} ` : ''}policy for a ${n.idempotency?.operationIsIdempotent ? 'repeatable' : 'non-repeatable'} ${conn} call: ${describeRetry(n.retry)}; ${describeBreaker(n.circuitBreaker)}; request timeout ${n.timeoutSeconds}s.`,
        plain: {
          title: `If ${conn} is slow or down, here is what happens`,
          detail: `We've applied the standard policy for this kind of system: ${describeRetry(n.retry)}. The engine also stops calling ${conn} entirely after repeated failures rather than piling on — ${describeBreaker(n.circuitBreaker)}. Change it if your team does something different.`
        },
        question: {
          id: `retry:${n.id}`,
          kind: 'choice',
          prompt: `Override the failure policy for "${n.name}"?`,
          plainPrompt: `Keep the standard policy for ${conn}, or choose another?`,
          options: [
            { label: `Keep the standard: ${describeRetry(n.retry)}`, hint: 'recommended', value: { ...n.retry, source: 'clarified' } },
            { label: 'Try harder — 6 attempts, then alert someone', value: { maxAttempts: 6, backoff: 'exponential', initialIntervalSeconds: 2, backoffCoefficient: 2, maxIntervalSeconds: 120, jitter: 'full', onExhausted: 'alert' } },
            { label: 'Do not retry — stop and tell someone on the first failure', hint: 'safest when duplicates are costly', value: { maxAttempts: 1, backoff: 'none', initialIntervalSeconds: 0, backoffCoefficient: 1, maxIntervalSeconds: 0, jitter: 'none', onExhausted: 'alert' } }
          ]
        }
      }));
    }

    /* --- retries on a call that could duplicate ---------------------- */
    if (isWrite && n.idempotency?.keyRequired && n.idempotency.targetSupportsDeduplication === null && !resolutions[`dedupe:${n.id}`]) {
      findings.push(finding({
        rule: 'R-DEDUP-UNVERIFIED', severity: 'warning', nodeId: n.id,
        title: 'Retry safety depends on an unverified assumption',
        detail: `"${n.name}" is not idempotent — ${n.idempotency.reason}. The compiled call carries \`${n.idempotency.header}: ${n.idempotency.key}\`, but that only prevents a duplicate if ${conn} actually deduplicates on it. If it does not, the ${n.retry.maxAttempts}-attempt policy can post the record more than once.`,
        plain: {
          title: `Could a retry create two records in ${conn}?`,
          detail: `If the first call to ${conn} times out, the engine tries again — but the first one may have quietly succeeded. We send a unique reference with each attempt so ${conn} can spot the repeat, but that only works if ${conn} is set up to check it. If it isn't, you could end up with the same record twice.`
        },
        question: {
          id: `dedupe:${n.id}`,
          kind: 'choice',
          prompt: `Does ${conn} deduplicate on ${n.idempotency.header}?`,
          plainPrompt: `Does ${conn} ignore a repeated request that carries the same reference?`,
          options: [
            { label: `Yes — ${conn} ignores a repeat with the same key`, hint: 'retries stay on', value: { dedupe: 'yes' } },
            { label: 'No — a repeat would create a second record', hint: 'retries are switched off', value: { dedupe: 'no' } },
            { label: "Not sure", hint: 'treated as "no" until someone confirms', value: { dedupe: 'unknown' } }
          ]
        }
      }));
    }

    if (n.retry.source === 'clarified' && n.retry.maxAttempts === 1 && n.retry.note) {
      findings.push(finding({
        rule: 'R-RETRIES-DISABLED', severity: 'info', nodeId: n.id,
        title: 'Retries disabled on purpose',
        detail: n.retry.note + ` A failure now goes straight to ${n.retry.onExhausted}.`,
        plain: {
          title: `${conn} will not be retried`,
          detail: `Because a repeat could create a duplicate, this step gets one attempt only. If it fails, someone is told rather than the engine trying again.`
        }
      }));
    }
  }

  /* --- more than one irreversible write in the same run ------------- */
  const risky = wf.nodes.filter(n =>
    n.operation && (n.type === 'task.data.write' || n.type === 'task.create') &&
    n.idempotency && !n.idempotency.operationIsIdempotent);

  if (risky.length > 1 && !risky[0].compensation?.configured && !resolutions['compensation:strategy']) {
    const [first, second] = risky;
    findings.push(finding({
      rule: 'R-PARTIAL-WRITE', severity: 'warning', nodeId: second.id,
      title: 'No rollback across multiple system writes',
      detail: `This process writes to ${risky.map(n => n.operation.connector).join(' and ')} in the same run, and neither write can be rolled back by the other. If "${second.name}" exhausts its retries after "${first.name}" has succeeded, the run ends with ${first.operation.connector} updated and ${second.operation.connector} not — and nothing in the compiled workflow reconciles that.`,
      plain: {
        title: 'One system could be updated and the other not',
        detail: `This process writes to both ${risky.map(n => n.operation.connector).join(' and ')}. If the second one fails after the first has already worked, you're left with the record in one place and not the other, and nothing puts that right on its own.`
      },
      question: {
        id: 'compensation:strategy',
        kind: 'choice',
        prompt: 'How should a partial write be handled?',
        plainPrompt: `If ${second.operation.connector} fails after ${first.operation.connector} has already been updated, what should happen?`,
        options: [
          { label: `Undo the earlier write — ${first.compensation?.action || 'reverse it'}`, hint: 'compensating action', value: { strategy: 'reverse' } },
          { label: 'Leave both and alert someone to reconcile', hint: 'manual reconciliation', value: { strategy: 'manual-reconcile' } },
          { label: 'Accept it — these systems are reconciled separately anyway', value: { strategy: 'accept' } }
        ]
      }
    }));
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* governance                                                          */
/* ------------------------------------------------------------------ */

const REGIME_PLAIN = {
  'financial-controls': 'money',
  PII: 'personal information',
  GDPR: 'personal data covered by GDPR',
  HIPAA: 'health information',
  'PCI-DSS': 'card details',
  SOX: 'financial reporting'
};

function checkGovernance(wf, resolutions) {
  const findings = [];
  const scope = wf.governance.regulatoryScope || [];
  const hasAuditStep = wf.nodes.some(n => n.type === 'task.audit');

  if (scope.length && !hasAuditStep && !resolutions['audit:insert']) {
    const plainScope = scope.map(s => REGIME_PLAIN[s] || s).join(' and ');
    findings.push(finding({
      rule: 'R-AUDIT', severity: 'blocker',
      title: 'Regulated flow with no explicit audit step',
      detail: `This process is in scope for ${scope.join(', ')} but writes no audit record of its own decisions. The engine keeps a hash-chained log of every run, and that log is immutable — but a regulator asking "who approved this and when" will look in the system of record, not in the orchestrator.`,
      plain: {
        title: 'No lasting record of who decided what',
        detail: `This process handles ${plainScope}, but it doesn't write down its own decisions anywhere permanent. If someone asks in a year's time who approved a particular item and when, there would be nothing to show them.`
      },
      question: {
        id: 'audit:insert',
        kind: 'choice',
        prompt: 'Where should the decision record be written?',
        plainPrompt: 'Where should we keep the record of each decision?',
        options: [
          { label: "Don't add a step — the engine's own log is enough", value: { enabled: false } },
          { label: 'Also write a record into Snowflake', value: { enabled: true, sink: 'Snowflake' } },
          { label: 'Also write a record into the ERP audit table', value: { enabled: true, sink: 'ERP Audit Table' } }
        ]
      }
    }));
  }

  const leaky = wf.nodes.filter(n =>
    n.type === 'task.notify' && scope.includes('PII') &&
    n.operation && ['messaging', 'email'].includes(
      CONNECTORS.find(c => c.id === n.operation.connectorId)?.category
    ));
  for (const n of leaky) {
    findings.push(finding({
      rule: 'R-PII-EGRESS', severity: 'warning', nodeId: n.id,
      title: 'Personal data leaves via a messaging channel',
      detail: `"${n.name}" pushes a record classified as PII into ${n.operation.connector}. Chat and email history are usually outside the retention and deletion controls that apply to the system of record.`,
      plain: {
        title: `Personal information is going into ${n.operation.connector}`,
        detail: `"${n.name}" sends personal details through ${n.operation.connector}. Chat and email history usually isn't covered by the same deletion and retention rules as your main systems, so that information can outlive the record it came from.`
      }
    }));
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/* language                                                            */
/* ------------------------------------------------------------------ */

function checkLanguage(wf) {
  const findings = [];
  const lower = wf.source.utterance.toLowerCase();
  const hits = VAGUE_TERMS.filter(t => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(lower));
  if (hits.length) {
    findings.push(finding({
      rule: 'R-VAGUE', severity: 'warning',
      title: 'Unquantified language in the request',
      detail: `The words ${hits.map(h => `"${h}"`).join(', ')} have no machine equivalent. They were carried into step names as written, which means two people reading the compiled workflow can still disagree about what it does.`,
      plain: {
        title: 'Some words here can\'t be turned into a rule',
        detail: `You used the word${hits.length > 1 ? 's' : ''} ${hits.map(h => `"${h}"`).join(', ')}. Those mean something to a colleague but nothing to a computer — and two people reading this process could still disagree about what it does. Replacing them with a number or a name would settle it.`
      }
    }));
  }

  for (const n of wf.nodes) {
    if (n.trace?.inferredObject) {
      findings.push(finding({
        rule: 'R-PRONOUN', severity: 'info', nodeId: n.id,
        title: 'Pronoun resolved by proximity',
        detail: `"${n.trace.clause}" uses a pronoun. It was bound to the ${n.object} mentioned earlier in the sentence — the nearest match, not a certainty.`,
        plain: {
          title: `We assumed "it" meant the ${n.object}`,
          detail: `In "${n.trace.clause}" you wrote a shorthand word rather than naming the record. We used the ${n.object} you mentioned just before. That's almost always right — worth a quick look.`
        }
      }));
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */

const CHECKS = [
  {
    id: 'structure',
    label: 'Graph is connected and every path terminates',
    plainLabel: 'Every step connects to the next, and the process always ends',
    run: (wf) => checkReachability(wf)
  },
  {
    id: 'conditions',
    label: 'Every decision is evaluable and both branches are defined',
    plainLabel: 'Every yes/no question can be answered, and both answers lead somewhere',
    run: checkConditions
  },
  {
    id: 'approvals',
    label: 'Every approval has an owner, an outcome and a deadline',
    plainLabel: 'Every approval has someone to do it, a deadline, and a plan if they say no',
    run: checkApprovals
  },
  {
    id: 'connectors',
    label: 'Every data step names a system and a failure policy',
    plainLabel: 'Every step that moves information says which system, and what to do if it fails',
    run: checkConnectors
  },
  {
    id: 'governance',
    label: 'Regulated data is logged and does not leak',
    plainLabel: 'Sensitive information is recorded properly and does not go somewhere it should not',
    run: checkGovernance
  },
  {
    id: 'language',
    label: 'No unquantified language survived into the workflow',
    plainLabel: 'Nothing vague was left in that a computer cannot act on',
    run: (wf) => checkLanguage(wf)
  }
];

/**
 * Run every check against a compiled workflow.
 * @returns {{status, findings, questions, checks, counts}}
 */
export function validate(wf, resolutions = {}) {
  const findings = [];
  const checks = [];

  for (const check of CHECKS) {
    const result = check.run(wf, resolutions) || [];
    findings.push(...result.map(f => ({ ...f, check: check.id })));
    checks.push({
      id: check.id,
      label: check.label,
      plainLabel: check.plainLabel,
      passed: result.filter(f => f.severity === 'blocker').length === 0,
      findingCount: result.length
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const counts = {
    blocker: findings.filter(f => f.severity === 'blocker').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length
  };

  const questions = findings.filter(f => f.question).map(f => ({
    ...f.question,
    rule: f.rule,
    severity: f.severity,
    nodeId: f.nodeId,
    title: f.title,
    plainTitle: f.plain?.title || f.title,
    plainDetail: f.plain?.detail || f.detail
  }));

  const status = counts.blocker > 0 ? 'blocked'
    : counts.warning > 0 ? 'needs-review'
    : 'ready';

  return { status, findings, questions, checks, counts };
}

export const RULES = [
  ['R-ORPHAN', 'blocker', 'A step exists that no path from the trigger reaches.'],
  ['R-DEADEND', 'blocker', 'A non-terminal step has no outgoing edge.'],
  ['R-GATEWAY-ARITY', 'blocker', 'An exclusive decision has fewer than two outcomes.'],
  ['R-PREDICATE', 'blocker', 'A condition has no field/operator/value the runtime can evaluate.'],
  ['R-CURRENCY', 'blocker', 'A monetary threshold carries no ISO 4217 currency.'],
  ['R-SUBJECT-INFERRED', 'blocker/info', 'A test subject was carried forward from earlier text; blocker when more than one record is in play.'],
  ['R-ELSE', 'blocker', 'A decision has no explicitly defined negative branch.'],
  ['R-UNASSIGNED', 'blocker', 'An approval or review names no performer.'],
  ['R-NO-REJECT-PATH', 'blocker', 'An approval models only the approved outcome.'],
  ['R-NO-CONNECTOR', 'blocker', 'A data step names no system of record.'],
  ['R-AUDIT', 'blocker', 'A flow in regulatory scope writes no audit record.'],
  ['R-NO-SLA', 'warning', 'An approval deadline was defaulted rather than stated.'],
  ['R-DEDUP-UNVERIFIED', 'warning', 'Retries are enabled on a non-idempotent write whose target has not been confirmed to deduplicate.'],
  ['R-PARTIAL-WRITE', 'warning', 'Two irreversible writes in one run with no compensation, so a late failure leaves partial state.'],
  ['R-RETRY-DEFAULTED', 'info', 'A failure policy was applied from the standard profile for the connector category.'],
  ['R-RETRIES-DISABLED', 'info', 'Retries were switched off because the target cannot deduplicate a repeat.'],
  ['R-THRESHOLD-CONFLICT', 'warning', 'The same field is tested with contradictory thresholds.'],
  ['R-PII-EGRESS', 'warning', 'Personal data is pushed to a messaging or email connector.'],
  ['R-VAGUE', 'warning', 'Unquantifiable language survived into the compiled workflow.'],
  ['R-PRONOUN', 'info', 'A pronoun was bound to the nearest preceding object.']
];
