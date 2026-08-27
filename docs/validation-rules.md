# Validation rules

The self-reflection pass runs **six checks** containing **22 rules** over the
compiled graph. Running over the graph rather than the sentence is deliberate:
it lets the same pass catch a dangling edge and a missing currency.

Severity means exactly one thing:

| Severity | Meaning |
|---|---|
| **blocker** | The workflow cannot be described as ready. A runtime consuming it would behave in a way nobody specified. |
| **warning** | Advisory. A human should look. Some warnings have no answerable question and survive the loop by design. |
| **info** | The engine inferred something reasonable and is telling you what it did. |

A rule that carries a `question` participates in the clarification loop: answer
it, and the workflow is recompiled from the raw sentence with the answer
applied. A rule without a question is a judgement for a human.

---

## Check 1 — structure
*"Graph is connected and every path terminates."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-ORPHAN` | blocker | A node exists that no path from the trigger reaches. | no |
| `R-DEADEND` | blocker | A non-terminal node has no outgoing edge — the process would stop with no completion state. | no |
| `R-GATEWAY-ARITY` | blocker | An exclusive decision has fewer than two outgoing paths. A decision with one outcome is not a decision. | no |

These are graph invariants. They should never fire on compiler output; they
exist to catch compiler bugs and hand-edited JSON. The test suite corrupts a
valid graph three ways to prove each one fires.

## Check 2 — conditions
*"Every decision is evaluable and both branches are defined."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-PREDICATE` | blocker | The grammar found no field/operator/value it could evaluate — e.g. *"if a payment looks significant"*. | yes — free-form field/operator/value |
| `R-CURRENCY` | blocker | A monetary threshold carries no ISO 4217 currency. Fires on `over 1M`, stays silent on `over 5`. | yes — USD/EUR/GBP/JPY/INR |
| `R-SUBJECT-INFERRED` | blocker / info | A test subject was carried over from earlier text. **Blocker** when more than one record is in scope, **info** when only one. | yes, when ambiguous |
| `R-ELSE` | blocker | A decision's negative branch was never stated. | yes — continue or stop |
| `R-THRESHOLD-CONFLICT` | warning | The same field is tested with different comparisons — overlapping approval bands. | **no** |

`R-CURRENCY`'s narrowness is the point. `"over 1M"` almost certainly means money
with the unit dropped; `"over 5"` almost certainly means a count. The rule keys
off a magnitude suffix or a subject that resolves to a known amount field, so it
asks where a mistake would mis-route an approval and stays quiet elsewhere.

`R-THRESHOLD-CONFLICT` deliberately has no question. Two overlapping bands might
be a bug or might be exactly the policy; the engine cannot tell, so it reports
and lets a human decide. It is the reason a workflow can legitimately finish the
loop at `needs-review` rather than `ready`.

## Check 3 — approvals
*"Every approval has an owner, an outcome and a deadline."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-UNASSIGNED` | blocker | An approval or review names no performer. | yes — pick a role |
| `R-NO-REJECT-PATH` | blocker | An approval models only the approved outcome. | yes — end / return for revision / escalate |
| `R-NO-SLA` | warning | An approval has no deadline or escalation target. | yes — 4h / 1d / 3d / none |

`R-NO-REJECT-PATH` is the highest-value rule in the set. "Get CFO approval" has
two real-world outcomes, but the sentence describes one. Compiled naively, a
rejection falls through to the next step *exactly like an approval* — the
control is decorative. Answering the question materialises an outcome gateway
and, for the "return" answer, a genuine loop edge back to the approval.

## Check 4 — connectors
*"Every data step names a system and a failure policy."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-NO-CONNECTOR` | blocker | A read/write/create step names no system of record — there is no endpoint to generate. | yes — pick a connector |
| `R-NO-RETRY` | warning | An external write has no defined behaviour on failure. | yes — 3× backoff / 5× + alert / fail fast |

### Resilience rules

Since every external call now compiles with a failure policy attached, these
rules report and challenge that policy rather than reporting its absence. See
[resilience.md](resilience.md) for the defaults themselves.

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-RETRY-DEFAULTED` | info | A policy was applied from the standard profile for the connector category. Names the exact numbers. | yes — keep / try harder / never retry |
| `R-DEDUP-UNVERIFIED` | warning | Retries are on for a non-idempotent write, and nobody has confirmed the target deduplicates on the idempotency key. | yes — yes / no / not sure |
| `R-RETRIES-DISABLED` | info | Retries were switched off because the target cannot deduplicate. Confirms the consequence. | no |
| `R-PARTIAL-WRITE` | warning | Two or more irreversible writes in one run with no compensation, so a late failure leaves one system updated and the other not. | yes — reverse / reconcile / accept |

`R-RETRY-DEFAULTED` is `info` on purpose: a sensible default should not block a
workflow, but it must not be invisible either. It appears in the clarification
queue under a collapsed *"settings we filled in for you"* section rather than
alongside the blockers.

`R-DEDUP-UNVERIFIED` is the one thing the engine refuses to decide. Answering
*"no"* rewrites the policy to a single attempt — the engine will not knowingly
emit a configuration that creates duplicates.

## Check 5 — governance
*"Regulated data is logged and does not leak."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-AUDIT` | blocker | The flow is in regulatory scope but writes no audit record of its own decisions. | yes — ledger only / + Snowflake / + ERP table |
| `R-PII-EGRESS` | warning | A record classified as PII is pushed to a messaging or email connector, outside the retention controls that cover the system of record. | no |

## Check 6 — language
*"No unquantified language survived into the workflow."*

| Rule | Severity | Fires when | Asks? |
|---|---|---|---|
| `R-VAGUE` | warning | Words with no machine equivalent survived into step names — "significant", "appropriate", "quickly", "as needed". | no |
| `R-PRONOUN` | info | A pronoun was bound to the nearest preceding object. Reports what it bound to. | no |

---

## Loop invariants (asserted by test)

- **Progress.** The same question id is never asked twice in one loop.
- **Reversibility.** Removing an answer key restores the byte-identical earlier
  workflow.
- **Stability.** Answering a question inserts nodes but never renumbers existing
  ones, so the keys other answers are stored under stay valid.
- **Termination.** Every sample converges with zero blockers; any surviving
  warning is one with no answerable question.
