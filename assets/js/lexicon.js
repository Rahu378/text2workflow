/**
 * lexicon.js — the domain vocabulary the parser matches against.
 *
 * Everything here is data, not logic. Adding a connector or a role is a data
 * edit, which is what lets a BA extend the engine without touching the grammar.
 */

/** Roles a human step can be assigned to. `lane` is the swimlane label. */
export const ROLES = [
  { id: 'role_cfo', name: 'CFO', lane: 'CFO', patterns: ['cfo', 'chief financial officer'], seniority: 'exec' },
  { id: 'role_ceo', name: 'CEO', lane: 'CEO', patterns: ['ceo', 'chief executive'], seniority: 'exec' },
  { id: 'role_coo', name: 'COO', lane: 'COO', patterns: ['coo', 'chief operating officer'], seniority: 'exec' },
  { id: 'role_cto', name: 'CTO', lane: 'CTO', patterns: ['cto', 'chief technology officer'], seniority: 'exec' },
  { id: 'role_controller', name: 'Controller', lane: 'Controller', patterns: ['controller', 'financial controller'], seniority: 'senior' },
  { id: 'role_vp', name: 'VP', lane: 'VP', patterns: ['vp', 'vice president'], seniority: 'exec' },
  { id: 'role_director', name: 'Director', lane: 'Director', patterns: ['director'], seniority: 'senior' },
  { id: 'role_manager', name: 'Manager', lane: 'Manager', patterns: ['manager', "manager's", 'line manager', 'people manager'], seniority: 'mid' },
  { id: 'role_accounting', name: 'Accounting', lane: 'Accounting', patterns: ['accounting', 'accounts payable', 'ap team', 'a/p', 'accounts receivable', 'ar team'], seniority: 'team' },
  { id: 'role_finance', name: 'Finance', lane: 'Finance', patterns: ['finance', 'finance team', 'fp&a', 'treasury'], seniority: 'team' },
  { id: 'role_legal', name: 'Legal', lane: 'Legal', patterns: ['legal', 'legal team', 'counsel', 'general counsel'], seniority: 'team' },
  { id: 'role_compliance', name: 'Compliance', lane: 'Compliance', patterns: ['compliance', 'compliance team', 'risk team', 'risk & compliance'], seniority: 'team' },
  { id: 'role_procurement', name: 'Procurement', lane: 'Procurement', patterns: ['procurement', 'purchasing', 'sourcing'], seniority: 'team' },
  { id: 'role_hr', name: 'HR', lane: 'HR', patterns: ['hr', 'human resources', 'people team', 'people ops'], seniority: 'team' },
  { id: 'role_security', name: 'Security', lane: 'Security', patterns: ['security', 'infosec', 'security team', 'soc'], seniority: 'team' },
  // NB: no bare 'it' pattern — it would match the pronoun in "approve it",
  // silently assigning finance approvals to the IT department.
  { id: 'role_it', name: 'IT', lane: 'IT', patterns: ['it team', 'it department', 'it support', 'helpdesk', 'service desk'], seniority: 'team' },
  { id: 'role_sales', name: 'Sales', lane: 'Sales', patterns: ['sales', 'sales team', 'account executive', 'ae'], seniority: 'team' },
  { id: 'role_support', name: 'Support', lane: 'Support', patterns: ['support', 'customer support', 'cs team', 'success team'], seniority: 'team' },
  { id: 'role_requester', name: 'Requester', lane: 'Requester', patterns: ['requester', 'requestor', 'submitter', 'employee', 'the user'], seniority: 'individual' },
  { id: 'role_customer', name: 'Customer', lane: 'Customer', patterns: ['customer', 'client', 'vendor', 'supplier'], seniority: 'external' }
];

/**
 * Systems the engine claims to be able to emit a call for.
 * `status` is honest: 'registered' means the JSON contract below is defined in
 * this repo; it does NOT mean a live integration has been built and tested.
 */
