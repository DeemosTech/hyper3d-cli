import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {z} from 'zod';

const executable = fileURLToPath(new URL('../packages/cli/src/index.js', import.meta.url));
const exec = promisify(execFile);
test('CLI against real HTTP MCP: discovery, validation, drift warning, error exits and no retry', async () => {
  let calls = 0;
  const config = await mkdtemp(join(tmpdir(), 'hyper3d-cli-'));
  const server = createServer(async (req, res) => {
    const mcp = new McpServer({name: 'fixture', version: '1.0.0'});
    mcp.registerTool('rodin_wait', {inputSchema: {generation_id: z.string(), new_required: z.number()}}, async () => {
      calls++;
      return {content: [{type: 'text', text: 'test failure'}], isError: true};
    });
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    try {
      await mcp.connect(transport);
      let body = '';
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch { if (!res.headersSent) res.writeHead(500).end(); }
    finally { await transport.close(); await mcp.close(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  const run = async args => {
    try { return {...await exec(process.execPath, [executable, '--endpoint', endpoint, ...args], {env: {...process.env, HYPER3D_ACCESS_TOKEN: '', HYPER3D_CONFIG_DIR: config, HYPER3D_RELEASE_POLICY_URL: '', CI: '1'}, timeout: 15000}), code: 0}; }
    catch (error) { return {stdout: error.stdout, stderr: error.stderr, code: error.code}; }
  };
  try {
    const list = await run(['tools', 'list']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(JSON.parse(list.stdout)[0].name, 'rodin_wait');
    const invalid = await run(['tools', 'call', 'rodin_wait', '--json', '{"generation_id":"x"}']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /new required property/);
    assert.match(invalid.stderr, /Invalid tool input/);
    assert.equal(calls, 0);
    const failed = await run(['tools', 'call', 'rodin_wait', '--json', '{"generation_id":"x","new_required":1}']);
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).isError, true);
    assert.equal(calls, 1);
    const check = await run(['schema', 'check']);
    assert.equal(check.code, 2);
    assert.ok(JSON.parse(check.stdout).changes.length > 0);
    const snapshot = join(config, 'candidate.json');
    assert.equal((await run(['schema', 'snapshot', '--out', snapshot])).code, 0);
    assert.equal((await run(['schema', 'snapshot', '--out', snapshot])).code, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(config, {recursive: true, force: true});
  }
});
