# Text2Workflow

**The Natural Language Process Orchestration Engine.** A business user types a
process in plain English; the engine compiles it into a validated,
schema-conformant orchestration pipeline, draws it as a swimlane blueprint, and
refuses to call it finished while anything important is still undefined.

```
Send the invoice to accounting, if it is over $10k get CFO approval first,
then log it in Snowflake
```

compiles — with the approval gate correctly hoisted *ahead* of the send, because
of the word "first" — into a 7-node graph across 3 swimlanes, and then asks five
questions the sentence never answered.

---

## The point of it

Turning English into a flowchart is the easy half. A language model can do it in
one shot.

The hard half is that a sentence a human finds perfectly clear is routinely
missing the three things a runtime needs: **what happens on the branch nobody
mentioned**, **who owns the step nobody named**, and **what unit the number was
in**. An engine that fills those in silently produces a workflow that looks
right and routes money wrongly.

Text2Workflow's position is that **an under-specified sentence should produce a
question, not a workflow.**

The flagship example is missing five things, and the engine says so rather than
guessing:

| It asks | Because |
|---|---|
| What happens when the invoice *isn't* over $10k? | The sentence never says. The compiler assumed "carry on" — an assumption that should be confirmed, not inherited. |
| What if the CFO rejects it? | As compiled, a rejection would fall through to the next step exactly like an approval. The control would do nothing. |
| Where should the decision be recorded? | The flow touches money and writes no audit record of its own decisions. |
| How long may the approval wait? | Otherwise it can sit in a queue indefinitely and nobody is told. |
| Can Snowflake tell a retry apart from a new write? | The engine already applies a retry policy and sends an idempotency key — but that only prevents a duplicate if Snowflake checks it. |

Answer all five and the status moves from **blocked** to **ready**.

## Try it

```bash
npm run serve
```

Then open <http://localhost:5190>. No build step, no dependencies, no network
calls — it is `index.html` plus ES modules.

```bash
npm test
```

138 tests, zero dependencies.

## Built for people who don't write code

Plain English is the default mode, not a simplified view of a technical one.

- **No syntax, anywhere.** When the engine can't parse a condition it offers
  one-click suggestions drawn from your own words ("if rejected" → *Invoice
  status is Rejected*), then three dropdowns in business language — *What should
  we look at?* → *How should we compare it?* → *To what?* — with a read-back line
  that restates your choice as a sentence. Raw field paths live behind a
  collapsed **Advanced** panel you never have to open.
- **Findings are written in English.** "What if the CFO says no?" rather than
  `R-NO-REJECT-PATH`. A toggle in the top bar swaps in the technical wording for
  whoever picks the work up afterwards; a test asserts the plain copy never
  leaks a rule id, node type or field path.
- **A Test run tab** walks a real case through the process — *a £6,000 invoice,
  and the manager rejects it* — and lights up the path it takes, step by
  numbered step, in sentences. Nothing is called, sent or created; it follows
  the arrows.

Full guide: [docs/for-non-technical-users.md](docs/for-non-technical-users.md).

## How it works

```
compile(parse(utterance), resolutions)  →  workflow
validate(workflow, resolutions)         →  findings + questions
```

Both are pure functions. The entire application state is two values — the
sentence and an object of answers — and everything on screen is derived from
them.

Answering a question adds a key to `resolutions` and **recompiles from the raw
sentence**. Nothing is ever patched in place. Three properties fall out of that:

1. **Undo is free** — withdraw an answer and the earlier workflow returns
   byte-identical (asserted by test).
2. **The output is fully explained** — sentence + the visible list of answers =
   the whole workflow. Nothing came from anywhere else.
3. **Answers are portable** — `resolutions` is serialised into the exported
   JSON, so replaying a compile elsewhere reproduces the same document.

### What the grammar handles

Deterministic, rule-based, no model in the loop. Same sentence, same answers,
same bytes out.

- Out-of-order precedence — *"get CFO approval **first**"* hoists the gate ahead
  of the clause written before it
- Pronoun binding — *"log **it** in Snowflake"* → the invoice, reported as an
  informational finding so you can check it
- Comparator specificity — *"it **is over** $10k"* reads as `>`, not `=` on the
  stray "is"
- Money with symbols, ISO codes and magnitudes — `$10k`, `2.5M EUR`, `25,000 USD`
- Triggers distinguished from decisions — *"**whenever** an invoice **is
  received**"* is a start event, not a gateway
- Explicit `otherwise` branches, negation (*"is **not** above 1M"*), durations
  including business days
- Genuine ambiguity detected rather than resolved: mention an invoice *and* a
  purchase order, then write *"the amount"*, and it asks

Anything it cannot resolve becomes an explicit `unresolved` marker. It is never
guessed at.

### Failure behaviour is compiled in, not just flagged

Every external call comes out of the compiler with a retry policy, a timeout, a
circuit breaker and an idempotency decision already attached — chosen from the
connector's category, reported explicitly, and overridable.

```
Snowflake   medium    4 attempts, waiting 1s and doubling up to 60s, with jitter, then dead-letter
                      stops calling after 8 failures in 120s, retries after 120s
                      Idempotency-Key: {{workflow.correlationId}}:n3
Stripe      critical  3 attempts, waiting 2s and doubling up to 30s, with jitter, then dead-letter
                      stops calling after 3 failures in 60s, retries after 300s
Slack       low       5 attempts, then alert
```

Critical systems get **fewer** attempts, not more: hammering a payment gateway
that is already failing turns one bad request into a thundering herd, and a
duplicate charge costs more than a human reading a dead-letter queue.

The engine will not decide one thing for you — whether the system on the other
end can actually tell a retry apart from a new request. Answer "no" and retries
are switched off for that step. "Not sure" is treated as no.

