import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadCredentials, createProvider } from './auth.js';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export async function withClient<T>(
  { endpoint, version }: { endpoint: string; version: string },
  action: (client: Client) => Promise<T>,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error(
      'MCP endpoint must use HTTPS (HTTP is allowed for localhost tests).',
    );
  const client = new Client({ name: 'hyper3d-cli', version });
  const credentials = await loadCredentials(endpoint);
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: credentials.clientId
      ? createProvider(endpoint, credentials)
      : undefined,
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
