import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInput,
  canarySchema,
  baseSchema,
  configureSchema,
  prepareCall,
} from '../packages/cli/dist/schema.js';

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

test('catalog is canary-only and metadata snapshot rejects legacy string arrays', () => {
  const catalog = canarySchema.tools.find(
    (tool) => tool.name === 'rodin_list_animation_catalog',
  );
  assert.ok(catalog);
  assert.equal(
    baseSchema.tools.some((tool) => tool.name === catalog.name),
    false,
  );
  assert.throws(
    () => prepareCall(catalog.name, {}, catalog),
    /Unsupported tool/,
  );
  configureSchema(true);
  try {
    assert.deepEqual(prepareCall(catalog.name, {}, catalog).arguments, {});
    assert.throws(
      () => prepareCall(catalog.name, { category: 1 }, catalog),
      /Invalid tool input/,
    );
    assert.throws(
      () => prepareCall(catalog.name, {}, undefined),
      /Tool unavailable/,
    );
    validateInput(catalog.outputSchema, { categories: [] });
    assert.throws(
      () =>
        validateInput(catalog.outputSchema, {
          categories: [{ category: 'human', animations: ['human_000093'] }],
        }),
      /Invalid tool input/,
    );
    const animation = {
      animation_id: 'human_000093',
      category: 'human',
      display_name: 'Walking',
      content_description: 'Walk',
      frames: 31,
      duration_seconds: 1,
      loop: {
        kind: 'none',
        alignment: 'none',
        period_frames: null,
        displacement: [0, 0, 0],
      },
    };
    const value = {
      categories: [{ category: 'human', animations: [animation] }],
    };
    validateInput(catalog.outputSchema, value);
    for (const override of [
      { animation_id: 'Human_000093' },
      { category: 'Human' },
      { category: 'human_sp' },
      { category: '' },
    ]) {
      assert.throws(
        () =>
          validateInput(catalog.outputSchema, {
            categories: [
              {
                category: 'human',
                animations: [{ ...animation, ...override }],
              },
            ],
          }),
        /Invalid tool input/,
      );
    }
    assert.deepEqual(
      prepareCall(catalog.name, { category: 'human_sp' }, catalog).arguments,
      { category: 'human_sp' },
    );
    animation.loop.displacement = [0, 0];
    assert.throws(
      () => validateInput(catalog.outputSchema, value),
      /Invalid tool input/,
    );
  } finally {
    configureSchema(false);
  }
});
