# Visual blueprint — a prompt's journey into functional logic

Two diagrams. The first is the **translation pipeline**: what happens to a
sentence between the textarea and the compiled JSON. The second is a
**compiled process** — the output the pipeline produces.

---

## 1. The translation pipeline

Lanes are the actors in the translation itself. Note that the loop back to the
Business User is the only path out of `blocked` — there is no route from an
under-specified sentence to a compiled workflow that does not pass through a
human answering a question.

```mermaid
flowchart TB
  subgraph USER["🧑 Business user"]
    direction TB
    U1["Types a process<br/>in plain English"]
    U2{"Answers a<br/>clarifying question"}
    U9["Exports JSON · SVG<br/>BPMN · Mermaid"]
  end

  subgraph INGEST["📥 Ingestion — parser.js"]
    direction TB
    I1["Segment on commas,<br/>semicolons, sequencing cues"]
    I2["Classify each clause<br/>against 10 verb frames"]
    I3["Extract entities:<br/>roles · systems · objects · money · durations"]
    I4["Parse conditions:<br/>subject · comparator · value"]
    I5["Apply precedence:<br/>'first' hoists a clause"]
  end

  subgraph COMPILE["⚙️ Compilation — compiler.js"]
    direction TB
    C1["Emit nodes, edges,<br/>lanes, connectors, variables"]
    C2["Replay stored answers<br/>onto a fresh graph"]
    C3["Attach governance block:<br/>regulatory scope · audit mode"]
  end

  subgraph REFLECT["🔁 Self-reflection — validator.js"]
    direction TB
    R1["structure · conditions · approvals<br/>connectors · governance · language"]
    R2{"Any blocking<br/>finding?"}
    R3["Raise a clarifying question<br/>with concrete options"]
  end

  subgraph LEDGER["🔒 Audit — audit.js"]
    direction TB
    L1["Append hash-chained entry<br/>for every state change"]
  end

  U1 --> I1 --> I2 --> I3 --> I4 --> I5 --> C1
  C2 -.->|"on each re-run"| C1
  C1 --> C3 --> R1 --> R2
  R2 -->|"yes — blocked"| R3
  R3 --> U2
  U2 -->|"answer stored in<br/>resolutions{}"| C2
  R2 -->|"no — ready"| U9

  U1 -.-> L1
  C1 -.-> L1
  R1 -.-> L1
  U2 -.-> L1
  U9 -.-> L1

  classDef user fill:#241f52,stroke:#8b5cf6,color:#e4e4e7
  classDef sys  fill:#052e2b,stroke:#2dd4bf,color:#e4e4e7
  classDef gate fill:#2e1f04,stroke:#f59e0b,color:#e4e4e7
  classDef aud  fill:#340d17,stroke:#f43f5e,color:#e4e4e7
  class U1,U2,U9 user
  class I1,I2,I3,I4,I5,C1,C2,C3,R1,R3 sys
  class R2 gate
  class L1 aud
```

### What each stage guarantees

| Stage | Guarantee | Enforced by |
|---|---|---|
| Ingestion | Anything unparseable becomes an explicit `unresolved` marker, never a guess. | `parser · conditions › marks an unevaluable predicate rather than guessing` |
| Compilation | Pure function of `(parsed, resolutions)` — same inputs, byte-identical output. | `compiler · graph › is deterministic` |
| Compilation | Node ids derive from clause position, so inserting nodes never renumbers existing ones. | `compiler · graph › keeps node ids stable…` |
| Self-reflection | Runs over the *graph*, so it catches dangling edges as well as missing currencies. | `validator · rules › catches an unreachable node` |
| Self-reflection | The same question is never asked twice; the loop always makes progress. | `validator · convergence › answering a question never introduces…` |
| Audit | Every state change is chained; editing history breaks verification. | `audit ledger › detects an edited payload` |

### Why the loop recompiles instead of patching

An answer is stored as a key in a plain `resolutions` object and the workflow is
rebuilt **from the original sentence** every time. There is never a
half-mutated graph anywhere.

Three properties fall out of that choice:

1. **Undo is free.** Withdrawing an answer is deleting a key, and the earlier
   workflow returns byte-identical.
2. **The output is fully explained.** Sentence + visible answer list = the whole
   workflow. Nothing came from anywhere else.
3. **Answers are portable.** The `resolutions` object is serialised into the
   exported JSON, so replaying a compile elsewhere reproduces the same document.

---

## 2. A compiled process

The output for the flagship sentence, after the five clarifying questions have
been answered. Lanes here are the *participants in the business process* — a
different axis from the pipeline diagram above.

> Send the invoice to accounting, if it is over $10k get CFO approval first,
> then log it in Snowflake

```mermaid
flowchart LR
  subgraph CFO["CFO — human"]
    direction LR
    n1_then["✓ Obtain CFO approval<br/><small>1 business day · escalate</small>"]
    n1_then_outcome{"CFO approved?"}
  end
  subgraph REQ["Requester — human"]
    direction LR
    n1_then_revise["→ Return for revision"]
  end
  subgraph ENG["Automation Engine — orchestrator"]
    direction LR
    n_start(["▶ Workflow triggered"])
    n1{"invoice.amount<br/>&gt; 10,000 USD?"}
    n1_merge{" "}
    n2["✉ Send invoice to Accounting"]
    n_audit["🔒 Write immutable audit record"]
    n_end(["● Process complete"])
  end
  subgraph SNOW["Snowflake — system"]
    direction LR
    n3["⤓ Log invoice in Snowflake<br/><small>retry ×3 · dead-letter</small>"]
  end

  n_start --> n1
  n1 -->|Yes| n1_then
  n1_then --> n1_then_outcome
  n1_then_outcome -->|Rejected| n1_then_revise
  n1_then_revise -.->|Resubmit| n1_then
  n1_then_outcome -->|Approved| n1_merge
  n1 -->|No| n1_merge
  n1_merge --> n2 --> n3 --> n_audit --> n_end
```

### Reading the diagram against the sentence

| What you see | Where it came from |
|---|---|
| The decision sits **before** the send | `"first"` in the sentence hoisted the whole conditional ahead of the clause written before it |
| The subject is `invoice.amount` | `"it"` bound to the nearest preceding object; reported as an informational finding |
| `> 10,000 USD` | `"over"` beat the stray `"is"` on comparator specificity; `$10k` carried its own currency |
| The **CFO approved?** gateway | Did not come from the sentence. Answering `R-NO-REJECT-PATH` created it. |
| The **Resubmit** loop edge | The "return for revision" answer, compiled as a genuine back-edge |
| The **audit record** step | Answering `R-AUDIT`; the flow was in `financial-controls` scope with no audit write |
| The SLA and retry badges | Answers to `R-NO-SLA` and `R-NO-RETRY` |

Six of the eleven boxes exist because a question was answered. The Dictionary
tab marks every one of them, so nobody signs off a diagram believing it all came
out of their sentence.

Raw exports of this workflow:
[JSON](artifacts/invoice-workflow.json) ·
[BPMN 2.0](artifacts/invoice-workflow.bpmn) ·
[Mermaid](artifacts/invoice-flow.mmd) ·
[before clarification](artifacts/invoice-workflow.unclarified.json)
