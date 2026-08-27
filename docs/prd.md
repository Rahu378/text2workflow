# Text2Workflow — Product Requirements Document

**Status:** MVP built and running. Every functional requirement below is
implemented; the "Not built" section at the end is as load-bearing as the rest.

---

## 1. Product vision

Democratise business process automation by translating unstructured natural
language instructions into structured workflow automation — and, crucially, by
refusing to guess when the instruction is under-specified.

The second half is the product. Turning English into a flowchart is the easy
part; a language model can do it in one shot. The hard part is that a sentence
a human finds perfectly clear is routinely missing the three things a runtime
needs: what happens on the branch nobody mentioned, who owns the step nobody
named, and what unit the number was in. An engine that fills those in silently
produces a workflow that looks correct and routes money wrongly.

Text2Workflow's position: **an under-specified sentence should produce a
question, not a workflow.**

## 2. Target personas

| Persona | What they bring | What they need from this |
|---|---|---|
| **Business Operations Manager** | Knows the policy. Cannot write BPMN, cannot read JSON. | To state the policy in their own words and get something engineering can implement without a two-week discovery cycle. |
| **Systems Integration BA** | Knows the systems and the field names. | A mapping table that says exactly which phrase became which API call, so the handoff to engineering is a document rather than a meeting. |
| **Enterprise Architect** | Owns the failure modes. | Evidence that retries, SLAs, escalations, and audit are modelled — and a diff-able artefact under version control. |
| **Compliance Officer** *(secondary)* | Owns the regulatory exposure. | A flow that cannot pass review while it is missing an audit trail or a rejection path. |

## 3. Functional requirements

### FR-1 · Natural language ingestion
A text interface that handles complex conditional commands, including
out-of-order logic.

**Implemented.** [`parser.js`](../assets/js/parser.js) is a deterministic
grammar: segmentation → verb-frame classification → entity extraction →
condition parsing → precedence resolution. It handles:

- conditional clauses (`if`, `when`, `unless`, `whenever`, `provided that`)
- explicit negative branches (`otherwise`, `else`, `failing that`)
- **out-of-order precedence** — `"…get CFO approval first"` hoists the approval
  gate ahead of the clause written before it
- pronoun binding (`"log **it** in Snowflake"` → the invoice)
- comparator specificity — `"it **is over** $10k"` reads as `>`, not `=` on the
  stray "is"
- money with symbols, ISO codes and magnitudes (`$10k`, `2.5M EUR`, `25,000 USD`)
- durations including business days (`within 3 business days`)
- start triggers distinguished from decisions (`"when an invoice **is
  received**"` is an event, not a gateway)

Anything the grammar cannot resolve is emitted as an explicit `unresolved`
marker. It is never guessed at.

### FR-2 · JSON schema translation (Process2JSON)
An orchestration engine that parses intent into structured logic flows.

**Implemented.** [`compiler.js`](../assets/js/compiler.js) emits a graph
conforming to [`schema/workflow.v1.schema.json`](../schema/workflow.v1.schema.json):
participants (swimlanes), connectors with typed operations, runtime variables,
nodes, edges with guards, and a governance block.

The compiler is **pure**. `compile(parsed, resolutions)` is a function of its
arguments with no hidden state, which is what makes the clarification loop
reviewable — see FR-3.

### FR-3 · Self-reflection loop
Autonomous validation that screens for logical fallacies and missing
connections, and loops back with clarifying questions.

**Implemented.** [`validator.js`](../assets/js/validator.js) runs six passes and
17 rules over the *compiled graph* — not over the sentence — so it catches
structural defects as well as semantic gaps. See
[validation-rules.md](validation-rules.md).

The loop works by recompilation, not by patching:

```
answer a question  →  add a key to `resolutions`  →  recompile from the raw sentence
```

Nothing is ever edited in place. Withdrawing an answer is deleting the key, and
the test suite asserts that doing so restores the byte-identical earlier
workflow. The consequence for a reviewer: the compiled workflow is **completely
explained** by the original sentence plus the visible list of answers.