export const CONNECTORS = [
  { id: 'sys_snowflake', name: 'Snowflake', patterns: ['snowflake'], category: 'warehouse', defaultOp: 'table.insert', status: 'registered' },
  { id: 'sys_salesforce', name: 'Salesforce', patterns: ['salesforce', 'sfdc'], category: 'crm', defaultOp: 'record.upsert', status: 'registered' },
  { id: 'sys_sap', name: 'SAP', patterns: ['sap', 's/4hana', 'sap ecc'], category: 'erp', defaultOp: 'bapi.call', status: 'registered' },
  { id: 'sys_netsuite', name: 'NetSuite', patterns: ['netsuite', 'oracle netsuite'], category: 'erp', defaultOp: 'record.create', status: 'registered' },
  { id: 'sys_oracle', name: 'Oracle ERP', patterns: ['oracle erp', 'oracle fusion', 'oracle'], category: 'erp', defaultOp: 'record.create', status: 'registered' },
  { id: 'sys_workday', name: 'Workday', patterns: ['workday'], category: 'hcm', defaultOp: 'worker.update', status: 'registered' },
  { id: 'sys_coupa', name: 'Coupa', patterns: ['coupa'], category: 'p2p', defaultOp: 'invoice.create', status: 'registered' },
  { id: 'sys_servicenow', name: 'ServiceNow', patterns: ['servicenow', 'snow ticket', 'service now'], category: 'itsm', defaultOp: 'incident.create', status: 'registered' },
  { id: 'sys_jira', name: 'Jira', patterns: ['jira', 'jira ticket'], category: 'itsm', defaultOp: 'issue.create', status: 'registered' },
  { id: 'sys_zendesk', name: 'Zendesk', patterns: ['zendesk'], category: 'itsm', defaultOp: 'ticket.create', status: 'registered' },
  { id: 'sys_slack', name: 'Slack', patterns: ['slack'], category: 'messaging', defaultOp: 'chat.postMessage', status: 'registered' },
  { id: 'sys_teams', name: 'Microsoft Teams', patterns: ['teams', 'ms teams', 'microsoft teams'], category: 'messaging', defaultOp: 'channel.post', status: 'registered' },
  { id: 'sys_outlook', name: 'Outlook', patterns: ['outlook', 'exchange'], category: 'email', defaultOp: 'mail.send', status: 'registered' },
  { id: 'sys_docusign', name: 'DocuSign', patterns: ['docusign', 'adobe sign'], category: 'esign', defaultOp: 'envelope.create', status: 'registered' },
  { id: 'sys_stripe', name: 'Stripe', patterns: ['stripe'], category: 'payments', defaultOp: 'payment.create', status: 'registered' },
  { id: 'sys_quickbooks', name: 'QuickBooks', patterns: ['quickbooks', 'qbo'], category: 'accounting', defaultOp: 'bill.create', status: 'registered' },
  { id: 'sys_s3', name: 'Amazon S3', patterns: ['s3', 'amazon s3', 'object storage'], category: 'storage', defaultOp: 'object.put', status: 'registered' },
  { id: 'sys_sharepoint', name: 'SharePoint', patterns: ['sharepoint', 'onedrive'], category: 'storage', defaultOp: 'file.upload', status: 'registered' },
  { id: 'sys_hubspot', name: 'HubSpot', patterns: ['hubspot'], category: 'crm', defaultOp: 'record.upsert', status: 'registered' },
  { id: 'sys_databricks', name: 'Databricks', patterns: ['databricks', 'delta lake'], category: 'warehouse', defaultOp: 'table.insert', status: 'registered' },
  { id: 'sys_bigquery', name: 'BigQuery', patterns: ['bigquery', 'big query'], category: 'warehouse', defaultOp: 'table.insert', status: 'registered' }
];

