import { readFile } from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadCredentials, createProvider } from './auth.js';
import { endpoints, secureUrl } from './endpoints.js';
import { prepareCall } from './schema.js';

import type { Payload, ToolClient } from './types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const { version } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

export async function withClient<T>(
  { endpoint, version }: { endpoint: string; version: string },
  action: (client: Client) => Promise<T>,
) {
  const url = secureUrl(endpoint);
  const client = new Client({ name: 'hyper3d-cli', version });
  const credentials = await loadCredentials(endpoint);
  const provider = credentials.clientId
    ? createProvider(endpoint, credentials)
    : undefined;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { 'X-Hyper3D-CLI-Version': version } },
    authProvider: provider,
    fetch: provider?.fetch,
  });
  try {
    await client.connect(transport, { timeout: 15000 });
    return await action(client);
  } finally {
    await client.close();
  }
}

export async function listTools(client: Client) {
  const tools: Tool[] = [],
    seen = new Set<string | undefined>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, {
      timeout: 15000,
    });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor))
      throw new Error('MCP returned a repeated pagination cursor');
    seen.add(cursor);
    if (seen.size > 100) throw new Error('MCP tool pagination limit exceeded');
  } while (cursor);
  return tools;
}

export interface ToolContext {
  client: ToolClient;
  remoteTools: Tool[];
}

// A workflow owns one connection; an injected context remains caller-owned.
export async function withToolContext<T>(
  action: (context: ToolContext) => Promise<T>,
  context?: ToolContext,
): Promise<T> {
  if (context) return action(context);
  return withClient({ endpoint: endpoints.mcp, version }, async (client) =>
    action({ client, remoteTools: await listTools(client) }),
  );
}

function cliResult(data: Payload): Payload {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = { ...data };
  delete result.display_url;
  return result;
}

export function resultData(result: CallToolResult): Payload {
  if (result.isError)
    throw new Error(
      `Operation failed: ${
        result.content
          ?.filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n') || 'server returned an error'
      }`,
    );
  if (result.structuredContent) return cliResult(result.structuredContent);
  for (const item of result.content ?? []) {
    if (item.type === 'text') {
      try {
        return cliResult(JSON.parse(item.text));
      } catch {
        /* Try the next text block. */
      }
    }
  }
  throw new Error('Server returned no structured operation result');
}

function updateHint(error: unknown) {
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\nCheck for updates: hyper3d update --check. The operation was not retried.`,
    { cause: error },
  );
}

async function call(context: ToolContext, name: string, input: Payload) {
  try {
    const request = prepareCall(
      name,
      input,
      context.remoteTools.find((tool) => tool.name === name),
    );
    // Submit once; a failed or timed-out call may already have created a task.
    const response = await context.client.callTool(request, undefined, {
      timeout: 60000,
    });
    return resultData(response as CallToolResult);
  } catch (error) {
    throw updateHint(error);
  }
}

export interface GenerateInput {
  prompt?: string;
  reference_upload_ids?: string[];
  mesh_mode?: string;
  tier?: string;
  quality_override?: number;
  texture_delight?: boolean;
  geometry_file_format?: string;
}

export function validateGenerate(context: ToolContext, input: GenerateInput) {
  prepareCall(
    'rodin_generate',
    input,
    context.remoteTools.find((tool) => tool.name === 'rodin_generate'),
    () => {},
  );
}

export async function rodinCreateUploads(
  context: ToolContext,
  input: {
    files: { filename: string; mime_type: string; size_bytes: number }[];
  },
) {
  return call(context, 'rodin_create_uploads', input);
}

export async function rodinImportImages(
  context: ToolContext,
  input: {
    images: {
      download_url: string;
      file_id: string;
      mime_type?: string;
      file_name?: string;
    }[];
  },
) {
  return call(context, 'rodin_import_images', input);
}

export async function rodinGenerate(
  context: ToolContext,
  input: GenerateInput,
) {
  return call(context, 'rodin_generate', input);
}

export async function rodinGenerateBang(
  context: ToolContext,
  input: {
    asset_id: string;
    instruction?: string;
    strength?: number;
    explode_strength?: number;
    escore?: number;
    reference_scale?: number;
    seed?: number;
    geometry_file_format?: string;
    resolution?: string;
  },
) {
  return call(context, 'rodin_generate_bang', input);
}

export async function rodinGetStatus(
  context: ToolContext,
  input: { generation_id: string },
) {
  return call(context, 'rodin_get_status', input);
}

export async function rodinWait(
  context: ToolContext,
  input: { generation_id: string; timeout_seconds?: number },
) {
  return call(context, 'rodin_wait', input);
}

export async function rodinGetResult(
  context: ToolContext,
  input: { generation_id: string },
) {
  return call(context, 'rodin_get_result', input);
}
