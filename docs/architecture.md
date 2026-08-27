# Architecture

No build step, no dependencies, no network. `index.html` plus ES modules served
from any static host.

```
text2workflow/
├── index.html                     dual-pane workspace shell
├── assets/
│   ├── css/app.css                design system — every colour is a token
│   └── js/
│       ├── lexicon.js             DATA: roles, connectors, objects, verb frames, cues
│       ├── parser.js              text → IR          (deterministic grammar)
│       ├── compiler.js            IR → workflow graph (pure function)
│       ├── validator.js           graph → findings + questions
│       ├── layout.js              graph → swimlane geometry
│       ├── render.js              geometry → inline SVG
│       ├── exporters.js           graph → Mermaid / BPMN / dictionary / Markdown
│       ├── audit.js               hash-chained append-only ledger
│       ├── trace.js               measured execution log lines
│       ├── samples.js             worked examples
│       └── app.js                 UI wiring — the only module that touches the DOM
├── schema/workflow.v1.schema.json the output contract
├── tests/                         72 tests, zero dependencies
└── docs/
```

## The one idea

```
compile(parse(utterance), resolutions)  →  workflow
validate(workflow, resolutions)         →  findings + questions
```

Both functions are pure. The application state is two values — the sentence and
an object of answers — and everything visible is derived from them. Answering a
question adds a key and re-runs the whole pipeline from the raw text.

This is why the app has no state-management layer and why "undo" required no
code: `delete resolutions[key]` and recompile.

## Module rules

**`lexicon.js` is data, not logic.** Adding Coupa, or a "Treasury" role, or a
new verb frame is a data edit. A BA can extend the engine's vocabulary without
touching the grammar. Every entity is a `{ id, name, patterns[] }` record; the
parser does whole-word matching against `patterns`.

**Only `app.js` touches the DOM.** Parser, compiler, validator, layout,
exporters and audit all run unchanged in Node, which is what makes the test
suite possible without a headless browser.

**`render.js` reads CSS custom properties by name.** The SVG references
`var(--n-human)` and friends, so the diagram and the interface cannot drift out
of palette, and the downloaded SVG carries the stylesheet inline.

**No `innerHTML` anywhere in the render path.** Every node is built with
`createElement` / `textContent`, including the JSON syntax highlighter and the
execution log. User text goes through the parser and lands in the diagram and
the terminal; treating it as data throughout removes the injection surface
entirely rather than escaping it case by case.

## Node id scheme

Ids derive from clause position, not from a running counter:

| Id | What it is |
|---|---|
| `n1` | the node compiled from spec 1 |
| `n1.then` | the task on that gateway's true branch |
| `n1.merge` | the merge closing that gateway |
| `n1.then.outcome` | the approval outcome gateway, if the rejection question was answered |
| `n1.then.revise` | the "return for revision" task |
| `n1.stop` | the terminate node from an "else → stop" answer |
| `n_audit`, `n_start`, `n_end` | singletons |

The reason is subtle and was found by a test: answers are keyed by node id
(`reject:n1.then`). With a running counter, answering one question inserts nodes
and renumbers everything after it — silently repointing every other stored
answer at the wrong node. Position-derived ids make insertion non-disruptive.

## Layout

Left-to-right layered layout. Rank is the longest path from the start event over
the DAG of non-back edges, so an approval-rework loop cannot push its own target
rightwards forever. Lane = the participant that performs the step; participants
that only ever *receive* (accounting gets an email but performs nothing) are
dropped rather than drawn as an empty band.

Nodes sharing a `(rank, lane)` cell stack vertically inside that lane, and the
lane's height is driven by its fullest cell. Edges route orthogonally out of the
right edge, across a mid-channel, into the left edge; back-edges drop below
every lane into a dedicated channel.

The Blueprint panel splits its height between the drawing and a **step
inspector**. A process graph is far wider than it is tall, so fitting it to the
pane width always left a large empty band underneath; that band now holds the
answer to "click any step to inspect what it compiled to" — what the step does
in plain language, who performs it, its safeguards, and, most importantly,
whether it came from the user's sentence, from an answer they gave, or from the
compiler. With nothing selected it summarises the process, so the area is never
blank. Column width is deliberately tight (214px) because it is the biggest
lever on the scale the diagram ends up rendering at: airy columns look fine at
1:1 and turn the labels unreadable at 0.55.

Zoom rewrites `width`/`height` against a fixed `viewBox` rather than applying a
CSS transform, so the scroll container reflows to the scaled size. Fit never
shrinks below 0.5 — a wide process on a narrow pane scrolls sideways rather than
becoming an unreadable thumbnail.

## The execution log is measured, not staged

`trace.js` builds the terminal lines from real `performance.now()` deltas around
each phase. The reveal is staggered for readability, but **every timestamp
printed is the measured one**, and a test asserts the log cannot claim more
elapsed time than was actually measured.

The six passes are labelled like agents because they are structurally that —
independent, single-responsibility validators over a shared graph. They are
deterministic rule modules, not learned policies, and the footer under the
terminal says so on screen.

## Security posture

Everything runs client-side. Nothing typed into the box is transmitted anywhere
— there is no `fetch`, no `XMLHttpRequest`, no WebSocket and no analytics in the
codebase. An operations manager can paste a live internal process description
without a data-transfer review.

The trade-off: the audit ledger has no external witness. See
[limitations.md](limitations.md#the-audit-ledger).

## Testing

`node tests/run.js` — 72 tests, no dependencies, no config. Includes a small
JSON Schema (2020-12 subset) validator in `tests/schema-lite.js` so every
sample's compiled output is checked against the published contract rather than
against a hand-written expectation.

The suite is organised around the claims the README makes. Anything asserted
there has a test; anything not tested is not asserted.
