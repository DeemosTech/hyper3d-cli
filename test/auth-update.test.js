import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientMetadata,
  CLI_CLIENT_ID,
  CLI_SCOPES,
  DEVICE_GRANT_TYPE,
  credentialPath,
  createProvider,
  loadCredentials,
  logout,
} from '../packages/cli/dist/auth.js';
import { checkUpdate, update } from '../packages/cli/dist/update.js';
import { evaluatePolicy, enforcePolicy } from '../packages/cli/dist/policy.js';

test('CIMD is a public native client with an exact client ID', () => {
  const metadata = clientMetadata();
  assert.equal(metadata.client_id, CLI_CLIENT_ID);
  assert.equal(metadata.scope, CLI_SCOPES);
  assert.equal(metadata.token_endpoint_auth_method, 'none');
  assert.deepEqual(metadata.redirect_uris, []);
  assert.deepEqual(metadata.response_types, []);
  assert.deepEqual(metadata.grant_types, [DEVICE_GRANT_TYPE, 'refresh_token']);
});
test('credentials are endpoint-bound, private, and removable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-auth-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  try {
    const endpoint = 'https://api.example.com/mcp';
    const provider = createProvider(endpoint, {});
    await provider.saveTokens({
      access_token: 'test-token',
      token_type: 'Bearer',
      expires_in: 60,
    });
    assert.equal(
      (await loadCredentials(endpoint)).tokens.access_token,
      'test-token',
    );
    assert.deepEqual(
      await loadCredentials('https://other.example.com/mcp'),
      {},
    );
    if (process.platform !== 'win32')
      assert.equal((await stat(credentialPath(endpoint))).mode & 0o777, 0o600);
    await assert.rejects(
      async () =>
        provider.redirectToAuthorization(
          new URL('https://example.com/authorize'),
        ),
      /auth login/,
    );
    await logout(endpoint);
    assert.deepEqual(await loadCredentials(endpoint), {});
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR;
    else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test('npm checks use semver and validate channels', async () => {
  assert.equal(
    (
      await checkUpdate(
        { name: '@hyper3d/cli', version: '0.9.0' },
        'latest',
        async () => '"0.10.0"',
      )
    ).available,
    true,
  );
  await assert.rejects(
    checkUpdate({ name: 'x', version: '1.0.0' }, 'bad', async () => '"2.0.0"'),
  );
});
test('updates only the global installation using an exact version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hyper3d-update-'));
  const directory = join(root, '@hyper3d', 'cli');
  await mkdir(directory, { recursive: true });
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return args[0] === 'root' ? root : args[0] === 'view' ? '"0.2.0"' : '';
  };
  try {
    const result = await update(
      { name: '@hyper3d/cli', version: '0.1.0' },
      directory,
      'latest',
      run,
    );
    assert.equal(result.updated, true);
    assert.deepEqual(calls.at(-1), [
      'install',
      '--global',
      '@hyper3d/cli@0.2.0',
      '--no-fund',
      '--no-audit',
    ]);
    await assert.rejects(
      update({ name: '@hyper3d/cli', version: '0.1.0' }, root, 'latest', run),
      /Not a global/,
    );
    await assert.rejects(
      update({ private: true }, directory, 'latest', run),
      /private/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('minimum policy blocks old versions; network failure never implies forced update', async () => {
  assert.equal(
    evaluatePolicy({ schemaVersion: 1, minimumVersion: '0.2.0' }, '0.1.0')
      .required,
    true,
  );
  assert.throws(() =>
    evaluatePolicy({ schemaVersion: 1, minimumVersion: 'bad' }, '0.1.0'),
  );
  await assert.rejects(
    enforcePolicy('https://example.com/policy.json', '0.1.0', async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 1, minimumVersion: '0.2.0' }),
    })),
    /CLIENT_UPGRADE_REQUIRED/,
  );
  await enforcePolicy('https://example.com/policy.json', '0.1.0', async () => {
    throw new Error('offline');
  });
});
