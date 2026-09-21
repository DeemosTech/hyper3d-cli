import type { Payload } from '../../types.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// v1 uses the MCP wire format directly. Compatible enum additions need no adapter.
export function prepareInput(tool: Tool, input: Payload) {
  return { name: tool.name, arguments: input };
}

export function readResult(result: CallToolResult) {
  return result;
}