It also catches what happens *between* systems: two irreversible writes in one
run raise `R-PARTIAL-WRITE` — *"If Snowflake fails after NetSuite has already
been updated, what should happen?"* — offering a compensating action named for
the category (a reversing entry for ERP, a credit note for accounting, a refund
for payments), manual reconciliation, or an explicit decision to accept it.

Full table: [docs/resilience.md](docs/resilience.md).

### The 22 rules

Six passes over the compiled graph — structure, conditions, approvals,
connectors, governance, language. Blockers stop the workflow being called ready;
warnings are advice. Full table: [docs/validation-rules.md](docs/validation-rules.md).

### Seven export formats

| Format | What it is |
|---|---|
| **Input contract** | JSON Schema 2020-12 for the trigger payload. Every field a decision reads, all required, with the currency carried through. |
| **OpenAPI 3.1** | One path per connector call. Each operation carries an `x-resilience` block so the implementer knows what retry behaviour their endpoint must tolerate, a required `Idempotency-Key` header, and a documented `409`. |
| **Step Functions** | Amazon States Language. `Choice` states with typed comparators, and `Retry`/`Catch` blocks built from the compiled policy — the resilience declarations become executable configuration. |
| **Temporal** | TypeScript skeleton. One `proxyActivities` per distinct retry policy, with the real numbers; a signal per human step. |
| **Camunda BPMN 2.0** | `camunda:failedJobRetryTimeCycle`, external-task topics, candidate groups, and the timeout/idempotency/breaker as extension properties. |
| **Mermaid** | The Blueprint as text, for a ticket or a wiki. |
| **Markdown** | Step table plus every open finding. |

All seven derive from the same graph, and none is deployable as-is — each says
so in its own header. Details and mappings:
[docs/integration.md](docs/integration.md).

### Audit

SHA-256 hash-chained, append-only. Every entry commits to the hash of the one
before it; `Verify chain` re-hashes everything and names the first broken entry.
There is no update or delete method on the ledger.

It is **not tamper-proof** — it lives in a browser tab, and the UI says so on
the same screen. Real immutability needs the head anchored somewhere the writer
doesn't control. See [docs/limitations.md](docs/limitations.md#the-audit-ledger).

## What it does not do

Stated plainly because it is part of the deliverable:

- **It compiles; it does not execute.** No scheduler, no worker, no retry loop.
  `retry`, `circuitBreaker`, `timeoutSeconds` and `compensation` are
  declarations in the output document for a runtime that would consume it —
  which is exactly why the Step Functions, Temporal and Camunda exports exist.
- **No live connectors.** `status: "registered"` means a request contract is
  defined in this repo. No credential has ever been issued and no call has ever
  been made to Snowflake, SAP or anything else.
- **No accuracy figure and no confidence score.** Both would need a labelled
  gold set of workflows that experts agreed on. None exists, so neither number
  is claimed. The engine reports which checks passed instead.
- **No multi-agent reinforcement learning.** The research framing that inspired
  the project includes MARL for fault-tolerant orchestration; what is built here
  is a deterministic rule engine. The six validation passes are labelled like
  agents because they are independent single-responsibility modules — not
  because anything is learned. The execution log's timings are real
  `performance.now()` measurements, and a test asserts the log cannot claim more
  elapsed time than was measured.
- **Not a SaaS.** No auth, tenancy, persistence or billing.

Known grammar gaps (nested conditions, parallel branches, coordinated
consequents) are listed in [docs/limitations.md](docs/limitations.md#grammar-coverage).

## Documentation

| Document | What's in it |
|---|---|
| [for-non-technical-users.md](docs/for-non-technical-users.md) | How to use it without writing code |
| [prd.md](docs/prd.md) | Product requirements, personas, what is explicitly not built |
| [user-stories.md](docs/user-stories.md) | Three Jira-format stories, each acceptance criterion mapped to a named test |
| [schema-dictionary.md](docs/schema-dictionary.md) | Generated phrase → API-call mapping for the flagship example |
| [swimlane-blueprint.md](docs/swimlane-blueprint.md) | The translation pipeline and a compiled process, as diagrams |
| [validation-rules.md](docs/validation-rules.md) | All 22 rules, severities, and which ones ask questions |
| [resilience.md](docs/resilience.md) | Retry, circuit-breaker, idempotency and compensation defaults, and why each is what it is |
| [integration.md](docs/integration.md) | The seven export formats and how each maps onto its runtime |
| [architecture.md](docs/architecture.md) | Module layout, node id scheme, layout algorithm, security posture |
| [limitations.md](docs/limitations.md) | Everything above, in detail, with the reasoning |

Generated reference artefacts live in [docs/artifacts/](docs/artifacts/).

## Layout

```
index.html                  dual-pane workspace
assets/js/
  lexicon.js                DATA: roles, systems, objects, verb frames, field catalogue
  parser.js                 text → intermediate representation
  compiler.js               IR → workflow graph (pure)
  validator.js              graph → findings + questions, in two registers
  simulate.js               walk the graph with real values
  layout.js  render.js      swimlane geometry → inline SVG
  exporters.js              Mermaid · BPMN 2.0 · dictionary · Markdown
  audit.js                  hash-chained ledger
  trace.js                  measured execution log
  app.js                    the only module that touches the DOM
schema/workflow.v1.schema.json
tests/run.js                138 tests
```

## Provenance

Inspired by *From Words to Workflows: Automating Business Processes* and by work
on fault-tolerant enterprise orchestration. The failure modes it checks for —
unhandled branches, unowned approvals, missing audit trails, undefined retry
behaviour — come from that literature. The implementation is a deterministic
grammar and rule engine, and the README does not claim otherwise.
