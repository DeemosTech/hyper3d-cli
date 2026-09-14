import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical, compareTool, compareInput, validateInput} from '../packages/cli/src/schema.js';

const base = {type: 'object', properties: {mode: {type: 'string', enum: ['a', 'b']}}, required: ['mode'], additionalProperties: false};
test('ignores descriptions and ordering but preserves property names', () => {
  const other = {...base, description: 'new prose', properties: {mode: {enum: ['b', 'a'], type: 'string'}}};
  assert.deepEqual(compareInput(base, other), []);
  assert.ok(canonical({properties: {description: {type: 'string'}}}).properties.description);
  assert.notDeepEqual(canonical({const: {title: 'a'}}), canonical({const: {title: 'b'}}));
});
test('new optional properties are compatible; required additions and enum narrowing are not', () => {
  assert.deepEqual(compareInput(base, {...base, properties: {...base.properties, extra: {type: 'number'}}}), []);
  assert.equal(compareInput(base, {...base, required: ['mode', 'extra']})[0].severity, 'breaking');
  assert.equal(compareInput(base, {...base, properties: {mode: {type: 'string', enum: ['a']}}})[0].severity, 'breaking');
});
test('new constraints on unrestricted properties remain unknown', () => {
  assert.equal(compareInput({type: 'object'}, {type: 'object', properties: {extra: {type: 'number'}}})[0].severity, 'unknown');
});
test('complex changes and output changes are unknown; missing tool is unavailable', () => {
  assert.equal(compareInput(base, {...base, anyOf: [{required: ['mode']}]})[0].severity, 'unknown');
  assert.equal(compareTool({inputSchema: base}, {inputSchema: base, outputSchema: {type: 'object'}})[0].path, '$output');
  assert.equal(compareTool({}, undefined)[0].severity, 'breaking');
});
test('validates actual input with remote schema without coercion or defaults', () => {
  validateInput(base, {mode: 'a'});
  assert.throws(() => validateInput(base, {mode: 'c'}), /Invalid tool input/);
  assert.throws(() => validateInput(base, {mode: 'a', extra: true}), /Invalid tool input/);
  assert.throws(() => validateInput({type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}, {id: 'wrong'}));
  validateInput({$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object'}, {});
});
