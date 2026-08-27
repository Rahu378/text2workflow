/**
 * resilience.js — default failure behaviour for every external call.
 *
 * The engine used to flag a missing retry policy and leave the step with none.
 * That is the wrong default: *no policy* means an outage silently drops a
 * record, which is worse than a conservative standard policy. So the compiler
 * now attaches one, and the validator's job changes from "you have nothing"
 * to "here is what we assumed — confirm it".
 *
 * Everything emitted here is a **declaration in the output document**. This
 * repository contains no runtime that executes a retry. See
 * docs/limitations.md.
 */

import {
  CATEGORY_PROFILE, DEFAULT_PROFILE, RETRY_DEFAULTS, BREAKER_DEFAULTS, SLA_DEFAULTS
} from './lexicon.js';

/** Operations that only read. Safe to repeat regardless of the category. */
const READ_OPERATIONS = /(query|read|get|fetch|list|search|lookup)/i;

/** Operations that replace state wholesale rather than appending to it. */
const UPSERT_OPERATIONS = /(upsert|update|put|set|replace)/i;

/**
 * Work out whether one connector call can safely be repeated.
 * @returns {{idempotent, requiresIdempotencyKey, reason}}
 */
export function safetyOf(connectorEntry, operation) {
  const profile = CATEGORY_PROFILE[connectorEntry?.category] || DEFAULT_PROFILE;

  if (READ_OPERATIONS.test(operation)) {
    return { ...profile, idempotent: true, requiresIdempotencyKey: false, reason: 'read-only call' };
  }
  if (UPSERT_OPERATIONS.test(operation)) {
    return { ...profile, idempotent: true, requiresIdempotencyKey: false, reason: 'replaces state rather than appending' };
  }
  return {
    ...profile,
    reason: profile.idempotent
      ? `${connectorEntry?.category || 'unknown'} writes are safe to repeat`
      : `a repeated ${connectorEntry?.category || 'external'} write creates a second record`
  };
}

/**
 * The full policy for one step.
 *
 * @param {object} connectorEntry lexicon CONNECTORS entry (may be undefined)
 * @param {string} operation      e.g. 'record.insert'
 * @param {string} nodeId         used to build a stable idempotency key
 * @param {object} override       an answered clarification, if any
 */
export function policyFor(connectorEntry, operation, nodeId, override = null) {
  const safety = safetyOf(connectorEntry, operation);
  const base = RETRY_DEFAULTS[safety.criticality] || RETRY_DEFAULTS.medium;
  const breaker = BREAKER_DEFAULTS[safety.criticality] || BREAKER_DEFAULTS.medium;

  // "This system cannot deduplicate" is the one answer that must disable
  // retries outright — otherwise the policy would knowingly create duplicates.
  const dedupe = override?.dedupe;
  const retriesUnsafe = dedupe === 'no' || dedupe === 'unknown';

  const retry = override && override.maxAttempts != null
    ? {
      maxAttempts: override.maxAttempts,
      backoff: override.backoff || base.backoff,
      initialIntervalSeconds: override.initialIntervalSeconds ?? base.initialIntervalSeconds,
      backoffCoefficient: override.backoffCoefficient ?? base.backoffCoefficient,
      maxIntervalSeconds: override.maxIntervalSeconds ?? base.maxIntervalSeconds,
      jitter: override.jitter ?? base.jitter,
      onExhausted: override.onExhausted || base.onExhausted,
      source: 'clarified'
    }
    : retriesUnsafe
      ? {
        maxAttempts: 1,
        backoff: 'none',
        initialIntervalSeconds: 0,
        backoffCoefficient: 1,
        maxIntervalSeconds: 0,
        jitter: 'none',
        onExhausted: 'alert',
        source: 'clarified',
        note: 'Retries disabled: the target system was reported as unable to deduplicate a repeated request.'
      }
      : { ...base, source: 'default' };

  const needsKey = safety.requiresIdempotencyKey && retry.maxAttempts > 1;

  return {
    timeoutSeconds: override?.timeoutSeconds ?? safety.timeoutSeconds,
    retry,
    circuitBreaker: {
      ...breaker,
      onOpen: safety.criticality === 'low' ? 'skip-and-alert' : 'hold-and-alert',
      source: override?.circuitBreaker ? 'clarified' : 'default'
    },
    idempotency: {
      operationIsIdempotent: safety.idempotent,
      keyRequired: needsKey,
      // Stable across retries of the same step, unique across runs.
      key: needsKey ? `{{workflow.correlationId}}:${nodeId}` : null,
      header: needsKey ? 'Idempotency-Key' : null,
      targetSupportsDeduplication: dedupe === 'yes' ? true : dedupe ? false : null,
      reason: safety.reason
    },
    compensation: {
      reversible: safety.reversible,
      action: safety.reversal,
      // Only becomes a concrete step when the partial-write question is answered.
      configured: Boolean(override?.compensate),
      strategy: override?.compensate || null
    },
    criticality: safety.criticality
  };
}

/** Default deadline for a human step, keyed off the role's seniority. */
export function slaFor(role) {
  const d = SLA_DEFAULTS[role?.seniority] || SLA_DEFAULTS.team;
  return {
    durationSeconds: d.seconds,
    businessDays: d.businessDays,
    onBreach: d.onBreach,
    escalateTo: null,
    source: 'default'
  };
}

/** "3 attempts, doubling from 2s, up to 30s, with full jitter" */
export function describeRetry(retry) {
  if (!retry) return 'no policy';
  if (retry.maxAttempts <= 1) return 'no retries — one attempt only';
  const shape = retry.backoff === 'exponential'
    ? `waiting ${retry.initialIntervalSeconds}s and doubling up to ${retry.maxIntervalSeconds}s`
    : retry.backoff === 'linear'
      ? `waiting ${retry.initialIntervalSeconds}s between attempts`
      : 'with no wait between attempts';
  const jitter = retry.jitter && retry.jitter !== 'none' ? ', with jitter' : '';
  return `${retry.maxAttempts} attempts, ${shape}${jitter}, then ${String(retry.onExhausted).replace('-', ' ')}`;
}

export function describeBreaker(cb) {
  if (!cb) return 'no circuit breaker';
  return `stops calling after ${cb.failureThreshold} failures in ${cb.samplingWindowSeconds}s, retries after ${cb.openSeconds}s`;
}

/** ISO 8601 repeating interval, the form Camunda's retry cycle expects. */
export function toRetryCycle(retry) {
  if (!retry || retry.maxAttempts <= 1) return 'R0/PT0S';
  return `R${retry.maxAttempts - 1}/PT${retry.initialIntervalSeconds}S`;
}
