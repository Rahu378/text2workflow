| Phrase from the sentence | Recognised as | Performer | Binding | Backend contract |
|---|---|---|---|---|
| _structure_ | `event.start` | Automation Engine | `manual:manual` | — |
| "if it is over $10k get CFO approval first" | `gateway.exclusive` | Automation Engine | `invoice.amount > 10,000 USD` | `EVAL /engine/decide` |
| "get CFO approval first" | `task.approval` | CFO | `humanTask.assign(role_cfo)` | `POST /tasks/human` |
| _clarification_ | `gateway.exclusive` | CFO | `n1.then.outcome = approved` | `EVAL /engine/decide` |
| _clarification_ | `task.assign` | Requester | `humanTask.assign(role_requester)` | — |
| "Send the invoice to accounting" | `task.notify` | Automation Engine | `notify → Accounting` | `POST /notifications/send` |
| "log it in Snowflake" | `task.data.write` | Snowflake | `Snowflake.record.insert` | `POST /connectors/sys_snowflake/record/insert` |
| _clarification_ | `task.audit` | Automation Engine | `Snowflake.ledger.append` | `POST /connectors/sys_audit/ledger/append` |
| _structure_ | `end` | Automation Engine | `—` | — |