/** Business objects the flow can carry. Drives variable typing. */
export const OBJECTS = [
  { id: 'obj_invoice', name: 'invoice', patterns: ['invoice', 'invoices', 'bill'], amountField: 'invoice.amount', money: true, pii: false },
  { id: 'obj_po', name: 'purchase order', patterns: ['purchase order', 'po', 'requisition'], amountField: 'purchaseOrder.total', money: true, pii: false },
  { id: 'obj_expense', name: 'expense report', patterns: ['expense report', 'expense', 'expenses', 'reimbursement'], amountField: 'expense.total', money: true, pii: true },
  { id: 'obj_contract', name: 'contract', patterns: ['contract', 'agreement', 'msa', 'sow'], amountField: 'contract.value', money: true, pii: false },
  // Listed before `payment` so "refund" resolves to its own object — matches at
  // the same offset are broken by table order.
  { id: 'obj_refund', name: 'refund', patterns: ['refund', 'chargeback', 'credit note'], amountField: 'refund.amount', money: true, pii: false },
  { id: 'obj_payment', name: 'payment', patterns: ['payment', 'wire', 'transfer', 'payout'], amountField: 'payment.amount', money: true, pii: false },
  { id: 'obj_order', name: 'order', patterns: ['order', 'sales order'], amountField: 'order.total', money: true, pii: false },
  { id: 'obj_claim', name: 'claim', patterns: ['claim', 'claims'], amountField: 'claim.amount', money: true, pii: true },
  { id: 'obj_ticket', name: 'ticket', patterns: ['ticket', 'incident', 'case'], amountField: null, money: false, pii: false },
  { id: 'obj_candidate', name: 'candidate', patterns: ['candidate', 'applicant', 'new hire', 'offer'], amountField: 'offer.salary', money: true, pii: true },
  { id: 'obj_timesheet', name: 'timesheet', patterns: ['timesheet', 'time sheet', 'hours'], amountField: null, money: false, pii: true },
  { id: 'obj_customer', name: 'customer record', patterns: ['customer record', 'account record', 'lead'], amountField: null, money: false, pii: true },
  { id: 'obj_document', name: 'document', patterns: ['document', 'file', 'report', 'attachment'], amountField: null, money: false, pii: false }
];

/**
 * Verb frames. `type` is the node type emitted; `cues` are matched as whole
 * words against the normalized clause. Order matters — the parser takes the
 * highest-priority frame that matches.
 */
export const VERB_FRAMES = [
  { type: 'task.approval', priority: 100, cues: ['approval', 'approve', 'approves', 'sign-off', 'sign off', 'signoff', 'authorize', 'authorization', 'authorisation', 'green-light', 'green light', 'endorse'], label: 'Approval' },
  { type: 'task.review', priority: 90, cues: ['review', 'reviews', 'vet', 'assess', 'triage', 'inspect'], label: 'Review' },
  { type: 'task.notify', priority: 80, cues: ['send', 'sends', 'email', 'emails', 'notify', 'notifies', 'alert', 'alerts', 'message', 'ping', 'forward', 'forwards', 'inform', 'cc', 'escalate'], label: 'Notify' },
  { type: 'task.data.write', priority: 78, cues: ['log', 'logs', 'record', 'records', 'write', 'writes', 'store', 'stores', 'save', 'saves', 'insert', 'push', 'pushes', 'sync', 'syncs', 'archive', 'post', 'load'], label: 'Write' },
  { type: 'task.create', priority: 76, cues: ['create', 'creates', 'open', 'opens', 'raise', 'raises', 'file', 'files', 'generate', 'generates', 'issue', 'draft'], label: 'Create' },
  { type: 'task.data.read', priority: 70, cues: ['check', 'checks', 'verify', 'verifies', 'validate', 'validates', 'look up', 'lookup', 'fetch', 'fetches', 'pull', 'query', 'queries', 'match', 'reconcile', 'confirm'], label: 'Lookup' },
  { type: 'task.assign', priority: 68, cues: ['assign', 'assigns', 'route', 'routes', 'hand off', 'handoff', 'delegate', 'dispatch'], label: 'Assign' },
  { type: 'task.transform', priority: 60, cues: ['calculate', 'compute', 'convert', 'transform', 'map', 'enrich', 'redact', 'summarize', 'extract'], label: 'Transform' },
  { type: 'event.timer', priority: 55, cues: ['wait', 'waits', 'pause', 'hold', 'delay', 'sleep'], label: 'Wait' },
  { type: 'task.terminate', priority: 50, cues: ['reject', 'rejects', 'decline', 'deny', 'cancel', 'close', 'stop', 'abort'], label: 'Terminate' }
];

/** Words that open a conditional clause. */
export const CONDITION_CUES = ['if', 'when', 'whenever', 'unless', 'in case', 'should', 'provided that', 'as long as'];

