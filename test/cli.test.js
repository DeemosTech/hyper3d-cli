import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const executable = fileURLToPath(
  new URL('../packages/cli/dist/index.js', import.meta.url),
);
const exec = promisify(execFile);
test('CLI against real HTTP MCP: named operations, public commands, error exits and no retry', async () => {
  let calls = 0;
  const config = await mkdtemp(join(tmpdir(), 'hyper3d-cli-'));
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({ name: 'fixture', version: '1.0.0' });
    mcp.registerTool(
      'rodin_wait',
      {
        inputSchema: {
          generation_id: z.string(),
          timeout_seconds: z.number().int().min(1).max(45),
        },
      },
      async () => {
        calls++;
        return {
          content: [{ type: 'text', text: 'test failure' }],
          isError: true,
        };
      },
    );
    mcp.registerTool(
      'rodin_generate',
      {
        inputSchema: {
          prompt: z.string(),
          tier: z.enum(['Future']).optional(),
        },
      },
      async ({ prompt }) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ generation_id: 'test-generation', prompt }),
          },
        ],
      }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      let body = '';
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(
        req,
        res,
        body ? JSON.parse(body) : undefined,
      );
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      await transport.close();
      await mcp.close();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const run = async (args) => {
    try {
      return {
        ...(await exec(
          process.execPath,
          [executable, '--base-url', endpoint.replace(/\/mcp$/, ''), ...args],
          {
            env: {
              ...process.env,
              HYPER3D_CONFIG_DIR: config,
              HYPER3D_RELEASE_POLICY_URL: '',
              CI: '1',
            },
            timeout: 15000,
          },
        )),
        code: 0,
      };
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  try {
    const help = await run(['--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /^\s+(tools|schema)(?:\s|$)/m);
    assert.match(help.stdout, /--output <format>/);
    assert.doesNotMatch(help.stdout, /--schema-version/);
    const generated = await run([
      'generate',
      '--prompt',
      'a cat',
      '--tier',
      'Future',
    ]);
    assert.equal(generated.code, 0, generated.stderr);
    assert.match(generated.stdout, /^Generation ID: test-generation$/m);
    assert.match(generated.stdout, /^Prompt: a cat$/m);
    assert.match(generated.stderr, /accepted by the server/);
    assert.equal(generated.stderr.match(/accepted by the server/g)?.length, 1);
    const generatedJson = await run([
      'generate',
      '--prompt',
      'a cat',
      '--tier',
      'Future',
      '--output',
      'json',
    ]);
    assert.equal(generatedJson.code, 0, generatedJson.stderr);
    assert.equal(JSON.parse(generatedJson.stdout).prompt, 'a cat');
    const invalidOutput = await run([
      'generate',
      '--prompt',
      'a cat',
      '--output',
      'yaml',
    ]);
    assert.equal(invalidOutput.code, 1);
    assert.match(invalidOutput.stderr, /Allowed choices are human, json/);
    const unsupported = await run([
      '--schema-version',
      'v1',
      'generate',
      '--prompt',
      'a cat',
    ]);
    assert.equal(unsupported.code, 1);
    assert.match(unsupported.stderr, /unknown option '--schema-version'/);
    const failed = await run([
      'poll',
      'd1bb98f2-48be-4be1-9818-d49de002497a',
      '--timeout',
      '90',
    ]);
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stderr, /test failure/);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(config, { recursive: true, force: true });
  }
});
