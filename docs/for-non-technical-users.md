# Using Text2Workflow without writing code

Written for a Business Analyst, Operations Manager or Product Owner. You will
not need to know what a field path is, and the product never asks you to type
one.

---

## The 60-second version

1. **Type your process in normal English.** Don't try to sound technical — the
   engine is built for the way you'd explain it to a new starter.
2. **Answer the questions it asks.** They come as multiple choice. Pick the
   option that matches your actual policy.
3. **Press "Run test".** Put in a real example — a £6,000 invoice, a manager who
   says no — and watch the path light up.
4. **Read the Blueprint.** Left to right, like a swimlane chart. Each row is a
   person or a system.

That's it. If you never open the Schema JSON tab, nothing is missing.

## Plain English is the default

The switch in the top bar has two settings:

| | What you see |
|---|---|
| **Plain English** *(default)* | "What if the CFO says no?" · "Which currency is that?" · "Invoice amount is more than 10,000 USD?" |
| **Technical** | `R-NO-REJECT-PATH` · `R-CURRENCY` · `invoice.amount > 10,000 USD?` |

Technical mode exists for whoever picks the work up afterwards. It shows the
same findings with rule ids and field paths attached, so an engineer can search
for them. **Nothing is hidden from you in plain mode** — it is the same
information in different words, and you can flip between them at any time.

## Writing the sentence

Write it as one flowing description. Commas and the word "then" are how you
separate steps.

> Send the invoice to accounting, if it is over $10k get CFO approval first,
> then log it in Snowflake

Things that work well:

| You can write | It understands |
|---|---|
| "if it is over $10k" | a decision on the amount, in dollars |
| "get CFO approval **first**" | that this happens *before* the step you wrote first |
| "log **it** in Snowflake" | "it" means the invoice you mentioned earlier |
| "**otherwise** auto-approve it" | the other branch of the decision |
| "within 3 business days" | a deadline on the step |
| "**whenever** an invoice is received" | this is the trigger, not a decision |
| "at least 500 EUR", "25,000 USD", "2.5M" | amounts with or without symbols |

Things to avoid, because they can't be turned into a rule:

- **"significant", "large", "appropriate", "quickly"** — the engine will flag
  these and ask you for a number instead.
- **Two unrelated processes in one box** — describe one process at a time.
- **"if A then if B"** — nested conditions come out flattened. Write the two
  decisions as separate clauses.

If you're unsure, click one of the sample chips. Each one is labelled with which
persona it's for and what it demonstrates.

## Answering the questions

Every question is multiple choice. Press **1**, **2** or **3** on the keyboard
instead of clicking, if you prefer.

The questions you'll see most often:

**"What happens the rest of the time?"**
You said what to do when the invoice is over $10,000. You didn't say what to do
when it isn't. Pick "carry on" or "stop here".

**"What if the CFO says no?"**
This one matters more than it looks. If you skip it, a rejection would carry on
exactly as though it had been approved — the approval step wouldn't actually
stop anything. Your three options are: end it, send it back to the requester, or
escalate.

**"Which currency is that?"**
You wrote a limit but not a unit. One million yen and one million dollars route
very differently.

**"Which one did you mean?"**
You mentioned two records — say an invoice and a purchase order — and then wrote
"the amount". The engine won't guess which one.

**"We need to know how to check this"**
The engine couldn't turn your wording into something checkable. You get:

- **Suggestions at the top** — if you wrote "if rejected", it offers
  *"Invoice status is Rejected"* as a single click.
- **Three dropdowns** — *What should we look at?* → *How should we compare it?*
  → *To what?* All in business names: "Invoice · Amount", "is more than",
  "10,000 USD".
- **A read-back line** that restates your choice as a sentence, so you're
  confirming English rather than syntax.
- **An "Advanced" section**, collapsed, for anyone who wants to type a field
  name your team uses that isn't in the list. You can ignore it entirely.

### Changed your mind?

Every answer appears under **Answers on record** with an **Undo** button. Undo
rebuilds the whole process from your original sentence without that answer —
nothing is left over from the version you undid.

## Testing it with real numbers

The **Test run** tab is where you check the logic actually matches policy.

1. The left column fills itself in with the decisions your process makes. For
   the invoice example that's *Invoice amount* and *CFO decision*.
2. Change a value — set the amount to 6,000, or click **Rejected**.
3. Press **Run test**.

You get a numbered walk-through in plain sentences:

> 1. **Workflow triggered** — The process starts.
> 2. **Invoice amount is more than 10,000 USD?** — Amount is 6,000 USD, which
>    does not satisfy > 10,000 USD. Taking the "No" path.
> 3. **Merge** — The branches come back together.
> 4. **Send invoice to Accounting** — A notification goes to Accounting.

Over on the **Blueprint** tab the path taken is lit up and numbered; everything
not taken is dimmed. Use **◀ ▶** to step through, or **▶ Play** to watch it run.

**What to check:** does a rejected invoice really go back to the requester?
Does a £6,000 invoice really skip the CFO? Does anything reach Snowflake that
shouldn't?

**Important:** this is a walk-through, not a real run. Nothing is sent, written
or created anywhere — no system is contacted at any point.

### If the test says "the process went round in a circle"

That's usually correct, not broken. If you chose "send it back to the requester"
and then told the simulator the CFO rejects it, the loop is real — in life the
requester would change something before resubmitting. The simulator stops after
a few laps and says so.

## Reading the Blueprint

Left to right. Each horizontal band is one person or one system.

| Shape | Meaning |
|---|---|
| Green circle | Where the process starts |
| Orange diamond | A decision — green line is yes, dashed grey is no |
| Purple box | A person has to do something |
| Blue box | A message goes out |
| Teal box | A system is read or written |
| Red circle | The process stops here |
| Dashed orange line | Work going backwards for rework |

Click any box to see what it turned into. Small badges on a box show its
deadline and retry policy.

## Handing it over

When the status pill reads **Ready to hand over**, four things are worth sending
to whoever builds it:

| Tab | What to send | Who reads it |
|---|---|---|
| Blueprint → **Download SVG** | the picture | everyone |
| **Dictionary** → Copy as CSV | phrase-by-phrase mapping | the analyst and the developer |
| Schema JSON → **Download** | the machine-readable spec | the developer |
| Exports → **Download BPMN** | opens in Camunda / bpmn.io | the architect |

The Dictionary is the one to look at yourself. It has a row per step showing the
phrase you wrote next to what it became — and it marks clearly which steps came
from *your sentence*, which came from *a question you answered*, and which the
engine added for structure. Nobody should sign off a diagram thinking all of it
came out of their own words.

## What the status pill means

| Pill | Meaning |
|---|---|
| **N questions to answer** | Something important is undefined. The process isn't finishable yet. |
| **N things worth a look** | Nothing is blocking, but the engine has advice it can't act on for you — usually vague wording or two overlapping limits. |
| **Ready to hand over** | Every check passed. |

There is deliberately **no percentage score**. A number like "87% confident"
would imply the engine has been measured against workflows that experts agreed
on, and it hasn't been. It tells you which checks passed instead, which is a
thing it can actually stand behind. See [limitations.md](limitations.md).
