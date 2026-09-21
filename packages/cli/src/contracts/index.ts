import { readFile } from 'node:fs/promises';

import { validateInput } from '../schema.js';

import * as current from './v1/implementation.js';

import type { Contract, Payload, ToolClient } from '../types.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const supported = [{ version: 'v1', implementation: current }];
if (supported.length > 2)
  throw new Error('A CLI release may bundle at most two contract generations');
const contracts = new Map<string, Contract>();
// Add a previous/current pair when a genuinely different wire contract exists.
// Keep at most two supported generations, each with its own implementation.
for (const { version, implementation } of supported) {
  const schema = JSON.parse(
    await readFile(
      new URL(`./${version}/schema.json`, import.meta.url),
      'utf8',
    ),
  );
  if (schema.schemaVersion !== version)
    throw new Error(`Contract version mismatch: ${version}`);
  contracts.set(version, { version, schema, implementation });
}

const currentContract = supported.at(-1);
if (!currentContract) throw new Error('No supported operation contracts');
export const currentContractVersion = currentContract.version;

export function getContract(version = currentContractVersion) {
  const contract = contracts.get(version);
  if (!contract)
    throw new Error(
      `Unsupported schema version: ${version}. Supported: ${[...contracts.keys()].join(', ')}`,
    );
  return contract;
}

export function listContracts() {
  return [...contracts.values()].map(({ version, schema }) => ({
    version,
    status: version === currentContractVersion ? 'current' : 'previous',
    tools: schema.tools.map((t) => t.name),
  }));
}

export function prepareCall(
  contract: Contract,
  name: string,
  input: Payload,
  remote: Tool | undefined,
  warn: (message: string) => void = (message) =>
    process.stderr.write(`warning: ${message}\n`),
) {
  const tool = contract.schema.tools.find((t) => t.name === name);
  if (!tool)
    throw new Error(
      `Tool ${name} is not supported by schema ${contract.version}`,
    );
  if (!remote) throw new Error(`Tool unavailable: ${name}`);
  const request = contract.implementation.prepareInput(tool, input);
  validateInput(remote.inputSchema, request.arguments);
  try {
    validateInput(tool.inputSchema, input);
  } catch {
    warn(
      `${name}: input differs from bundled ${contract.version} schema but is accepted by the server`,
    );
  }
  return request;
}

export async function callContract(
  client: ToolClient,
  contract: Contract,
  name: string,
  input: Payload,
  remote: Tool | undefined,
) {
  const request = prepareCall(contract, name, input, remote);
  // Exactly one call; never retry or fall back after a potentially billable request.
  const result = await client.callTool(request, undefined, { timeout: 60000 });
  return contract.implementation.readResult(result as CallToolResult);
}
