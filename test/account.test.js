import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountInfo } from '../packages/cli/dist/account.js';
import {
  createProvider,
  loadCredentials,
  logout,
  CLI_CLIENT_ID,
} from '../packages/cli/dist/auth.js';

const baseUrl = 'https://api.example.com/api';
const endpoint = `${baseUrl}/mcp`;
const user = {
  user_uuid: 'user-1',
  username: 'fixture',
  balance: 125,
  frozen: 5,
  subscriptions: {
    active_subscriptions: [{ wallet_balance: 40 }, { wallet_balance: 60 }],
  },
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-account-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR;
    else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('account status without credentials makes no network requests', () =>
  isolated(async () => {
    assert.deepEqual(
      await accountInfo(baseUrl, {
        fetchFn: () => assert.fail('unexpected request'),
      }),
      { authenticated: false },
    );
  }));

test('personal account status uses the account HTTP API and its authorized wallet', () =>
  isolated(async () => {
    await createProvider(endpoint, {}).saveTokens({
      access_token: 'fixture-token',
      token_type: 'Bearer',
    });
    const calls = [];
    const result = await accountInfo(`${baseUrl}/`, {
      fetchFn: async (input, init) => {
        calls.push(new URL(input).href);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer fixture-token');
        assert.deepEqual(JSON.parse(init.body), {});
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        return json({ meta: user, billing_workspace: { type: 'personal' } });
      },
    });
    assert.deepEqual(calls, ['https://api.example.com/api/user/get_info']);
    assert.deepEqual(result, {
      authenticated: true,
      user: { uuid: 'user-1', username: 'fixture' },
      wallet: {
        type: 'personal',
        balance: 12.5,
        subscription_balance: 10,
        frozen: 0.5,
      },
    });
  }));

test('team account status requests only the team bound to the grant', () =>
  isolated(async () => {
    await createProvider(endpoint, {}).saveTokens({
      access_token: 'fixture-token',
      token_type: 'Bearer',
    });
    const calls = [];
    const result = await accountInfo(baseUrl, {
      fetchFn: async (input, init) => {
        calls.push([new URL(input).pathname, JSON.parse(init.body)]);
        return calls.length === 1
          ? json({
              meta: user,
              billing_workspace: { type: 'group', group_uuid: 'team-1' },
            })
          : json({
              group_meta: { uuid: 'team-1', name: 'Fixture team', frozen: 9 },
              balance: 800,
            });
      },
    });
    assert.deepEqual(calls, [
      ['/api/user/get_info', {}],
      ['/api/group/group_info', { group_uuid: 'team-1' }],
    ]);
    assert.deepEqual(result.wallet, {
      type: 'group',
      group_uuid: 'team-1',
      name: 'Fixture team',
      balance: 80,
      frozen: 0.9,
    });
  }));

test('account status reports HTTP, server and network errors without treating them as logout', () =>
  isolated(async () => {
    await createProvider(endpoint, {}).saveTokens({
      access_token: 'fixture-token',
      token_type: 'Bearer',
    });
    for (const [status, message] of [
      [401, /Account access denied/],
      [403, /Account access denied/],
      [500, /HTTP 500/],
    ]) {
      let calls = 0;
      await assert.rejects(
        accountInfo(baseUrl, {
          fetchFn: async () => {
            calls++;
            return json({}, status);
          },
        }),
        message,
      );
      assert.equal(calls, 1);
    }
    await assert.rejects(
      accountInfo(baseUrl, {
        fetchFn: async () => json({ error: 'fixture error' }),
      }),
      /fixture error/,
    );
    await assert.rejects(
      accountInfo(baseUrl, {
        fetchFn: async () => {
          throw new TypeError('offline');
        },
      }),
      /offline/,
    );
  }));

test('account status rejects missing workspace, invalid identity and invalid wallet balances', () =>
  isolated(async () => {
    await createProvider(endpoint, {}).saveTokens({
      access_token: 'fixture-token',
      token_type: 'Bearer',
    });
    for (const [body, message] of [
      [{ meta: user }, /authorized billing workspace/],
      [
        {
          meta: { ...user, user_uuid: '' },
          billing_workspace: { type: 'personal' },
        },
        /Invalid user information/,
      ],
      [
        {
          meta: { ...user, balance: '125' },
          billing_workspace: { type: 'personal' },
        },
        /valid balance/,
      ],
      [
        {
          meta: { ...user, subscriptions: null },
          billing_workspace: { type: 'personal' },
        },
        /valid subscription balances/,
      ],
      [
        {
          meta: {
            ...user,
            subscriptions: { active_subscriptions: [{ wallet_balance: null }] },
          },
          billing_workspace: { type: 'personal' },
        },
        /valid subscription balances/,
      ],
      [
        {
          meta: { ...user, frozen: null },
          billing_workspace: { type: 'personal' },
        },
        /valid balance/,
      ],
    ])
      await assert.rejects(
        accountInfo(baseUrl, { fetchFn: async () => json(body) }),
        message,
      );
    let calls = 0;
    await assert.rejects(
      accountInfo(baseUrl, {
        fetchFn: async () =>
          ++calls === 1
            ? json({
                meta: user,
                billing_workspace: { type: 'group', group_uuid: 'team-1' },
              })
            : json({
                group_meta: { uuid: 'other-team', frozen: 0 },
                balance: 800,
              }),
      }),
      /does not match/,
    );
  }));

test('account status refreshes stored credentials once and retries with the new access token', () =>
  isolated(async () => {
    const issuer = 'https://auth.example.com';
    await createProvider(endpoint, {}).saveTokens({
      access_token: 'expired',
      refresh_token: 'refresh',
      token_type: 'Bearer',
    });
    let accountCalls = 0,
      refreshCalls = 0;
    const result = await accountInfo(baseUrl, {
      fetchFn: async (input, init) => {
        const url = new URL(input);
        if (url.pathname.includes('oauth-protected-resource'))
          return json({ resource: endpoint, authorization_servers: [issuer] });
        if (url.pathname.includes('oauth-authorization-server'))
          return json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            response_types_supported: ['code'],
            grant_types_supported: ['refresh_token'],
          });
        if (url.href === `${issuer}/token`) {
          refreshCalls++;
          const params = new URLSearchParams(init.body);
          assert.equal(params.get('grant_type'), 'refresh_token');
          assert.equal(params.get('refresh_token'), 'refresh');
          assert.equal(params.get('client_id'), CLI_CLIENT_ID);
          return json({
            access_token: 'renewed',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        }
        assert.equal(url.pathname, '/api/user/get_info');
        accountCalls++;
        assert.equal(
          init.headers.Authorization,
          `Bearer ${accountCalls === 1 ? 'expired' : 'renewed'}`,
        );
        return accountCalls === 1
          ? json({}, 401)
          : json({ meta: user, billing_workspace: { type: 'personal' } });
      },
    });
    assert.equal(result.authenticated, true);
    assert.equal(accountCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(
      (await loadCredentials(endpoint)).tokens.access_token,
      'renewed',
    );
  }));

test('auth status and info alias support human and JSON output; authorization errors exit with code 1', () =>
  isolated(async (directory) => {
    const calls = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      calls.push([req.url, JSON.parse(body)]);
      res.writeHead(
        req.headers.authorization === 'Bearer invalid' ? 401 : 200,
        { 'Content-Type': 'application/json' },
      );
      res.end(
        JSON.stringify({ meta: user, billing_workspace: { type: 'personal' } }),
      );
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const executable = fileURLToPath(
      new URL('../packages/cli/dist/index.js', import.meta.url),
    );
    const localEndpoint = `http://127.0.0.1:${server.address().port}/api/mcp`;
    const run = async (command, token, output) => {
      if (token)
        await createProvider(localEndpoint, {}).saveTokens({
          access_token: token,
          token_type: 'Bearer',
        });
      else await logout(localEndpoint);
      return promisify(execFile)(
        process.execPath,
        [
          executable,
          '--base-url',
          `http://127.0.0.1:${server.address().port}/api`,
          'auth',
          command,
          ...(output ? ['--output', output] : []),
        ],
        {
          env: { ...process.env, HYPER3D_CONFIG_DIR: directory },
          timeout: 15000,
        },
      );
    };
    try {
      for (const command of ['status', 'info']) {
        const result = await run(command, 'fixture-token', 'json');
        assert.deepEqual(JSON.parse(result.stdout).wallet, {
          type: 'personal',
          balance: 12.5,
          subscription_balance: 10,
          frozen: 0.5,
        });
        assert.equal(result.stderr, '');
      }
      const human = await run('status', 'fixture-token');
      assert.match(human.stdout, /^Authenticated as fixture$/m);
      assert.match(human.stdout, /^ {2}Subscription: 10$/m);
      assert.equal(
        (await run('status', '')).stdout,
        'Not authenticated. Run hyper3d auth login.\n',
      );
      await assert.rejects(run('status', 'invalid'), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /Account access denied/);
        return true;
      });
      assert.deepEqual(
        calls,
        Array.from({ length: 4 }, () => ['/api/user/get_info', {}]),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }));
