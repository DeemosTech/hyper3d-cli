import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
// Open server payloads retain fields unknown to the bundled schema.
export type Payload = Record<string, any>;
export interface PackageInfo {
  name: string;
  version: string;
  private?: boolean;
  hyper3d?: { releasePolicyUrl?: string };
}
export interface Credentials {
  clientId?: string;
  tokens?: OAuthTokens;
  expiresAt?: number;
}
export interface Contract {
  version: string;
  schema: { schemaVersion: string; tools: Tool[] };
  implementation: {
    prepareInput: (
      tool: Tool,
      input: Payload,
    ) => { name: string; arguments: Payload };
    readResult: (result: CallToolResult) => CallToolResult;
  };
}
export type ToolClient = Pick<Client, 'callTool'>;
export interface GenerateOptions {
  image?: string[];
  prompt?: string;
  tier?: string;
  meshMode?: string;
  format?: string;
  quality?: number;
}
export interface Change {
  severity: string;
  path: string;
  reason: string;
}
