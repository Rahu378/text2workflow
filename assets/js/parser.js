/**
 * parser.js — natural language → intermediate representation (IR).
 *
 * This is a deterministic, rule-based grammar. It is NOT a language model:
 * the same sentence always produces the same IR, and anything the grammar
 * cannot resolve is emitted as an explicit `unresolved` marker rather than
 * guessed at. Those markers are what the validator turns into clarifying
 * questions, so an ambiguous sentence fails loudly instead of silently
 * compiling into a wrong workflow.
 */

import {
  ROLES, CONNECTORS, OBJECTS, VERB_FRAMES, CONDITION_CUES, ELSE_CUES,
  COMPARATORS, SEQUENCE_CUES, PRECEDENCE_CUES, PARALLEL_CUES,
  CURRENCIES, MAGNITUDES, DURATION_UNITS
} from './lexicon.js';

const PRONOUNS = ['it', 'this', 'that', 'them', 'they', 'the same', 'these', 'those'];

/** Bare nouns that mean "the money field of whatever we were just talking about". */
const GENERIC_AMOUNT_NOUNS = ['amount', 'total', 'value', 'sum', 'price', 'cost', 'balance', 'figure'];

/** Remember every distinct object the utterance has mentioned, in order. */
function noteObject(ctx, obj) {
  if (!obj) return;
  ctx.lastObject = obj;
  ctx.seenObjects = ctx.seenObjects || [];
  if (!ctx.seenObjects.some(o => o.id === obj.id)) ctx.seenObjects.push(obj);
}

/* ------------------------------------------------------------------ */
/* text utilities                                                      */
/* ------------------------------------------------------------------ */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word (or whole-phrase) search. Returns {index, length, pattern} or null. */
function findPhrase(haystack, pattern) {
  const p = escapeRe(pattern);
  // Symbols like '>=' have no word boundary, so only guard alphanumeric edges.
  const left = /^[a-z0-9]/i.test(pattern) ? '\\b' : '';
  const right = /[a-z0-9]$/i.test(pattern) ? '\\b' : '';
  const re = new RegExp(left + p + right, 'i');
  const m = re.exec(haystack);
  return m ? { index: m.index, length: m[0].length, pattern } : null;
}

/** First match across a list of patterns, earliest position wins. */
function findAny(haystack, patterns) {
  let best = null;
  for (const p of patterns) {
    const hit = findPhrase(haystack, p);
    if (hit && (!best || hit.index < best.index || (hit.index === best.index && hit.length > best.length))) {
      best = hit;
    }
  }
  return best;
}

function clean(s) {
  return s.replace(/\s+/g, ' ').replace(/^[\s,;.:—–-]+|[\s,;.:—–-]+$/g, '').trim();
}

function sentenceCase(s) {
  const t = clean(s);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/* ------------------------------------------------------------------ */
/* value extraction                                                    */
/* ------------------------------------------------------------------ */

const MONEY_RE = new RegExp(
  '(?:([$€£¥₹])\\s*)?' +                      // leading symbol
  '(\\d[\\d,]*(?:\\.\\d+)?)' +                 // number
  '\\s*(k|m|mm|bn|b|thousand|million|billion)?' + // magnitude
  '\\s*(usd|eur|gbp|jpy|inr|dollars?|euros?|pounds?|yen|rupees?)?',
  'i'
);

const PERCENT_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|percent)/i;

const DURATION_RE = new RegExp(
  '(\\d+|a|an|one|two|three|four|five|six|seven|ten|fourteen|thirty)\\s+' +
  '(business\\s+days?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)',
  'i'
);

const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14, thirty: 30 };

/** Parse a duration phrase → {seconds, businessDays, raw} or null. */
export function parseDuration(text) {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : (WORD_NUM[m[1].toLowerCase()] ?? 1);
  const unitRaw = m[2].toLowerCase().replace(/\s+/g, ' ');
  const key = unitRaw.replace(/s$/, '');
  const perUnit = DURATION_UNITS[unitRaw] ?? DURATION_UNITS[key] ?? DURATION_UNITS[key + 's'];
  if (!perUnit) return null;
  return {
    seconds: n * perUnit,
    businessDays: /business/.test(unitRaw),
    amount: n,
    unit: unitRaw,
    raw: clean(m[0])
  };
}

