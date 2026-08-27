# Limitations

What this engine does not do, and why each gap is where it is. Nothing here is
a roadmap item dressed up as a caveat — these are the boundaries of what has
actually been built and verified.

---

## No accuracy number

There is no published figure for how often the parser produces the workflow the
author intended, and there will not be one until a gold set exists.

Producing an honest number requires: a corpus of process descriptions written by
real operations staff (not by the person who wrote the grammar), each one
independently converted to a workflow by two or more analysts, disagreements
adjudicated, and the engine scored against that. Roughly 300–500 sentences
spanning finance, HR, ITSM and procurement would be the minimum for anything
per-category to be meaningful. None of that has been done.

What can be said, and is: the grammar is deterministic, the test suite pins 72
specific behaviours, and every sample in the app converges to a clean state.
That is a statement about consistency, not about correctness.

## No confidence score

Related but distinct. The UI reports *which checks passed and which did not*,
never a percentage likelihood that the workflow is right.

A confidence score would need to be calibrated — when the engine says 85%, it
should be right 85% of the time — and calibration needs the same gold set that
does not exist. An uncalibrated number is worse than no number, because a
reviewer will trust it. The `validate()` return value is asserted by test to
contain no confidence field.

## The audit ledger

**What it gives you.** Each entry commits to the SHA-256 hash of the entry
before it, over a canonical (sorted-key) serialisation. Editing, deleting or
reordering any historical entry breaks every subsequent link, and `verify()`
reports the first index where the chain fails. The class exposes `append` and a
copying `entries` getter — there is no update, delete or splice method, and
handed-out entries are frozen copies.

**What it does not give you.** Tamper-*proofing*. The ledger lives in a browser
tab. Anyone who can run JavaScript on the page can construct a fresh chain from
scratch, and it will verify cleanly, because nothing external witnesses the
chain head.

Real immutability requires anchoring the head somewhere the writer does not
control:

- a WORM object-lock bucket, head written once per run;
- an append-only table with `DELETE` and `UPDATE` not granted to the app role;
- a notary or transparency-log service that counter-signs the head.

Any of the three is a few days of work and none of them is in this MVP. The
disclosure is printed on the Audit tab, not buried here.

## Connector status means "contract defined", not "integration built"

A connector marked `"status": "registered"` has a request contract declared in
[`lexicon.js`](../assets/js/lexicon.js) and emits a typed endpoint and payload in
the compiled output. That is all it means.

No credential has ever been issued. No HTTP request has ever been made to
Snowflake, SAP, NetSuite, Workday or anything else. The payloads use
mustache-style bindings (`{{invoice.amount}}`) that assume a runtime which does
not exist here. Treat the connector list as an interface specification a
platform team would implement against, not as a working integration catalogue.

## The engine compiles; it does not execute

There is no scheduler, worker, queue or state machine. `sla`, `retry`,
`circuitBreaker`, `timeoutSeconds` and `compensation` are **declarations in the
output document** describing what a runtime should do. Nothing in this
repository retries anything, opens a circuit, or compensates a write.

This is why the Step Functions, Temporal and Camunda exports exist: they hand
those declarations to something that can honour them.

## The runtime exports are specifications, not deployments

None of the seven export formats produces a deployable artefact, and each says
so in its own header rather than only here:

- **Step Functions** carries placeholder ARNs (`${ConnectorBaseUrl}`,
  `${EventBridgeConnectionArn}`, `${HumanTaskFunctionArn}`). The definition has
  never been submitted to AWS, validated by the service, or executed. Its
  structure is checked by tests — every transition resolves, no state is
  non-terminal without a way out — but structural validity is not the same as
  AWS accepting it.
- **Temporal** is a skeleton whose activity implementations in `./activities`
  do not exist. It has never been run against a cluster. The retry policies in
  it are real; the workflow body is a readable approximation of the graph, not
  a faithful interpreter — a deeply nested process will need editing.
