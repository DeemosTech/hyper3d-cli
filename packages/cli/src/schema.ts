import { readFile } from 'node:fs/promises';

import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import type { Payload } from './types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const baseSchema: { tools: Tool[] } = JSON.parse(
  await readFile(new URL('./base_schema.json', import.meta.url), 'utf8'),
);

export const canarySchema: { tools: Tool[] } | undefined = await readFile(
  new URL('./canary_schema.json', import.meta.url),
  'utf8',
)
  .then((text) => JSON.parse(text))
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });

export type SchemaVersion = 'default' | 'canary';
export function schemaFor(version: SchemaVersion = 'default') {
  if (version === 'default') return baseSchema;
  if (!canarySchema)
    throw new Error('This CLI does not include a canary schema');
  return canarySchema;
}

export function validateInput(schema: Payload, value: unknown) {
  const Constructor = schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new Constructor({
    strict: false,
    allErrors: true,
    validateFormats: true,
  });
  (addFormats as unknown as (instance: Ajv) => void)(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value))
    throw new Error(`Invalid tool input: ${ajv.errorsText(validate.errors)}`);
}

export function prepareCall(
  name: string,
  input: Payload,
  remote: Tool | undefined,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`warning: ${message}\n`),
  version: SchemaVersion = 'default',
) {
  const tool = schemaFor(version).tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`Unsupported tool: ${name} (${version} schema)`);
  if (!remote) throw new Error(`Tool unavailable: ${name}`);
  validateInput(remote.inputSchema, input);
  try {
    validateInput(tool.inputSchema, input);
  } catch {
    warn(
      `${name}: input differs from selected bundled schema but is accepted by the server`,
    );
  }
  return { name, arguments: input };
}