/**
 * Parse the right-hand side of a comparison.
 * Returns {kind, value, currency?, raw} — kind is money|percent|duration|number|literal.
 */
export function parseValue(text) {
  const t = clean(text);
  if (!t) return null;

  const pct = PERCENT_RE.exec(t);
  if (pct) return { kind: 'percent', value: parseFloat(pct[1].replace(/,/g, '')), raw: clean(pct[0]) };

  const dur = parseDuration(t);
  if (dur) return { kind: 'duration', value: dur.seconds, unit: dur.unit, raw: dur.raw };

  const m = MONEY_RE.exec(t);
  if (m && /\d/.test(m[0])) {
    let value = parseFloat(m[2].replace(/,/g, ''));
    const mag = m[3] ? MAGNITUDES[m[3].toLowerCase()] : null;
    if (mag) value *= mag;
    const symbol = m[1] ? CURRENCIES[m[1]] : null;
    const code = m[4] ? CURRENCIES[m[4].toLowerCase().replace(/s$/, '')] : null;
    const currency = symbol || code || null;
    return {
      kind: currency ? 'money' : 'number',
      value,
      currency,
      // A bare "10k" carries no unit — the validator asks about this. The
      // magnitude flag separates "over 10k" (almost certainly money) from
      // "over 5" (almost certainly a count), so the question is only raised
      // where a missing currency would actually mis-route something.
      currencyInferred: !currency,
      magnitude: Boolean(mag),
      raw: clean(m[0])
    };
  }

  return { kind: 'literal', value: t, raw: t };
}

/* ------------------------------------------------------------------ */
/* entity extraction                                                   */
/* ------------------------------------------------------------------ */