- **OpenAPI** describes an interface nobody has implemented. No credential has
  been issued and no request has been made against any path in it.
- **Camunda BPMN** has no `BPMNDiagram` coordinates and is
  `isExecutable="false"`.

## The resilience defaults are conventions, not measurements

The retry counts, backoff coefficients and breaker thresholds in
[resilience.md](resilience.md) are conventional values chosen by category. They
have not been tuned against observed failure rates for any specific system,
because no such telemetry exists here. They are a defensible starting point that
is strictly better than no policy, not an optimum.

Two specific limits:

- **Category is a coarse proxy.** Two systems in the same category can have very
  different rate limits and recovery characteristics.
- **The idempotency key is emitted, not verified.** The engine cannot check
  whether a target deduplicates on it, which is exactly why
  `R-DEDUP-UNVERIFIED` asks a human instead of assuming.

## The simulator walks the graph; it does not run the process

The Test run tab follows the edges of the compiled graph using the values you
type, and narrates what it passes. It is honest about the workflow *as drawn*
and says nothing about the real world:

- No connector is called, no message is sent, no record is created.
- Timing is not modelled. An SLA of one business day is reported as text on the
  step; the walk does not wait, and cannot tell you whether a deadline would be
  breached in practice.
- Retries are not exercised. A step declaring three attempts is walked once.
- Only one case runs at a time. There is no batch mode, no distribution over
  inputs, and no coverage report saying which branches you have not yet tried.
- A rework loop is cut off after a few laps, because the simulator has no way to
  model the requester changing something before resubmitting.

## Regulatory scope detection is a keyword prompt, not a legal determination

`governance.regulatoryScope` is populated by matching terms like "salary",
"cardholder" and "journal entry" against a small list, plus flags on the object
types in play. It will miss regulated processes that use vocabulary outside that
list, and it will over-flag processes that mention a term in passing.

Its purpose is to make a human look, not to answer the question. A workflow
marked `SOX` has not been assessed for SOX compliance by anything.

## Grammar coverage

Known constructs the parser does **not** handle correctly:

- **Nested conditions.** `"if A, then if B do X"` compiles as two sequential
  gateways rather than one nested inside the other. The resulting graph is
  well-formed but the logic is flatter than the sentence.
- **Scope of a coordinated consequent.** In `"if X, do Y and do Z"`, only Y is
  placed on the true branch; Z lands after the merge. The engine does not
  currently ask about this, and it should.
- **Parallel branches.** `PARALLEL_CUES` ("at the same time", "in parallel") are
  recognised on a clause but the compiler still emits sequential edges — there
  is no `gateway.parallel` in any compiled output yet.
- **Loops other than approval rework.** "repeat until", "for each line item" are
  not modelled.
- **Multi-sentence input.** Everything is treated as one process. Two unrelated
  processes in one box will be fused into one graph.
- **Anything not in English.**

## Pronoun binding is proximity, not understanding

`"log it in Snowflake"` binds "it" to the most recent business object mentioned.
When exactly one object is in play this is nearly always right; when two are, the
engine detects the ambiguity and asks (`R-SUBJECT-INFERRED` at blocker
severity). When *zero* are in play it silently falls back to a `context.*` field.
Every proximity binding is reported as an informational finding so a reviewer can
check it.

## The BPMN export is a modelling handoff

It carries the process, lanes, flow nodes and sequence flows — enough for
Camunda Modeler or bpmn.io to open and auto-layout. It contains no
`BPMNDiagram` / `BPMNShape` visual coordinates and is marked
`isExecutable="false"`. It is not a deployable process archive and must not be
described as one.

## Not a SaaS

No authentication, no tenancy, no persistence, no billing. Reloading the page
discards the audit ledger. It is a single-page engine that runs entirely in the
browser — which is also its main security property: nothing typed into it is
transmitted anywhere.
