import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
// Open server payloads retain fields unknown to the bundled schema.
export type Payload = Record<string, any>;
export interface PackageInfo {
  name: string;
  version: string;
  private?: boolean;
}
export interface Credentials {
  clientId?: string;
  tokens?: OAuthTokens;
  expiresAt?: number;
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
