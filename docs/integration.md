# Integrating with a runtime

Seven exports, all derived from the same compiled graph, so the diagram a BA
signs off and the state machine a platform team deploys cannot drift apart.

None of them is a deployable artefact. Each says so in its own header, so the
caveat travels with the file rather than living in this document.

---

## Input contract — JSON Schema 2020-12

The payload that starts a run.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://text2workflow.local/contracts/wf_f8b5dee1/input.schema.json",
  "title": "Invoice Approval Workflow — trigger payload",
  "type": "object",
  "properties": {
    "invoice": {
      "type": "object",
      "properties": {
        "amount": {
          "type": "number",
          "minimum": 0,
          "x-currency": "USD",
          "description": "Amount in USD. The workflow compares it against a threshold expressed in USD; sending another currency silently mis-routes the run. This field name was inferred from the source sentence rather than stated outright — confirm it matches your payload."
        }
      },
      "required": ["amount"]
    },
    "workflow": {
      "type": "object",
      "properties": { "correlationId": { "type": "string" } },
      "required": ["correlationId"]
    }
  },
  "required": ["invoice", "workflow"]
}
```

Three things worth noting:

- **Everything is required.** A field the workflow reads is a field it cannot
  run without; marking it optional would be a lie.
- **`x-currency` is carried through.** The threshold is in USD; a caller sending
  EUR would mis-route every approval without any error.
- **Inferred field names are labelled.** If the parser derived `invoice.amount`
  from the word "it" rather than from your sentence naming it, the description
  says so.

Validate incoming requests against this before starting a run.

## OpenAPI 3.1 — the connector interface

One path per distinct connector call, plus `/tasks/human` and
`/notifications/send`.

```yaml
/connectors/sys_snowflake/record/insert:
  post:
    parameters:
      - name: Idempotency-Key
        in: header
        required: true
        description: >
          Stable across retries of one step. A repeated warehouse write creates
          a second record. The caller retries up to 4 times, so the
          implementation MUST treat a repeat with the same value as the same
          request.
    responses:
      200: { description: Accepted and applied. }
      409: { description: Duplicate identified by the idempotency key. The caller treats this as success. }
      429: { description: Rate limited. Counts as a retryable failure and feeds the circuit breaker. }
    x-resilience:
      timeoutSeconds: 60
      retry: { maxAttempts: 4, backoff: exponential, initialIntervalSeconds: 1, ... }
      circuitBreaker: { failureThreshold: 8, openSeconds: 120, ... }
```

`x-resilience` is the useful part. It tells whoever implements the endpoint what
behaviour they must tolerate: how often it will be called on failure, how long
the caller waits, and when it will stop calling altogether.

## AWS Step Functions — Amazon States Language

The closest fit of the four runtimes, because ASL has first-class `Retry` — the
resilience declarations become executable configuration rather than
documentation.

```json
"n3": {
  "Type": "Task",
  "Resource": "arn:aws:states:::http:invoke",
  "Parameters": {
    "ApiEndpoint": "${ConnectorBaseUrl}/connectors/sys_snowflake/record/insert",
    "Method": "POST",
    "Headers": { "Idempotency-Key": "{{workflow.correlationId}}:n3" }
  },
  "TimeoutSeconds": 60,
  "Retry": [{
    "ErrorEquals": ["States.Timeout", "States.TaskFailed", "States.Http.StatusCode.429", "States.Http.StatusCode.500", "States.Http.StatusCode.503"],
    "IntervalSeconds": 1, "MaxAttempts": 3, "BackoffRate": 2,
    "MaxDelaySeconds": 60, "JitterStrategy": "FULL"
  }],
  "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "n3__failed", "ResultPath": "$.error" }],
  "Next": "n_end"
}
```

Mappings:

| Compiled node | ASL |
|---|---|
| `gateway.exclusive` | `Choice` with a typed comparator (`NumericGreaterThan`, `StringEquals`) and an always-present `Default` |
| `task.approval` | `Task` on `waitForTaskToken`, with the SLA as `HeartbeatSeconds` |
| `task.data.*`, `task.create` | `Task` on `http:invoke` with `Retry` and `Catch` |
| `gateway.merge`, start | `Pass` |
| `end` / `end.terminate` | `Succeed` / `Fail` |
| retry exhaustion | a named `__failed` state whose `Cause` explains which step gave up |

`MaxAttempts` is `maxAttempts - 1`, because ASL counts *retries* while the
compiled policy counts *total attempts*. Substitute `${ConnectorBaseUrl}`,
`${EventBridgeConnectionArn}` and `${HumanTaskFunctionArn}` before use.

## Temporal — TypeScript skeleton

```ts
// Snowflake: 4 attempts, waiting 1s and doubling up to 60s, with jitter, then dead letter
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 4,
    initialInterval: '1 seconds',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
  },
});

export const n1ThenSignal = defineSignal<['approved' | 'rejected']>('n1ThenDecision');
```

One `proxyActivities` per distinct policy, so the numbers stay meaningful rather
than collapsing into one shared default. Human steps become a signal plus a
`condition()` with the SLA as its timeout. The activity implementations are not
written — that is the scaffold part.

## Camunda BPMN 2.0

The existing BPMN export, now carrying Camunda extension attributes:

```xml
<bpmn:serviceTask id="n3" name="Log invoice in Snowflake"
                  camunda:asyncBefore="true"
                  camunda:type="external"
                  camunda:topic="sys_snowflake.record.insert"
                  camunda:failedJobRetryTimeCycle="R3/PT1S">
  <bpmn:extensionElements>
    <camunda:properties>
      <camunda:property name="timeoutSeconds" value="60" />
      <camunda:property name="idempotencyHeader" value="Idempotency-Key" />
      <camunda:property name="idempotencyKey" value="{{workflow.correlationId}}:n3" />
      <camunda:property name="circuitBreaker.failureThreshold" value="8" />
    </camunda:properties>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

User tasks get `camunda:candidateGroups` from the performer and a `dueDate`
expression from the SLA. Still `isExecutable="false"` with no `BPMNDiagram`
coordinates: a modelling handoff for Camunda Modeler or bpmn.io, not a
deployable process archive.

## Mermaid and Markdown

`Mermaid` is the Blueprint as text — safe to paste into a ticket, a PR
description or a wiki. `Markdown` is a step table plus every finding that is
still open, for a handover ticket.

---

## What is verified

Each export has tests in [`tests/run.js`](../tests/run.js):

- Input schema **validates a good payload and rejects a bad one**, using the
  same JSON Schema validator the suite uses on the workflow document itself.
- OpenAPI: unique `operationId`s, every `$ref` resolves, the `x-resilience`
  block matches the compiled node, the idempotency header is required.
- Step Functions: `StartAt` resolves, every `Next` / `Default` / `Choices[].Next`
  / `Catch[].Next` names a real state, no state is non-terminal without a way
  out, and the `Retry` block matches the compiled policy.
- Temporal: balanced braces, real retry numbers, a signal per human step.
- BPMN: well-formed via a stack-based tag matcher, correct retry cycle, one lane
  per performing participant.
- And a sweep asserting **every sample exports cleanly in every format**.