/** Words that open the negative branch of a conditional. */
export const ELSE_CUES = ['otherwise', 'else', 'if not', 'or else', 'failing that', 'in all other cases'];

/** Comparison operators, longest phrase first so 'greater than or equal' wins. */
export const COMPARATORS = [
  { op: 'gte', patterns: ['greater than or equal to', 'at least', 'no less than', '>=', 'or more', 'or above'] },
  { op: 'lte', patterns: ['less than or equal to', 'at most', 'no more than', '<=', 'or less', 'or below'] },
  { op: 'gt', patterns: ['greater than', 'more than', 'over', 'above', 'exceeds', 'exceed', 'exceeding', 'beyond', '>'] },
  { op: 'lt', patterns: ['less than', 'under', 'below', 'fewer than', '<'] },
  { op: 'neq', patterns: ['is not', 'not equal to', 'other than', "isn't", '!='] },
  { op: 'eq', patterns: ['equal to', 'equals', 'is exactly', 'is', '=='] }
];

/** Sequencing cues that split one clause from the next. */
export const SEQUENCE_CUES = ['then', 'after that', 'afterwards', 'next', 'finally', 'subsequently', 'once done', 'and then'];

/** Cues that pull a clause *before* the one it was written after. */
export const PRECEDENCE_CUES = ['first', 'beforehand', 'up front', 'before that', 'prior to that', 'in advance'];

/** Cues that mean two steps run at the same time. */
export const PARALLEL_CUES = ['at the same time', 'in parallel', 'simultaneously', 'concurrently', 'meanwhile'];

/** Quantifiers a machine cannot turn into a threshold. Drives rule R-VAGUE. */
export const VAGUE_TERMS = [
  'large', 'small', 'significant', 'material', 'high value', 'high-value', 'low value',
  'soon', 'asap', 'quickly', 'promptly', 'immediately', 'in a timely manner',
  'appropriate', 'relevant', 'necessary', 'important', 'urgent', 'as needed',
  'the right', 'someone', 'somebody', 'a few', 'several', 'many', 'most'
];

/** Terms that mark the flow as touching regulated data. Drives rule R-AUDIT. */
export const REGULATED_CUES = [
  { term: 'ssn', regime: 'PII' }, { term: 'social security', regime: 'PII' },
  { term: 'passport', regime: 'PII' }, { term: 'date of birth', regime: 'PII' },
  { term: 'salary', regime: 'PII' }, { term: 'payroll', regime: 'PII' },
  { term: 'phi', regime: 'HIPAA' }, { term: 'patient', regime: 'HIPAA' }, { term: 'medical', regime: 'HIPAA' },
  { term: 'card number', regime: 'PCI-DSS' }, { term: 'credit card', regime: 'PCI-DSS' }, { term: 'cardholder', regime: 'PCI-DSS' },
  { term: 'gdpr', regime: 'GDPR' }, { term: 'personal data', regime: 'GDPR' },
  { term: 'sox', regime: 'SOX' }, { term: 'journal entry', regime: 'SOX' }, { term: 'general ledger', regime: 'SOX' }
];

/** Currency symbols/codes → ISO 4217. */
export const CURRENCIES = {
  '$': 'USD', 'usd': 'USD', 'dollar': 'USD', 'dollars': 'USD',
  '€': 'EUR', 'eur': 'EUR', 'euro': 'EUR', 'euros': 'EUR',
  '£': 'GBP', 'gbp': 'GBP', 'pound': 'GBP', 'pounds': 'GBP',
  '¥': 'JPY', 'jpy': 'JPY', 'yen': 'JPY',
  '₹': 'INR', 'inr': 'INR', 'rupee': 'INR', 'rupees': 'INR'
};

export const MAGNITUDES = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, bn: 1e9, b: 1e9, billion: 1e9 };

export const DURATION_UNITS = {
  minute: 60, minutes: 60, min: 60, mins: 60,
  hour: 3600, hours: 3600, hr: 3600, hrs: 3600,
  day: 86400, days: 86400,
  'business day': 86400, 'business days': 86400,
  week: 604800, weeks: 604800,
  month: 2592000, months: 2592000
};

