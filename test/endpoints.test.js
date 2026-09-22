import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEndpoints } from '../packages/cli/dist/endpoints.js';
import { createProvider, credentialPath } from '../packages/cli/dist/auth.js';

test('base URLs preserve the API path and normalize trailing slashes', () => {
  const expected = {
    baseUrl: 'https://api.hyper3d.com/api/',
    mcp: 'https://api.hyper3d.com/api/mcp',
    userInfo: 'https://api.hyper3d.com/api/user/get_info',
    groupInfo: 'https://api.hyper3d.com/api/group/group_info',
  };
  assert.deepEqual(resolveEndpoints(), expected);
  for (const value of [
    'https://api.hyper3d.com/api',
    'https://api.hyper3d.com/api/',
  ]) {
    assert.deepEqual(resolveEndpoints(value), expected);
    assert.equal(
      credentialPath(resolveEndpoints(value).mcp),
      credentialPath(expected.mcp),
    );
  }
  assert.equal(
    resolveEndpoints('http://127.0.0.1:8080/custom/api/').userInfo,
    'http://127.0.0.1:8080/custom/api/user/get_info',
  );
  for (const value of [
    'http://api.example.com/api',
    'https://user:password@example.com/api',
    'https://example.com/api?q=x',
    'https://example.com/api#x',
  ]) {
    assert.throws(() => resolveEndpoints(value));
  }
});

test('CLI reads BASE_URL with either slash spelling and explicit base URL takes precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-base-url-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        meta: {
          user_uuid: 'test-user',
          username: 'fixture',
          balance: 0,
          frozen: 0,
          subscriptions: { active_subscriptions: [] },
        },
        billing_workspace: { type: 'personal' },
      }),
    );
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/custom/api`;
    await createProvider(resolveEndpoints(base).mcp, {}).saveTokens({
      access_token: 'fixture-token',
      token_type: 'Bearer',
    });
    const executable = fileURLToPath(
      new URL('../packages/cli/dist/index.js', import.meta.url),
    );
    for (const [value, args] of [
      [base, []],
      [`${base}/`, []],
      ['invalid-url', ['--base-url', base]],
    ]) {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [executable, ...args, 'auth', 'status', '--output', 'json'],
        { env: { ...process.env, BASE_URL: value, CI: '1' }, timeout: 15000 },
      );
      assert.equal(JSON.parse(stdout).user.username, 'fixture');
    }
    assert.deepEqual(paths, Array(3).fill('/custom/api/user/get_info'));
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR;
    else process.env.HYPER3D_CONFIG_DIR = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
