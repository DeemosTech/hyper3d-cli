import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const annotations = new Set(['description', 'title', '$comment', 'examples']);
export function canonical(value, keyword = '', literal = false) {
  literal ||= ['const', 'enum', 'default'].includes(keyword);
  if (Array.isArray(value)) {
    const items = value.map(v => canonical(v, '', literal));
    return ['required', 'enum', 'type'].includes(keyword)
      ? items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : items;
  }
  if (value && typeof value === 'object') {
    // Property names may themselves be "description" or "title".
    const map = ['properties', '$defs', 'definitions', 'patternProperties'].includes(keyword);
    return Object.fromEntries(Object.keys(value).sort()
      .filter(k => literal || map || !annotations.has(k))
      .map(k => [k, canonical(value[k], map ? '' : k, literal)]));
  }
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Conservative input compatibility analysis. Unsupported changes remain unknown.
export function compareInput(before, after, path = '$') {
  if (equal(before, after)) return [];
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object')
    return [{severity: 'unknown', path, reason: 'schema changed'}];
  const changes = [];
  const add = (severity, reason, at = path) => changes.push({severity, path: at, reason});
  if (!equal(before.type, after.type)) add('unknown', 'type changed');
  for (const name of after.required ?? [])
    if (!(before.required ?? []).includes(name)) add('breaking', 'new required property', `${path}.${name}`);
  if (after.enum && (!before.enum || before.enum.some(v => !after.enum.some(w => equal(v, w)))))
    add('breaking', 'accepted enum values narrowed');
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!Object.hasOwn(after.properties ?? {}, name)) add('unknown', 'property removed', `${path}.${name}`);
    else changes.push(...compareInput(schema, after.properties[name], `${path}.${name}`));
  }
  for (const name of Object.keys(after.properties ?? {})) {
    if (!Object.hasOwn(before.properties ?? {}, name) && before.additionalProperties !== false)
      add('unknown', 'new property constrains previously unrestricted input', `${path}.${name}`);
  }
  const handled = new Set(['type', 'required', 'enum', 'properties']);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (handled.has(key) || annotations.has(key)) continue;
    if (!equal(before[key], after[key])) add('unknown', `${key} changed`);
  }
  return changes;
}

export function compareTool(before, after) {
  if (!after) return [{severity: 'breaking', path: '$', reason: 'tool unavailable (removed or not authorized)'}];
  if (!before) return [];
  const changes = compareInput(before.inputSchema, after.inputSchema);
  if (!equal(before.outputSchema, after.outputSchema))
    changes.push({severity: 'unknown', path: '$output', reason: 'output schema changed'});
  return changes;
}

export function validateInput(schema, value) {
  const Constructor = schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new Constructor({strict: false, allErrors: true, validateFormats: true});
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`Invalid tool input: ${ajv.errorsText(validate.errors)}`);
}
