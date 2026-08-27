# Failure behaviour

Every external call in a compiled workflow carries a retry policy, a timeout, a
circuit breaker and an idempotency decision — applied automatically, reported
explicitly, and overridable.

## Why defaults rather than a warning

The engine used to flag a missing retry policy and leave the step with none.
That is the wrong default. *No policy* means the first timeout silently drops a
record and the process carries on as though the write succeeded. A conservative
standard policy is strictly better than that, and unlike an SLA it is a
technical standard rather than a business decision.

So the compiler applies one, and the validator's job changes from *"you have
nothing"* to *"here is what we assumed — confirm it"*. The finding is `info`
severity: it does not block, but it is visible, it names the exact numbers, and
it carries a question to change them.

The one thing the engine will not decide for you is whether the system on the
other end can tell a retry apart from a new request. That is `R-DEDUP-UNVERIFIED`,
and it is a warning.

## What determines the policy

The safe policy depends on **whether the call can be repeated**, which depends
on what kind of system it is and what the operation does.

```
operation name  ──▶  read / query / fetch      ──▶ always idempotent
                ──▶  upsert / update / put     ──▶ idempotent (replaces state)
                ──▶  insert / create / post    ──▶ category decides
                                                    │
connector category ─────────────────────────────────┘
                ──▶ payments, erp, accounting, p2p  ──▶ not repeatable, key required
                ──▶ warehouse, esign, itsm          ──▶ not repeatable, key required
                ──▶ crm, hcm, storage               ──▶ repeatable
                ──▶ messaging, email                ──▶ not repeatable, low harm
```

## Retry defaults

Keyed on **criticality**, which is about blast radius rather than importance.

| Criticality | Categories | Attempts | Backoff | Cap | On exhaustion |
|---|---|---|---|---|---|
| critical | payments | 3 | 2s, ×2, full jitter | 30s | dead-letter |
| high | erp, accounting, p2p, hcm | 4 | 2s, ×2, full jitter | 60s | dead-letter |
| medium | warehouse, crm, storage, esign | 4 | 1s, ×2, full jitter | 60s | dead-letter |
| low | itsm, messaging, email | 5 | 1s, ×1.5, full jitter | 30s | alert |

**Critical systems get fewer attempts, not more.** Hammering a payment gateway
that is already failing turns one bad request into a thundering herd, and the
cost of a duplicate charge is far higher than the cost of a human looking at a
dead-lettered message. Jitter is on everywhere so a fleet of workers does not
retry in lockstep.

## Circuit breakers

The breaker exists so a system that is down stops being asked.

| Criticality | Trips after | Window | Stays open | Half-open probes |
|---|---|---|---|---|
| critical | 3 failures | 60s | 300s | 1 |
| high | 5 failures | 60s | 180s | 1 |
| medium | 8 failures | 120s | 120s | 2 |
| low | 12 failures | 300s | 60s | 2 |

`onOpen` is `hold-and-alert` everywhere except low-criticality categories, where
it is `skip-and-alert` — a Slack message that never sends should not hold up an
invoice.

## Idempotency

Where repeating a call is unsafe, the compiler adds a key to the request:

```json
"payload": {
  "objectType": "invoice",
  "amount": "{{invoice.amount}}",
  "correlationId": "{{workflow.correlationId}}",
  "idempotencyKey": "{{workflow.correlationId}}:n3"
}
```

Stable across retries of that step, unique across runs. It is sent as
`Idempotency-Key`, and the generated OpenAPI marks that header **required** with
a description saying the implementation MUST deduplicate on it.

**This only works if the target actually checks it**, and plenty of internal
services do not. `R-DEDUP-UNVERIFIED` asks:

| Answer | Effect |
|---|---|
| Yes — it ignores a repeat with the same key | Retries stay on |
| No — a repeat would create a second record | **Retries switched off**: one attempt, then alert |
| Not sure | Treated as *no* |

"Not sure" is deliberately conservative. Optimism here charges someone twice.

## Partial writes across systems

`R-PARTIAL-WRITE` fires when a run contains two or more irreversible writes:

> This process writes to both NetSuite and Snowflake. If the second one fails
> after the first has already worked, you're left with the record in one place
> and not the other, and nothing puts that right on its own.

Three answers, all recorded on the affected steps:

- **Undo the earlier write** — a compensating action, named per category
  (`reversing entry` for ERP, `credit note` for accounting, `refund` for
  payments, `delete by key` for a warehouse).
- **Alert someone to reconcile** — manual reconciliation, declared rather than
  assumed.
- **Accept it** — the systems reconcile separately. A legitimate answer, and
  recording it is the point.

## Approval deadlines

A default deadline is applied so the blueprint is never silent about time:

| Seniority | Default | On breach |
|---|---|---|
| exec | 1 business day | escalate |
| senior / mid | 2 business days | escalate |
| team | 3 business days | escalate |
| individual / external | 5 business days | alert |

**Unlike the retry defaults this one is a guess at policy, not a standard**, so
`R-NO-SLA` remains a *warning* rather than an info: "We put a 1-day deadline on
this — is that right?" The number exists so nothing sits in a queue forever, not
because the engine knows your escalation rules.

## Where the declarations end up

| Export | What carries across |
|---|---|
| **Step Functions** | `Retry` blocks with `IntervalSeconds`, `MaxAttempts`, `BackoffRate`, `JitterStrategy`; `TimeoutSeconds`; `Catch` to a named failure state; the idempotency key as a request header |
| **Temporal** | `proxyActivities` with a real `RetryPolicy` — `maximumAttempts`, `initialInterval`, `backoffCoefficient`, `maximumInterval`; one proxy per distinct policy |
| **Camunda BPMN** | `camunda:failedJobRetryTimeCycle="R3/PT1S"`, `camunda:asyncBefore`, and the timeout, idempotency key and breaker thresholds as `camunda:property` entries |
| **OpenAPI** | An `x-resilience` block per operation, so the implementer knows what retry behaviour their endpoint must tolerate, plus a required `Idempotency-Key` parameter and a documented `409` response |

## The limit of all this

Nothing here executes. `retry`, `circuitBreaker`, `timeoutSeconds` and
`compensation` are **declarations in the output document** describing what a
runtime should do. This repository contains no scheduler, no worker and no
retry loop, and no call has ever been made to any of these systems. See
[limitations.md](limitations.md#the-engine-compiles-it-does-not-execute).
