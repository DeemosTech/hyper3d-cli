import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  createProvider,
  credentialPath,
  loadCredentials,
  logout,
} from '../packages/cli/dist/auth.js';

const run = promisify(execFile);
const initial = {
  access_token: 'old-access',
  refresh_token: 'old-refresh',
  token_type: 'Bearer',
  expires_in: 1,
};
async function isolated(action) {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-refresh-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  try {
    await action(directory);
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR;
    else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function metadata(input, endpoint) {
  const url = new URL(input);
  if (url.pathname.includes('oauth-protected-resource'))
    return { resource: endpoint, authorization_servers: [url.origin] };
  if (url.pathname.includes('oauth-authorization-server'))
    return {
      issuer: url.origin,
      token_endpoint: `${url.origin}/token`,
      authorization_endpoint: `${url.origin}/authorize`,
      response_types_supported: ['code'],
      grant_types_supported: ['refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
    };
}

const childScript = `
  import { accountInfo } from './packages/cli/dist/account.js';
  import { configureEndpoints } from './packages/cli/dist/endpoints.js';
  import { withClient } from './packages/cli/dist/mcp.js';
  const [mode, base] = process.argv.slice(1);
  configureEndpoints(base);
  if (mode === 'account') await accountInfo();
  else await withClient({ endpoint: base + '/mcp', version: 'test' }, async client => { await client.listTools(); });
`;

test('independent account and MCP processes refresh once and share the rotated credentials', () =>
  isolated(async (directory) => {
    let endpoint;
    let refreshes = 0;
    const waiting = [];
    const errors = [];
    const server = createServer(async (req, res) => {
      const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      try {
        const url = new URL(req.url, endpoint);
        const document = metadata(url, endpoint);
        if (document) return send(document);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        if (url.pathname === '/token') {
          refreshes++;
          assert.equal(
            new URLSearchParams(body).get('refresh_token'),
            'old-refresh',
          );
          await sleep(100);
          return send({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        if (req.headers.authorization !== 'Bearer new-access') {
          // All four processes loaded old credentials before any refresh starts.
          waiting.push(() => send({ error: 'unauthorized' }, 401));
          if (waiting.length === 4)
            waiting.splice(0).forEach((reply) => reply());
          return;
        }
        if (url.pathname === '/api/user/get_info')
          return send({
            meta: {
              user_uuid: 'fixture',
              username: 'Fixture',
              balance: 0,
              frozen: 0,
              subscriptions: { active_subscriptions: [] },
            },
            billing_workspace: { type: 'personal' },
          });
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const message = JSON.parse(body);
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              }
            : { tools: [] };
        return send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        errors.push(error);
        send({ error: 'fixture failed' }, 500);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    endpoint = `${base}/mcp`;
    try {
      await createProvider(endpoint, {}).saveTokens(initial);
      await Promise.all(
        ['account', 'mcp', 'account', 'mcp'].map((mode) =>
          run(
            process.execPath,
            ['--input-type=module', '--eval', childScript, mode, base],
            { timeout: 25000 },
          ),
        ),
      );
      assert.deepEqual(errors, []);
      assert.equal(refreshes, 1);
      assert.equal(
        (await loadCredentials(endpoint)).tokens.refresh_token,
        'new-refresh',
      );
      assert.equal((await readdir(directory)).length, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test('network and malformed-response failures release the lock and preserve the last saved token', () =>
  isolated(async (directory) => {
    const endpoint = 'https://fixture.example/mcp';
    await createProvider(endpoint, {}).saveTokens(initial);
    for (const failure of ['network', 'malformed', 'http']) {
      const provider = createProvider(
        endpoint,
        await loadCredentials(endpoint),
        async (input) => {
          const document = metadata(input, endpoint);
          if (document) return Response.json(document);
          if (failure === 'network') throw new TypeError('network failed');
          return Response.json(
            failure === 'malformed' ? {} : { error: 'server_error' },
            { status: failure === 'http' ? 503 : 200 },
          );
        },
      );
      await assert.rejects(
        auth(provider, { serverUrl: endpoint, fetchFn: provider.fetch }),
      );
      assert.equal(
        (await loadCredentials(endpoint)).tokens.refresh_token,
        'old-refresh',
      );
      assert.equal((await readdir(directory)).length, 1);
    }
  }));

test('a killed lock owner leaves an expirable lock that a later process can recover', () =>
  isolated(async (directory) => {
    const endpoint = 'https://fixture.example/mcp';
    await createProvider(endpoint, {}).saveTokens(initial);
    const path = credentialPath(endpoint);
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
    import { lock } from 'proper-lockfile';
    await lock(process.argv[1], { realpath: false, stale: 60000, update: 10000 });
    console.log('locked');
    setInterval(() => {}, 1000);
  `,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    try {
      const [message] = await once(child.stdout, 'data');
      assert.match(message.toString(), /locked/);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    // Advance just the dead lock's filesystem timestamp, not the global clock.
    const past = new Date(Date.now() - 120000);
    await utimes(`${path}.lock`, past, past);
    await logout(endpoint);
    assert.deepEqual(await readdir(directory), []);
  }));

test('a stale provider cannot restore credentials removed by logout', () =>
  isolated(async () => {
    const endpoint = 'https://fixture.example/mcp';
    await createProvider(endpoint, {}).saveTokens(initial);
    let tokenRequests = 0;
    const provider = createProvider(
      endpoint,
      await loadCredentials(endpoint),
      async (input) => {
        const document = metadata(input, endpoint);
        if (document) return Response.json(document);
        tokenRequests++;
        throw new Error('unexpected token request');
      },
    );
    await logout(endpoint);
    await assert.rejects(
      auth(provider, { serverUrl: endpoint, fetchFn: provider.fetch }),
      /removed/,
    );
    assert.equal(tokenRequests, 0);
    assert.deepEqual(await loadCredentials(endpoint), {});
  }));

test('concurrent refreshes on one provider share a response and delayed SDK saves cannot undo logout', () =>
  isolated(async () => {
    const endpoint = 'https://fixture.example/mcp';
    await createProvider(endpoint, {}).saveTokens(initial);
    let requests = 0;
    const provider = createProvider(
      endpoint,
      await loadCredentials(endpoint),
      async () => {
        requests++;
        await sleep(25);
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      },
    );
    const bodies = await Promise.all([
      provider.prepareTokenRequest(),
      provider.prepareTokenRequest(),
    ]);
    const responses = await Promise.all(
      bodies.map((body) =>
        provider.fetch('https://fixture.example/token', {
          method: 'POST',
          body,
        }),
      ),
    );
    const tokens = await Promise.all(
      responses.map((response) => response.json()),
    );
    assert.equal(requests, 1);
    assert.equal(tokens[0].refresh_token, 'new-refresh');
    assert.equal(tokens[1].refresh_token, 'new-refresh');
    await logout(endpoint);
    await provider.saveTokens(tokens[0]);
    await provider.saveTokens(tokens[1]);
    assert.deepEqual(await loadCredentials(endpoint), {});
  }));

test('a compromised lock aborts refresh and does not remove its replacement or overwrite credentials', () =>
  isolated(async () => {
    const endpoint = 'https://fixture.example/mcp';
    await createProvider(endpoint, {}).saveTokens(initial);
    const lockPath = `${credentialPath(endpoint)}.lock`;
    const provider = createProvider(
      endpoint,
      await loadCredentials(endpoint),
      async (_input, init) => {
        await rm(lockPath, { recursive: true });
        await mkdir(lockPath);
        const past = new Date(Date.now() - 120000);
        await utimes(lockPath, past, past);
        await sleep(20000, undefined, { signal: init.signal });
        throw new Error('expected lock compromise to abort the request');
      },
    );
    await assert.rejects(
      provider.fetch('https://fixture.example/token', {
        method: 'POST',
        body: await provider.prepareTokenRequest(),
      }),
      { name: 'AbortError' },
    );
    assert.deepEqual(await readdir(lockPath), []);
    assert.equal(
      (await loadCredentials(endpoint)).tokens.refresh_token,
      'old-refresh',
    );
  }));