/* ==================================================================
   No-code field catalogue
   ------------------------------------------------------------------
   Everything below exists so a business analyst never has to type
   `invoice.amount` or know that `gt` means `>`. The engine still works in
   paths and operators; this table is the translation layer between those and
   the words an operations manager actually uses.
   ================================================================== */

/** Statuses offered wherever a record's state is being tested. */
export const STATUS_VALUES = [
  'Approved', 'Rejected', 'Pending', 'Submitted', 'In review',
  'On hold', 'Paid', 'Cancelled', 'Complete'
];

/** Comparisons, phrased as a person would say them, grouped by field kind. */
export const FRIENDLY_OPERATORS = {
  currency: [
    { op: 'gt', label: 'is more than' },
    { op: 'gte', label: 'is at least' },
    { op: 'lt', label: 'is less than' },
    { op: 'lte', label: 'is at most' },
    { op: 'eq', label: 'is exactly' }
  ],
  number: [
    { op: 'gt', label: 'is more than' },
    { op: 'gte', label: 'is at least' },
    { op: 'lt', label: 'is less than' },
    { op: 'lte', label: 'is at most' },
    { op: 'eq', label: 'is exactly' }
  ],
  choice: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' }
  ],
  text: [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' }
  ],
  duration: [
    { op: 'gt', label: 'is older than' },
    { op: 'lt', label: 'is newer than' }
  ]
};

/** Extra fields that only make sense for particular records. */
const EXTRA_FIELDS = {
  obj_invoice: [
    { suffix: 'vendor', label: 'Vendor', kind: 'text' },
    { suffix: 'poNumber', label: 'PO number', kind: 'text' }
  ],
  obj_contract: [
    { suffix: 'counterparty', label: 'Counterparty', kind: 'text' },
    { suffix: 'termMonths', label: 'Term length', kind: 'number' }
  ],
  obj_expense: [
    { suffix: 'category', label: 'Expense category', kind: 'text' },
    { suffix: 'submitter', label: 'Submitted by', kind: 'text' }
  ],
  obj_candidate: [
    { suffix: 'department', label: 'Department', kind: 'text' },
    { suffix: 'level', label: 'Job level', kind: 'text' }
  ],
  obj_ticket: [
    { suffix: 'priority', label: 'Priority', kind: 'choice', options: ['Critical', 'High', 'Medium', 'Low'] },
    { suffix: 'queue', label: 'Queue', kind: 'text' }
  ],
  obj_refund: [
    { suffix: 'reason', label: 'Refund reason', kind: 'text' }
  ]
};

/** Turn an object id like `obj_invoice` into the path prefix `invoice`. */
function prefixOf(obj) {
  return obj.amountField ? obj.amountField.split('.')[0] : obj.id.replace('obj_', '');
}

/**
 * The selectable fields for one business object, in the order a person would
 * look for them. Amount first, because that is what most rules test.
 */
export function fieldsForObject(obj) {
  const p = prefixOf(obj);
  const fields = [];

  if (obj.amountField) {
    fields.push({ path: obj.amountField, label: 'Amount', kind: 'currency', object: obj.name });
  }
  fields.push({ path: `${p}.status`, label: 'Status', kind: 'choice', options: STATUS_VALUES, object: obj.name });
  for (const extra of EXTRA_FIELDS[obj.id] || []) {
    fields.push({ path: `${p}.${extra.suffix}`, label: extra.label, kind: extra.kind, options: extra.options, object: obj.name });
  }
  fields.push({ path: `${p}.ageDays`, label: 'Age', kind: 'duration', object: obj.name });
  fields.push({ path: `${p}.owner`, label: 'Owner', kind: 'text', object: obj.name });
  return fields;
}

/**
 * Fields to offer for a given utterance: the records actually mentioned come
 * first, then everything else. Showing 13 records' worth of fields to someone
 * writing about invoices is how a "no-code" builder stops being no-code.
 */
export function fieldCatalogue(mentionedObjectIds = []) {
  const mentioned = OBJECTS.filter(o => mentionedObjectIds.includes(o.id));
  const rest = OBJECTS.filter(o => !mentionedObjectIds.includes(o.id));
  const groups = [];
  for (const obj of [...mentioned, ...rest]) {
    groups.push({
      objectId: obj.id,
      label: obj.name.replace(/\b[a-z]/, c => c.toUpperCase()),
      relevant: mentionedObjectIds.includes(obj.id),
      fields: fieldsForObject(obj)
    });
  }
  return groups;
}