### FR-4 · No-code interaction layer
Non-technical users must never be required to write or read code-like logic.

**Implemented.** Plain English is the default register, not a simplified view of
a technical one:

- **Visual condition builder.** Where the grammar fails, the user gets one-click
  suggestions inferred from their own words ("if rejected" → *Invoice status is
  Rejected*), then three dropdowns in business language — *What should we look
  at?* → *How should we compare it?* → *To what?* — with a read-back line
  restating the choice as a sentence. Field paths live behind a collapsed
  **Advanced** panel. Fields for records mentioned in the sentence are grouped
  first.
- **Two registers for every finding.** Each rule carries both technical and
  plain copy: *"What if the CFO says no?"* rather than `R-NO-REJECT-PATH`. A
  test asserts the plain copy never leaks a rule id, node type or field path.
- **Context-aware option ordering.** Roles and systems already in the process
  are offered first, labelled "already in this process".

### FR-5 · Walk-through simulation
A user must be able to test the workflow with real values rather than reasoning
about it abstractly.

**Implemented.** [`simulate.js`](../assets/js/simulate.js) derives the input form
from the graph (one input per decision the workflow actually makes), walks the
edges with the supplied values, and returns a numbered step list narrated in
plain sentences. The path taken is highlighted and numbered in the blueprint;
everything else is dimmed. Rework loops are detected and explained rather than
spun forever.

It is a graph walk, not an execution: no connector is contacted at any point.

### FR-6 · Audit logging
An immutable, read-only tracking system for security, compliance and governance.

**Implemented with a stated limit.** [`audit.js`](../assets/js/audit.js) is a
SHA-256 hash-chained, append-only ledger. Every entry commits to the hash of the
one before it; `verify()` re-hashes the whole chain and names the first broken
entry. There is no update or delete method.

It is **not tamper-proof**, and the UI says so on the same screen. See
[limitations.md](limitations.md#the-audit-ledger).

## 4. Non-functional requirements

| ID | Requirement | Status |
|---|---|---|
| NFR-1 | Deterministic output — same sentence, same answers, same JSON | Enforced by test |
| NFR-2 | No network calls; nothing typed leaves the browser | Enforced by architecture — zero fetch/XHR in the codebase |
| NFR-3 | No build step; deployable as static files | `index.html` + ES modules |
| NFR-4 | Every node traceable to a clause, a clarification, or graph structure | Enforced by test |
| NFR-5 | Full pipeline under 50 ms for a typical sentence | Measured live in the execution log (~2–6 ms observed) |
| NFR-6 | Keyboard-operable; number keys answer the top question | Implemented |
| NFR-7 | Plain-English copy contains no rule ids, node types or field paths | Enforced by test |
| NFR-8 | Simulation never mutates the workflow it walks | Enforced by test |

## 5. Explicitly not built

Stating this plainly is part of the deliverable.

- **No execution.** Text2Workflow compiles and validates a workflow. It does not
  run one. There is no scheduler, no worker, no state machine, no retry
  execution — `retry` and `sla` are *declarations in the output document* for a
  runtime that would consume it.
- **No live connectors.** `status: "registered"` on a connector means a request
  contract is defined in this repository. No credential has ever been issued and
  no call has ever been made to Snowflake, SAP or anything else.
- **No accuracy claim.** There is no measured figure for how often the parse
  matches what the author meant, because no labelled gold set exists. See
  [limitations.md](limitations.md#no-accuracy-number).
- **No multi-agent reinforcement learning.** The research framing that inspired
  this project includes MARL for fault-tolerant orchestration. What is built
  here is a deterministic rule engine. The six validation passes are labelled
  like agents because they are independent single-responsibility modules — not
  because anything is learned.
- **No persistence, tenancy, auth or billing.** Not a SaaS. A single-page
  engine.
- **The simulator does not execute anything.** It follows the arrows with the
  values you type. It sends no message, writes no record and contacts no system.
