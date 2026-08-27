/**
 * schema-lite.js — a small JSON Schema (2020-12 subset) validator.
 *
 * Supports exactly what schema/workflow.v1.schema.json uses: type, required,
 * properties, additionalProperties:false, items, enum, const, pattern,
 * minItems, minLength, minimum, $ref into $defs, and anyOf-free unions
 * expressed as type arrays. It is deliberately small so the test suite has no
 * dependency to install — it is not a general-purpose validator.
 */

const TYPEOF = {
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: v => typeof v === 'string',
  number: v => typeof v === 'number',
  integer: v => Number.isInteger(v),
  boolean: v => typeof v === 'boolean',
  null: v => v === null
};

export function validateSchema(schema, data) {
  const errors = [];
  walk(schema, data, '$', schema, errors);
  return { valid: errors.length === 0, errors };
}

function resolve(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((acc, k) => acc[k], root);
}

function walk(schema, data, path, root, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) return walk(resolve(schema.$ref, root), data, path, root, errors);

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => TYPEOF[t]?.(data))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`);
      return;
    }
  }

  if (schema.const !== undefined && data !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
  }
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: ${JSON.stringify(data)} not in enum [${schema.enum.map(e => JSON.stringify(e)).join(', ')}]`);
  }
  if (schema.pattern && typeof data === 'string' && !new RegExp(schema.pattern).test(data)) {
    errors.push(`${path}: "${data}" does not match /${schema.pattern}/`);
  }
  if (schema.minLength != null && typeof data === 'string' && data.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (schema.minimum != null && typeof data === 'number' && data < schema.minimum) {
    errors.push(`${path}: ${data} below minimum ${schema.minimum}`);
  }

  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) {
      errors.push(`${path}: ${data.length} items, minItems ${schema.minItems}`);
    }
    if (schema.items) data.forEach((v, i) => walk(schema.items, v, `${path}[${i}]`, root, errors));
    return;
  }

  if (TYPEOF.object(data)) {
    for (const key of schema.required || []) {
      if (!(key in data)) errors.push(`${path}: missing required "${key}"`);
    }
    const props = schema.properties || {};
    for (const [key, value] of Object.entries(data)) {
      if (props[key]) {
        walk(props[key], value, `${path}.${key}`, root, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}
