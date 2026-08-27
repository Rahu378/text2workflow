/**
 * samples.js — worked examples.
 *
 * These are chosen to exercise different parts of the grammar, and each one is
 * labelled with what it is meant to demonstrate — including the ones that are
 * meant to fail validation loudly.
 */

export const SAMPLES = [
  {
    id: 'invoice',
    label: 'Invoice approval',
    persona: 'Business Operations Manager',
    demonstrates: 'Out-of-order logic: "first" hoists the approval gate ahead of the send.',
    text: 'Send the invoice to accounting, if it is over $10k get CFO approval first, then log it in Snowflake'
  },
  {
    id: 'po-intake',
    label: 'PO intake with trigger',
    persona: 'Systems Integration BA',
    demonstrates: 'Event trigger, two systems, and an ambiguous "the amount" that the loop asks about.',
    text: 'Whenever an invoice is received, verify the PO in SAP, if the amount is over 25,000 USD get controller approval first, then post it to NetSuite and notify accounting'
  },
  {
    id: 'expense',
    label: 'Expense with an else branch',
    persona: 'Business Operations Manager',
    demonstrates: 'An explicit "otherwise" branch, so R-ELSE stays quiet on that gateway.',
    text: 'When an expense report is at least 500 EUR route it to the manager for review, otherwise auto-approve it and log it in NetSuite'
  },
  {
    id: 'onboarding',
    label: 'Employee onboarding',
    persona: 'Enterprise Architect',
    demonstrates: 'PII detection driving the compliance findings, plus a Slack egress warning.',
    text: 'When a new hire is created in Workday, create their accounts in Okta, send their salary details to the manager on Slack and file the signed offer in SharePoint'
  },
  {
    id: 'contract',
    label: 'Contract review',
    persona: 'Compliance Officer',
    demonstrates: 'A negated condition ("not above") and an SLA lifted straight from the sentence.',
    text: 'If the contract value is not above 1M, have legal review it within 3 business days and store the signed copy in SharePoint'
  },
  {
    id: 'vague',
    label: 'Deliberately vague',
    persona: 'Compliance Officer',
    demonstrates: 'What a bad request looks like: an unquantified threshold and an unevaluable predicate.',
    text: 'If a payment looks significant, get the appropriate person to approve it quickly and record it somewhere'
  },
  {
    id: 'cross-system',
    label: 'Cross-system sync',
    persona: 'Enterprise Architect',
    demonstrates: 'Two irreversible writes in one run — R-PARTIAL-WRITE asks what happens if the second fails after the first succeeded.',
    text: 'When an order is placed in Salesforce, create the invoice in NetSuite, log it in Snowflake and notify the finance team on Slack'
  },
  {
    id: 'refund',
    label: 'Customer refund',
    persona: 'Business Operations Manager',
    demonstrates: 'Two thresholds on the same field — R-THRESHOLD-CONFLICT catches the overlap.',
    text: 'When a refund is requested in Zendesk, if the amount is over 200 USD get manager approval, if the amount is over 2000 USD get director approval, then issue the refund in Stripe'
  }
];

export function sampleById(id) {
  return SAMPLES.find(s => s.id === id) || SAMPLES[0];
}
