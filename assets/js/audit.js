/**
 * audit.js — hash-chained, append-only audit ledger.
 *
 * "Immutable" is a strong word, so here is exactly what is and is not claimed.
 *
 * WHAT THIS GIVES YOU: every entry commits to the hash of the entry before it.
 * Changing or removing any historical entry changes its hash, which breaks
 * every subsequent link, and `verify()` reports the first index where the chain
 * fails. There is no update or delete method on the ledger — the only mutation
 * is append.
 *
 * WHAT IT DOES NOT GIVE YOU: tamper-*proofing*. This ledger lives in the
 * browser tab. Anyone who can run JavaScript on the page can build a fresh
 * chain from scratch and it will verify. Real immutability needs the chain head
 * anchored somewhere the writer does not control — a WORM bucket, an append-only
 * database with no DELETE grant, or a notary service. That anchoring is out of
 * scope for this MVP and is called out in docs/limitations.md.
 */

const enc = new TextEncoder();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Stable stringify so the same object always hashes to the same value. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export const GENESIS = '0'.repeat(64);

export class AuditLedger {
  #entries = [];

  /** Append one event. Returns a frozen copy of the entry that was written. */
  async append({ event, actor = 'user', workflowId = null, subject = null, detail = {} }) {
    const prevHash = this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
    const payloadHash = await sha256Hex(canonicalize(detail));
    const entry = {
      seq: this.#entries.length + 1,
      timestamp: new Date().toISOString(),
      actor,
      event,
      workflowId,
      subject,
      detail,
      payloadHash,
      prevHash
    };
    entry.hash = await sha256Hex(canonicalize({
      seq: entry.seq, timestamp: entry.timestamp, actor: entry.actor,
      event: entry.event, workflowId: entry.workflowId, subject: entry.subject,
      payloadHash: entry.payloadHash, prevHash: entry.prevHash
    }));
    this.#entries.push(entry);
    return Object.freeze({ ...entry });
  }

  /** Read-only view. Callers get copies; there is no setter and no splice. */
  get entries() {
    return this.#entries.map(e => Object.freeze({ ...e }));
  }

  get head() {
    return this.#entries.length ? this.#entries[this.#entries.length - 1].hash : GENESIS;
  }

  get length() { return this.#entries.length; }

  /**
   * Recompute the whole chain.
   * @returns {{valid, checked, brokenAt, reason}}
   */
  async verify() {
    let prev = GENESIS;
    for (let i = 0; i < this.#entries.length; i++) {
      const e = this.#entries[i];
      if (e.prevHash !== prev) {
        return { valid: false, checked: i, brokenAt: e.seq, reason: `entry ${e.seq} points at ${e.prevHash.slice(0, 12)}…, expected ${prev.slice(0, 12)}…` };
      }
      const payloadHash = await sha256Hex(canonicalize(e.detail));
      if (payloadHash !== e.payloadHash) {
        return { valid: false, checked: i, brokenAt: e.seq, reason: `entry ${e.seq} payload does not match its recorded digest` };
      }
      const hash = await sha256Hex(canonicalize({
        seq: e.seq, timestamp: e.timestamp, actor: e.actor, event: e.event,
        workflowId: e.workflowId, subject: e.subject, payloadHash: e.payloadHash, prevHash: e.prevHash
      }));
      if (hash !== e.hash) {
        return { valid: false, checked: i, brokenAt: e.seq, reason: `entry ${e.seq} hash does not match its own contents` };
      }
      prev = e.hash;
    }
    return { valid: true, checked: this.#entries.length, brokenAt: null, reason: null };
  }

  /** Export in a shape an auditor can re-verify with any SHA-256 tool. */
  toJSON() {
    return {
      ledgerVersion: '1.0.0',
      algorithm: 'SHA-256',
      canonicalization: 'sorted-keys-json',
      genesis: GENESIS,
      head: this.head,
      entryCount: this.#entries.length,
      entries: this.entries
    };
  }

  /** Test hook: rebuild a ledger from exported entries WITHOUT rehashing. */
  static fromEntries(entries) {
    const l = new AuditLedger();
    entries.forEach(e => l.#entries.push({ ...e }));
    return l;
  }
}

export const AUDIT_EVENTS = {
  UTTERANCE_SUBMITTED: 'utterance.submitted',
  WORKFLOW_COMPILED: 'workflow.compiled',
  VALIDATION_RUN: 'validation.run',
  QUESTION_RAISED: 'clarification.raised',
  QUESTION_ANSWERED: 'clarification.answered',
  ANSWER_WITHDRAWN: 'clarification.withdrawn',
  SIMULATION_RUN: 'simulation.run',
  WORKFLOW_EXPORTED: 'workflow.exported',
  LEDGER_VERIFIED: 'ledger.verified'
};