function matchEntities(text, table) {
  const hits = [];
  for (const entry of table) {
    for (const p of entry.patterns) {
      const hit = findPhrase(text, p);
      if (hit) { hits.push({ entry, index: hit.index, matched: hit.pattern }); break; }
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(h => ({ ...h.entry, at: h.index, matched: h.matched }));
}

/* ------------------------------------------------------------------ */
/* segmentation                                                        */
/* ------------------------------------------------------------------ */

/**
 * Split an utterance into ordered clauses.
 * Splits on sentence enders, semicolons, commas, and sequencing words —
 * but never inside a bracketed span or a number like "10,000".
 */
export function segment(utterance) {
  const text = clean(utterance);
  const parts = [];
  let buf = '';
  let i = 0;

  const seqRe = new RegExp('^(?:' + SEQUENCE_CUES.map(escapeRe).join('|') + ')\\b', 'i');

  while (i < text.length) {
    const rest = text.slice(i);

    // Never split a thousands separator: "10,000"
    const isNumericComma = text[i] === ',' && /\d/.test(text[i - 1] || '') && /^\s?\d/.test(text.slice(i + 1));

    if (!isNumericComma && /[,;.]/.test(text[i])) {
      if (clean(buf)) parts.push(clean(buf));
      buf = '';
      i += 1;
      continue;
    }

    const seq = seqRe.exec(rest);
    // Only treat a sequencing word as a split if it starts a word boundary.
    if (seq && (i === 0 || /[\s,;.]/.test(text[i - 1]))) {
      if (clean(buf)) parts.push(clean(buf));
      buf = '';
      i += seq[0].length;
      continue;
    }

    buf += text[i];
    i += 1;
  }
  if (clean(buf)) parts.push(clean(buf));

  // "and" joins two verbs into separate steps, but not two nouns ("legal and finance").
  const expanded = [];
  for (const p of parts) {
    const andSplit = splitOnCoordinatingAnd(p);
    expanded.push(...andSplit);
  }
  return expanded.filter(Boolean);
}

/** Split "X and Y" only when Y opens with its own action verb. */
function splitOnCoordinatingAnd(clause) {
  const re = /\band\b/gi;
  let m;
  while ((m = re.exec(clause)) !== null) {
    const tail = clause.slice(m.index + m[0].length);
    const head = clause.slice(0, m.index);
    if (!clean(head) || !clean(tail)) continue;
    const tailFrame = matchFrame(tail);
    const headFrame = matchFrame(head);
    // Both halves must be actions, and the tail's verb must be near its start.
    if (tailFrame && headFrame && tailFrame.at <= 12) {
      return [clean(head), ...splitOnCoordinatingAnd(clean(tail))];
    }
  }
  return [clean(clause)];
}

/* ------------------------------------------------------------------ */
/* frames                                                              */
/* ------------------------------------------------------------------ */

/** Highest-priority verb frame present in the clause. */
export function matchFrame(clause) {
  let best = null;
  for (const frame of VERB_FRAMES) {
    const hit = findAny(clause, frame.cues);
    if (!hit) continue;
    if (!best || frame.priority > best.priority) {
      best = { type: frame.type, label: frame.label, priority: frame.priority, cue: hit.pattern, at: hit.index };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* condition parsing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Find the comparator in a clause. Comparator classes are tried in
 * specificity order — "at least" before "is" — so "it is over $10k" reads as
 * `gt`, not `eq` on the stray "is".
 */
function findComparator(text) {
  for (const c of COMPARATORS) {
    const hit = findAny(text, c.patterns);
    if (hit) return { ...hit, op: c.op };
  }
  return null;
}

/**
 * Pull a structured test out of a conditional clause.
 * Returns {test, consequent, negated} where `test` may be marked unresolved.
 */
function parseConditional(clause) {
  const cue = findAny(clause, CONDITION_CUES);
  if (!cue || cue.index > 6) return null;

  const negated = /^unless\b/i.test(clause.slice(cue.index));
  let rest = clause.slice(cue.index + cue.length);

  const comp = findComparator(rest);
  if (!comp) {
    // No comparator we understand. Keep the raw predicate and flag it —
    // the validator turns this into a clarifying question.
    return {
      test: { unresolved: true, raw: clean(rest), reason: 'no-comparator' },
      consequent: '',
      negated
    };
  }

  const operator = comp.op;
  // Strip the trailing copula/auxiliary so "it is" resolves as the pronoun "it".
  const subjectRaw = clean(rest.slice(0, comp.index))
    .replace(/\s*\b(is|are|was|were|be|been|has|have|had|does|do|did|will|would|comes|came|goes|went)\b(\s+not)?\s*$/i, '')
    .replace(/\s*n't\s*$/i, '')
    .trim();
  // "is not over 10k" — the negation sits in front of a specific comparator.
  const localNegation = /\b(not|n't|never)\s*$/i.test(clean(rest.slice(0, comp.index))) && operator !== 'neq';
  const afterComp = rest.slice(comp.index + comp.length);

  const value = parseValue(afterComp);
  // The test ends where its value ends; everything after is the consequent.
  let consequent = '';
  if (value && value.raw && value.kind !== 'literal') {
    const vIdx = afterComp.toLowerCase().indexOf(value.raw.toLowerCase());
    consequent = vIdx >= 0 ? afterComp.slice(vIdx + value.raw.length) : '';
  } else {
    // A literal RHS has no clear boundary — take the first noun-ish token.
    const tok = /^\s*([\w$€£¥₹.'-]+)/.exec(afterComp);
    consequent = tok ? afterComp.slice(tok[0].length) : afterComp;
    if (value) value.raw = tok ? clean(tok[1]) : value.raw;
  }

  // "…is requested in Zendesk" leaves "in Zendesk" behind. That is trailing
  // detail about the test, not a step — emitting it would put a nameless
  // task.generic box in the middle of the diagram.
  let tail = clean(consequent);
  if (tail && !matchFrame(tail) && /^(in|to|for|with|at|on|by|from|of|into|via)\b/i.test(tail)) {
    tail = '';
  }

  return {
    test: {
      subjectRaw,
      operator,
      value,
      unresolved: false,
      raw: clean([subjectRaw, comp.pattern, value?.raw ?? ''].filter(Boolean).join(' '))
    },
    consequent: tail,
    negated: negated !== localNegation
  };
}

/* ------------------------------------------------------------------ */
/* clause parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * "When an invoice is received in Coupa, ..." is a start *trigger*, not a
 * decision gate. Detecting it keeps the compiler from emitting a gateway with
 * a branch that can never be false.
 */
const TRIGGER_RE = /\b(?:is|are|was|were|gets?|has\s+been|have\s+been)\s+(added|created|received|submitted|uploaded|signed|filed|posted|paid|approved|rejected|closed|opened|raised|logged|assigned|completed|updated|requested|initiated|cancelled|canceled|returned|flagged|escalated|denied|sent|delivered|shipped|booked|registered|placed|ordered|imported|synced|onboarded|opened|closed)\b|\b(arrives|comes\s+in|lands|is\s+due)\b/i;

function parseTrigger(clause) {
  const cue = findAny(clause, ['when', 'whenever', 'each time', 'every time', 'on receipt of', 'as soon as']);
  if (!cue || cue.index > 3) return null;
  const rest = clause.slice(cue.index + cue.length);
  const m = TRIGGER_RE.exec(rest);
  if (!m) return null;
  return {
    kind: 'trigger',
    text: clause,
    event: (m[1] || m[2] || 'received').toLowerCase().replace(/\s+/g, '-'),
    objects: matchEntities(rest, OBJECTS),
    connectors: matchEntities(rest, CONNECTORS),
    roles: matchEntities(rest, ROLES),
    precedence: false
  };
}

function parseAction(clause, ctx) {
  const frame = matchFrame(clause);
  const roles = matchEntities(clause, ROLES);
  const connectors = matchEntities(clause, CONNECTORS);
  const objects = matchEntities(clause, OBJECTS);
  const duration = parseDuration(clause);
  const usesPronoun = PRONOUNS.some(p => findPhrase(clause, p));

  // Pronoun resolution: fall back to the most recent object in the utterance.
  let object = objects[0] || null;
  let objectInherited = false;
  if (!object && usesPronoun && ctx.lastObject) {
    object = ctx.lastObject;
    objectInherited = true;
  }
  if (objects[0]) noteObject(ctx, objects[0]);

  return {
    kind: 'action',
    text: clause,
    frame: frame || { type: 'task.generic', label: 'Task', cue: null, at: 0, priority: 0 },
    frameMatched: Boolean(frame),
    roles,
    connectors,
    object,
    objectInherited,
    usesPronoun,
    duration,
    precedence: Boolean(findAny(clause, PRECEDENCE_CUES)),
    parallel: Boolean(findAny(clause, PARALLEL_CUES))
  };
}

/**
 * Parse one segmented clause into an IR node spec.
 * `ctx` carries state across clauses (last object seen, open conditional).
 */
export function parseClause(clause, ctx) {
  const elseCue = findAny(clause, ELSE_CUES);
  if (elseCue && elseCue.index <= 3) {
    const body = clean(clause.slice(elseCue.index + elseCue.length));
    const action = body ? parseAction(body, ctx) : null;
    return { kind: 'else', text: clause, action, precedence: false };
  }

  const trigger = parseTrigger(clause);
  if (trigger) {
    trigger.objects.forEach(o => noteObject(ctx, o));
    return trigger;
  }

  const cond = parseConditional(clause);
  if (cond) {
    const consequentText = cond.consequent;
    const action = consequentText ? parseAction(consequentText, ctx) : null;
    // "first" can sit in either half of the clause.
    const precedence = Boolean(findAny(clause, PRECEDENCE_CUES));
    return {
      kind: 'condition',
      text: clause,
      test: cond.test,
      negated: cond.negated,
      action,
      precedence,
      // Objects mentioned in the test still count for pronoun resolution.
      testObjects: matchEntities(clause, OBJECTS)
    };
  }

  return parseAction(clause, ctx);
}

/* ------------------------------------------------------------------ */
/* subject resolution                                                  */
/* ------------------------------------------------------------------ */

/**
 * Turn "it is over $10k" into a typed variable reference.
 * Returns {path, type, inferred, unresolved}.
 */
export function resolveSubject(subjectRaw, value, ctx) {
  const raw = clean(subjectRaw || '').replace(/^(the|a|an)\s+/i, '');
  const isPronoun = !raw || PRONOUNS.some(p => new RegExp('^' + escapeRe(p) + '$', 'i').test(raw));

  const objs = matchEntities(raw, OBJECTS);
  const isGenericAmount = GENERIC_AMOUNT_NOUNS.some(n => new RegExp('^' + n + '$', 'i').test(raw.replace(/^(the|its|their)\s+/i, '')));
  const borrows = isPronoun || (isGenericAmount && !objs.length);
  const obj = objs[0] || (borrows ? ctx.lastObject : null);

  // Borrowing the subject from earlier text is only safe when there is exactly
  // one candidate. Two objects in play means the sentence is genuinely
  // ambiguous, and the validator should ask rather than the parser guess.
  const seen = ctx.seenObjects || [];
  const ambiguous = borrows && seen.length > 1;
  const candidates = ambiguous ? seen.map(o => ({ id: o.id, name: o.name, path: o.amountField || `${o.id.replace('obj_', '')}.status` })) : undefined;

  if (obj) {
    if (value && (value.kind === 'money' || value.kind === 'number') && obj.amountField) {
      return { path: obj.amountField, type: value.kind === 'money' ? 'currency' : 'number', objectId: obj.id, inferred: borrows || !objs.length, unresolved: false, ambiguous, candidates, raw };
    }
    const field = value?.kind === 'duration' ? `${obj.id.replace('obj_', '')}.age`
      : `${obj.id.replace('obj_', '')}.${slugField(raw) || 'status'}`;
    return { path: field, type: value?.kind === 'duration' ? 'duration' : 'string', objectId: obj.id, inferred: borrows, unresolved: false, ambiguous, candidates, raw };
  }

  if (!raw) {
    return { path: 'UNRESOLVED', type: 'unknown', inferred: true, unresolved: true, raw: subjectRaw };
  }
  return { path: `context.${slugField(raw)}`, type: value?.kind === 'money' ? 'currency' : 'string', inferred: true, unresolved: false, raw };
}

function slugField(s) {
  return clean(s).toLowerCase()
    .replace(/\b(is|are|was|the|a|an|of|its|their)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean)
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

/* ------------------------------------------------------------------ */
/* top level                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a full utterance into an ordered list of clause specs, with
 * `first`-style precedence already applied.
 */
export function parse(utterance) {
  const clauses = segment(utterance);
  const ctx = { lastObject: null, seenObjects: [] };
  const specs = [];

  for (const c of clauses) {
    const spec = parseClause(c, ctx);
    if (spec.kind === 'condition') {
      // Register objects from the test so later pronouns resolve.
      spec.testObjects?.forEach(o => noteObject(ctx, o));
      spec.subject = resolveSubject(spec.test.subjectRaw, spec.test.value, ctx);
    }
    specs.push(spec);
  }

  return { utterance: clean(utterance), clauses, specs: applyPrecedence(attachDanglingConsequents(specs)) };
}

/**
 * "If X, do Y" gets comma-split into two clauses, leaving the conditional with
 * no consequent. Re-attach the following action as the true branch.
 */
export function attachDanglingConsequents(specs) {
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec.kind === 'condition' && !spec.action) {
      const next = specs[i + 1];
      if (next && next.kind === 'action') {
        spec.action = next;
        spec.precedence = spec.precedence || next.precedence;
        spec.consequentFromNextClause = true;
        i += 1;
      }
    }
    if (spec.kind === 'else' && !spec.action) {
      const next = specs[i + 1];
      if (next && next.kind === 'action') { spec.action = next; i += 1; }
    }
    out.push(spec);
  }
  return out;
}

/**
 * A clause carrying "first" must execute before the clause written before it.
 * "Send X, if over $10k get approval first" → the approval gate precedes the send.
 */
export function applyPrecedence(specs) {
  const out = specs.slice();
  for (let i = 1; i < out.length; i++) {
    if (!out[i].precedence) continue;
    const moved = out.splice(i, 1)[0];
    moved.hoistedFrom = i;
    // Hop back over the immediately preceding action clause.
    let target = i - 1;
    while (target > 0 && out[target].kind === 'else') target -= 1;
    out.splice(target, 0, moved);
  }
  return out;
}

export const __internals = { findPhrase, findAny, matchEntities, splitOnCoordinatingAnd, parseConditional, slugField };
