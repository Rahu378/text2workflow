# User stories

Jira format. Acceptance criteria are written so each one maps to a test in
[`tests/run.js`](../tests/run.js) — the named test is cited under each.

---

## T2W-1 · Generate a working system from plain text

> **As a** non-technical operations manager
> **I want to** type out a business approval path in simple text
> **So that** I can generate a working system specification without engineering help

**Acceptance criteria**

1. **Given** the sentence
   `"Send the invoice to accounting, if it is over $10k get CFO approval first, then log it in Snowflake"`
   **when** I compile it,
   **then** the approval gate appears *before* the send, because "first"
   reorders the clauses.
   → `parser · reference resolution › hoists a clause carrying "first"…`

2. **And** the pronoun "it" binds to `invoice.amount`, not to a new field.
   → `parser · reference resolution › binds a pronoun to the nearest preceding object`

3. **And** the threshold is read as `> 10,000 USD`, not `= 10,000`.
   → `parser · conditions › prefers the specific comparator over a stray copula`

4. **And** the output is a graph of 7 nodes across 3 swimlanes with every edge
   labelled, conforming to `workflow.v1.schema.json`.
   → `compiler · graph › compiles the flagship sentence to the expected shape`

5. **And** compiling the same sentence twice produces byte-identical JSON.
   → `compiler · graph › is deterministic — same inputs, byte-identical output`

**Definition of done:** the manager can hand the exported JSON and the swimlane
SVG to engineering without writing a line of code or opening a BPMN tool.

---

## T2W-2 · Block workflows that lack an audit trail or a regulatory step

> **As a** compliance officer
> **I want** the system to flag incomplete workflows that lack an explicit audit
> trail or regulatory step
> **So that** we prevent gaps reaching production

**Acceptance criteria**

1. **Given** a workflow that touches a monetary or personal-data object,
   **when** it compiles without an audit step,
   **then** rule `R-AUDIT` fires at **blocker** severity and the workflow status
   is `blocked`.
   → `validator · rules › blocks on a regulated flow with no audit step`

2. **And** an approval step that models only the approved outcome is blocked by
   `R-NO-REJECT-PATH`, because as compiled a rejection would fall through
   exactly like an approval — the control would do nothing.
   → `validator · rules › blocks on an approval with no rejection path`

3. **And** a decision whose negative branch was never stated is blocked by
   `R-ELSE`; the compiler's assumption ("skip the step and carry on") must be
   confirmed rather than inherited.
   → `validator · rules › blocks on an implicit negative branch`

4. **And** a monetary threshold with no currency is blocked by `R-CURRENCY`,
   while a plain count (`"over 5"`) is not — the rule fires on the ambiguity,
   not on every number.
   → `validator · rules › blocks on a money threshold with no currency`

5. **And** unquantifiable words ("significant", "appropriate", "quickly") raise
   `R-VAGUE` as an advisory that survives the loop, because the engine cannot
   turn them into a threshold and must not pretend otherwise.
   → `validator · rules › warns on unquantified language`

6. **And** the status never reads "ready" while a blocker is open, and no
   confidence percentage is reported anywhere.
   → `validator · rules › reports no confidence percentage anywhere`

**Definition of done:** a workflow missing a control cannot reach `ready`, and
the officer can see which rule stopped it and why.

---

## T2W-3 · Verify the logic visually against company policy

> **As a** business analyst
> **I want to** view a swimlane flowchart generated alongside the code output
> **So that** I can verify the logic matches our exact policy

**Acceptance criteria**

1. **Given** any compiled workflow, **when** I open the Blueprint tab,
   **then** every node has a position and every edge has a route; lanes that
   perform no step are omitted rather than drawn empty.
   → `layout › gives every node a box…`, `layout › drops lanes that perform no step`

2. **And** no two steps overlap within the same lane and column.
   → `layout › never overlaps two nodes in the same lane and column`

3. **And** the Dictionary tab shows one row per step, quoting the phrase I typed
   next to the exact backend call it became — including rows explicitly marked
   as coming from a *clarification* or from graph *structure* rather than from
   my sentence.
   → `exporters › the schema dictionary maps every phrase to a contract`,
     `exporters › dictionary rows declare where they came from`

4. **And** the diagram, the JSON, the Mermaid source and the BPMN file are all
   derived from the same graph, so the picture I sign off cannot drift from the
   JSON engineering implements.
   → `exporters › mermaid contains every node and every edge`,
     `exporters › bpmn export is well-formed and lane-complete`

5. **And** the BPMN export is marked `isExecutable="false"`, because it is a
   modelling handoff and must not be mistaken for a deployable archive.
   → same test as above

**Definition of done:** the analyst can point at a box in the diagram and read
the sentence fragment that produced it.