/** Look a path back up to its friendly label, for read-back sentences. */
export function describeField(path) {
  for (const obj of OBJECTS) {
    const hit = fieldsForObject(obj).find(f => f.path === path);
    if (hit) return { ...hit, objectLabel: obj.name };
  }
  const parts = String(path).split('.');
  const last = parts[parts.length - 1] || path;
  // `n1.then.outcome` is a human decision, not a data field.
  if (last === 'outcome') return { path, label: 'Decision', kind: 'choice', options: ['Approved', 'Rejected'], objectLabel: 'approval' };
  return {
    path,
    label: last.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()),
    kind: 'text',
    objectLabel: parts[0]
  };
}

/** The words a person uses for an operator, for read-back sentences. */
export function describeOperator(op, kind = 'number') {
  const table = FRIENDLY_OPERATORS[kind] || FRIENDLY_OPERATORS.number;
  const hit = table.find(o => o.op === op)
    || Object.values(FRIENDLY_OPERATORS).flat().find(o => o.op === op);
  return hit ? hit.label : op;
}

/**
 * Status words that appear in an unparsed predicate, so the clarification card
 * can offer "Approved / Rejected" as two buttons instead of a syntax form.
 */
export const STATUS_HINTS = [
  { match: ['approved', 'approval', 'signed off', 'authorised', 'authorized', 'green-lit'], value: 'Approved' },
  { match: ['rejected', 'declined', 'denied', 'turned down'], value: 'Rejected' },
  { match: ['pending', 'waiting', 'outstanding', 'unresolved'], value: 'Pending' },
  { match: ['submitted', 'raised', 'filed', 'lodged'], value: 'Submitted' },
  { match: ['paid', 'settled', 'reimbursed'], value: 'Paid' },
  { match: ['cancelled', 'canceled', 'withdrawn', 'voided'], value: 'Cancelled' },
  { match: ['complete', 'completed', 'finished', 'done', 'closed'], value: 'Complete' },
  { match: ['in review', 'under review', 'being reviewed'], value: 'In review' },
  { match: ['on hold', 'held', 'paused', 'blocked'], value: 'On hold' }
];

/* ==================================================================
   Resilience profiles
   ------------------------------------------------------------------
   A step that names no failure behaviour is worse than a step with a
   conservative default, so the compiler now applies one. What makes a default
   safe is knowing whether the call can be repeated: retrying an idempotent
   upsert is free, retrying a payment can charge someone twice.

   Profiles are per connector *category* rather than per connector, because the
   thing that determines the safe policy is what kind of system it is.
   ================================================================== */

/**
 * `idempotent` — is repeating this call harmless on its own?
 * `requiresIdempotencyKey` — repeating is only safe if the request carries a
 *   stable key the target system deduplicates on.
 * `criticality` — drives how aggressively we retry and how quickly we trip the
 *   circuit breaker. It is about blast radius, not importance.
 */
