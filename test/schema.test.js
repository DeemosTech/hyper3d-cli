import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../packages/cli/dist/schema.js';

const base = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['a', 'b'] } },
  required: ['mode'],
  additionalProperties: false,
};
test('validates actual input with remote schema without coercion or defaults', () => {
  validateInput(base, { mode: 'a' });
  assert.throws(() => validateInput(base, { mode: 'c' }), /Invalid tool input/);
  assert.throws(
    () => validateInput(base, { mode: 'a', extra: true }),
    /Invalid tool input/,
  );
  assert.throws(() =>
    validateInput(
      {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      { id: 'wrong' },
    ),
  );
  validateInput(
    { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    {},
  );
});