export const CATEGORY_PROFILE = {
  payments:   { idempotent: false, requiresIdempotencyKey: true,  criticality: 'critical', timeoutSeconds: 15, reversible: true,  reversal: 'refund' },
  erp:        { idempotent: false, requiresIdempotencyKey: true,  criticality: 'high',     timeoutSeconds: 30, reversible: true,  reversal: 'reversing entry' },
  accounting: { idempotent: false, requiresIdempotencyKey: true,  criticality: 'high',     timeoutSeconds: 20, reversible: true,  reversal: 'credit note' },
  p2p:        { idempotent: false, requiresIdempotencyKey: true,  criticality: 'high',     timeoutSeconds: 20, reversible: true,  reversal: 'cancellation' },
  hcm:        { idempotent: true,  requiresIdempotencyKey: false, criticality: 'high',     timeoutSeconds: 20, reversible: true,  reversal: 'corrective update' },
  warehouse:  { idempotent: false, requiresIdempotencyKey: true,  criticality: 'medium',   timeoutSeconds: 60, reversible: true,  reversal: 'delete by key' },
  crm:        { idempotent: true,  requiresIdempotencyKey: false, criticality: 'medium',   timeoutSeconds: 15, reversible: true,  reversal: 'corrective update' },
  storage:    { idempotent: true,  requiresIdempotencyKey: false, criticality: 'medium',   timeoutSeconds: 45, reversible: true,  reversal: 'delete object' },
  esign:      { idempotent: false, requiresIdempotencyKey: true,  criticality: 'medium',   timeoutSeconds: 20, reversible: true,  reversal: 'void envelope' },
  itsm:       { idempotent: false, requiresIdempotencyKey: true,  criticality: 'low',      timeoutSeconds: 15, reversible: true,  reversal: 'close as duplicate' },
  messaging:  { idempotent: false, requiresIdempotencyKey: false, criticality: 'low',      timeoutSeconds: 10, reversible: false, reversal: null },
  email:      { idempotent: false, requiresIdempotencyKey: false, criticality: 'low',      timeoutSeconds: 10, reversible: false, reversal: null }
};

export const DEFAULT_PROFILE = {
  idempotent: false, requiresIdempotencyKey: true, criticality: 'medium',
  timeoutSeconds: 30, reversible: false, reversal: null
};

/**
 * Retry defaults by criticality.
 *
 * Critical systems get *fewer* attempts, not more: hammering a payment gateway
 * that is already failing turns one bad request into a thundering herd, and the
 * cost of a duplicate is far higher than the cost of a human looking at it.
 */
export const RETRY_DEFAULTS = {
  critical: { maxAttempts: 3, backoff: 'exponential', initialIntervalSeconds: 2, backoffCoefficient: 2, maxIntervalSeconds: 30, jitter: 'full', onExhausted: 'dead-letter' },
  high:     { maxAttempts: 4, backoff: 'exponential', initialIntervalSeconds: 2, backoffCoefficient: 2, maxIntervalSeconds: 60, jitter: 'full', onExhausted: 'dead-letter' },
  medium:   { maxAttempts: 4, backoff: 'exponential', initialIntervalSeconds: 1, backoffCoefficient: 2, maxIntervalSeconds: 60, jitter: 'full', onExhausted: 'dead-letter' },
  low:      { maxAttempts: 5, backoff: 'exponential', initialIntervalSeconds: 1, backoffCoefficient: 1.5, maxIntervalSeconds: 30, jitter: 'full', onExhausted: 'alert' }
};

/**
 * Circuit breaker defaults.
 *
 * The breaker exists so a system that is down stops being asked. Critical
 * categories trip after fewer failures and stay open longer, because the
 * failure mode there is duplicate financial side effects rather than a delay.
 */
export const BREAKER_DEFAULTS = {
  critical: { failureThreshold: 3, samplingWindowSeconds: 60,  openSeconds: 300, halfOpenProbes: 1 },
  high:     { failureThreshold: 5, samplingWindowSeconds: 60,  openSeconds: 180, halfOpenProbes: 1 },
  medium:   { failureThreshold: 8, samplingWindowSeconds: 120, openSeconds: 120, halfOpenProbes: 2 },
  low:      { failureThreshold: 12, samplingWindowSeconds: 300, openSeconds: 60, halfOpenProbes: 2 }
};

/**
 * Default deadline for a human step, by seniority.
 *
 * Unlike the retry defaults, this one is a guess at *policy* rather than a
 * technical standard — so the validator still raises it as a warning and asks
 * you to confirm. It exists so the exported blueprint is never silent about
 * time, not because the engine knows your escalation rules.
 */
export const SLA_DEFAULTS = {
  exec:       { seconds: 86400,  businessDays: true, onBreach: 'escalate' },
  senior:     { seconds: 172800, businessDays: true, onBreach: 'escalate' },
  mid:        { seconds: 172800, businessDays: true, onBreach: 'escalate' },
  team:       { seconds: 259200, businessDays: true, onBreach: 'escalate' },
  individual: { seconds: 432000, businessDays: true, onBreach: 'alert' },
  external:   { seconds: 432000, businessDays: true, onBreach: 'alert' }
};
