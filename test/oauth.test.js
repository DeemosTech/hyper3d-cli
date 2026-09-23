import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  login,
  createProvider,
  loadCredentials,
  DEVICE_GRANT_TYPE,
  CLI_CLIENT_ID,
  CLI_SCOPES,
  credentialPath,
} from '../packages/cli/dist/auth.js';

const endpoint = 'https://api.example.com/mcp';
const issuer = 'https://auth.example.com';
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
function harness({
  polls = [],
  supported = true,
  expires = 600,
  interval = 5,
  complete = 'https://auth.example.com/device?user_code=ABCD-EFGH',
} = {}) {
  let time = 0,
    requests = 0;
  const delays = [],
    output = [],
    opened = [],
    tokenParams = [];
  const fetchFn = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('oauth-protected-resource'))
      return json({
        resource: endpoint,
        authorization_servers: [issuer],
        scopes_supported: ['rodin:read'],
      });
    if (url.pathname.includes('oauth-authorization-server'))
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
        grant_types_supported: supported
          ? [DEVICE_GRANT_TYPE, 'refresh_token']
          : ['authorization_code'],
        device_authorization_endpoint: supported
          ? `${issuer}/device_authorization`
          : undefined,
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
      });
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('client_id'), CLI_CLIENT_ID);
    assert.equal(params.has('client_secret'), false);
    assert.equal(params.has('redirect_uri'), false);
    assert.equal(params.has('code_verifier'), false);
    if (url.pathname === '/device_authorization') {
      requests++;
      assert.equal(params.get('resource'), endpoint);
      assert.equal(params.get('scope'), CLI_SCOPES);
      return json({
        device_code: 'private-device-secret',
        user_code: 'ABCD-EFGH',
        verification_uri: `${issuer}/device`,
        verification_uri_complete: complete,
        expires_in: expires,
        interval,
      });
    }
    assert.equal(url.href, `${issuer}/token`);
    tokenParams.push(params);
    if (params.get('grant_type') === 'refresh_token') {
      assert.equal(params.get('refresh_token'), 'refresh');
      assert.equal(params.get('resource'), endpoint);
      return json({
        access_token: 'renewed',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    assert.equal(params.get('grant_type'), DEVICE_GRANT_TYPE);
    assert.equal(params.get('device_code'), 'private-device-secret');
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return (
      next ??
      json({
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    );
  };
  return {
    delays,
    output,
    opened,
    tokenParams,
    get requests() {
      return requests;
    },
    options: {
      fetchFn,
      now: () => time,
      wait: async (ms) => {
        delays.push(ms);
        time += ms;
      },
      write: (text) => output.push(text),
      open: async (url) => {
        opened.push(url);
      },
    },
  };
}
async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-device-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR;
    else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('device login opens complete URL, backs off, saves credentials and SDK refreshes without PKCE', () =>
  isolated(async () => {
    const h = harness({
      polls: [
        json({ error: 'authorization_pending' }, 400),
        json({ error: 'slow_down' }, 400),
        new TypeError('network failed'),
      ],
    });
    await login(endpoint, h.options);
    assert.deepEqual(h.delays, [5000, 5000, 10000, 20000]);
    assert.deepEqual(h.opened, [`${issuer}/device?user_code=ABCD-EFGH`]);
    assert.match(h.output.join(''), /ABCD-EFGH/);
    assert.doesNotMatch(h.output.join(''), /private-device-secret/);
    const data = await loadCredentials(endpoint);
    assert.equal(data.tokens.access_token, 'access');
    const provider = createProvider(endpoint, data);
    assert.equal(provider.redirectUrl, undefined);
    assert.equal(
      await auth(provider, { serverUrl: endpoint, fetchFn: h.options.fetchFn }),
      'AUTHORIZED',
    );
    const refreshed = await loadCredentials(endpoint);
    assert.equal(refreshed.tokens.access_token, 'renewed');
    assert.equal(refreshed.tokens.refresh_token, 'refresh');
  }));

test('a read-only sandbox rejects refresh and login before token issuance, preserving stored credentials', () =>
  isolated(async () => {
    await login(endpoint, harness().options);
    const before = await readFile(credentialPath(endpoint), 'utf8');
    const directory = process.env.HYPER3D_CONFIG_DIR;
    // OS permission bits still say writable. Node's permission model supplies
    // a deterministic sandbox denial, including on Windows and under root.
    const script = `
      import assert from 'node:assert/strict';
      import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
      import { createProvider, loadCredentials, login } from './packages/cli/dist/auth.js';
      const endpoint = ${JSON.stringify(endpoint)};
      const issuer = ${JSON.stringify(issuer)};
      const json = ${json.toString()};
      const DEVICE_GRANT_TYPE = ${JSON.stringify(DEVICE_GRANT_TYPE)};
      const CLI_CLIENT_ID = ${JSON.stringify(CLI_CLIENT_ID)};
      const CLI_SCOPES = ${JSON.stringify(CLI_SCOPES)};
      const harness = ${harness.toString()};
      const h = harness();
      const provider = createProvider(endpoint, await loadCredentials(endpoint));
      await assert.rejects(auth(provider, { serverUrl: endpoint, fetchFn: h.options.fetchFn }), /Cannot write the credential store/);
      assert.equal(h.tokenParams.length, 0);
      assert.equal(provider.tokens().refresh_token, 'refresh');
      await assert.rejects(login(endpoint, h.options), /Cannot write the credential store/);
      assert.equal(h.requests, 0);
    `;
    await promisify(execFile)(process.execPath, [
      process.allowedNodeEnvironmentFlags.has('--permission')
        ? '--permission'
        : '--experimental-permission',
      '--allow-fs-read=*',
      '--input-type=module',
      '--eval',
      script,
    ]);
    assert.equal(await readFile(credentialPath(endpoint), 'utf8'), before);
    assert.equal((await readdir(directory)).length, 1);
    // The denied attempt must not prevent a later writable process refreshing.
    const h = harness();
    await auth(createProvider(endpoint, await loadCredentials(endpoint)), {
      serverUrl: endpoint,
      fetchFn: h.options.fetchFn,
    });
    assert.equal(h.tokenParams.length, 1);
    assert.equal(
      (await loadCredentials(endpoint)).tokens.access_token,
      'renewed',
    );
    assert.equal((await readdir(directory)).length, 1);
  }));

test('OAuth rejection does not erase newer credentials saved by another process', () =>
  isolated(async () => {
    await login(endpoint, harness().options);
    for (const error of [
      'invalid_grant',
      'invalid_client',
      'unauthorized_client',
    ]) {
      const provider = createProvider(
        endpoint,
        await loadCredentials(endpoint),
      );
      const h = harness();
      await assert.rejects(
        auth(provider, {
          serverUrl: endpoint,
          fetchFn: async (input, init) => {
            if (new URL(input).pathname !== '/token')
              return h.options.fetchFn(input, init);
            await createProvider(endpoint, {}).saveTokens({
              access_token: 'another-process-access',
              refresh_token: 'another-process-refresh',
              token_type: 'Bearer',
            });
            return json({ error }, 400);
          },
        }),
        /auth login/,
      );
      assert.equal(provider.tokens(), undefined);
      assert.equal(
        (await loadCredentials(endpoint)).tokens.refresh_token,
        'another-process-refresh',
      );
    }
  }));

test('rotated refresh tokens are persisted and transient network failures preserve them', () =>
  isolated(async () => {
    await login(endpoint, harness().options);
    const provider = createProvider(endpoint, await loadCredentials(endpoint));
    const h = harness();
    await auth(provider, {
      serverUrl: endpoint,
      fetchFn: async (input, init) =>
        new URL(input).pathname === '/token'
          ? json({
              access_token: 'rotated-access',
              refresh_token: 'rotated-refresh',
              token_type: 'Bearer',
            })
          : h.options.fetchFn(input, init),
    });
    const before = await readFile(credentialPath(endpoint), 'utf8');
    assert.equal(
      (await loadCredentials(endpoint)).tokens.refresh_token,
      'rotated-refresh',
    );
    await assert.rejects(
      auth(provider, {
        serverUrl: endpoint,
        fetchFn: async (input, init) => {
          if (new URL(input).pathname === '/token')
            throw new TypeError('network failed');
          return h.options.fetchFn(input, init);
        },
      }),
      /network failed/,
    );
    assert.equal(await readFile(credentialPath(endpoint), 'utf8'), before);
  }));

test('no-browser and browser launch failure both complete the same device flow', () =>
  isolated(async () => {
    const h = harness();
    await login(endpoint, { ...h.options, browser: false });
    assert.deepEqual(h.opened, []);
    const failed = harness();
    await login(endpoint, {
      ...failed.options,
      open: async () => {
        throw new Error('no display');
      },
    });
    assert.equal(failed.requests, 1);
    assert.match(failed.output.join(''), /manually/);
  }));

test('denial, expiration and invalid grant are terminal and do not save tokens', () =>
  isolated(async () => {
    for (const error of ['access_denied', 'expired_token', 'invalid_grant']) {
      const h = harness({ polls: [json({ error }, 400)] });
      await assert.rejects(
        login(endpoint, h.options),
        /denied|expired|invalid/,
      );
      assert.equal(h.tokenParams.length, 1);
      assert.deepEqual(await loadCredentials(endpoint), {});
    }
    const h = harness({
      expires: 9,
      polls: [json({ error: 'authorization_pending' }, 400)],
    });
    await assert.rejects(login(endpoint, h.options), /expired/);
    assert.equal(h.tokenParams.length, 1);
  }));

test('unsupported discovery, unsafe URLs and cancellation never start fallback login', () =>
  isolated(async () => {
    const unsupported = harness({ supported: false });
    await assert.rejects(
      login(endpoint, unsupported.options),
      /does not advertise Device Flow/,
    );
    assert.equal(unsupported.requests, 0);
    for (const complete of [
      'javascript:alert(1)',
      'https://other.example.com/device',
    ]) {
      const h = harness({ complete });
      await assert.rejects(login(endpoint, h.options), /HTTPS|origin mismatch/);
      assert.deepEqual(h.opened, []);
    }
    const h = harness();
    const controller = new AbortController();
    await assert.rejects(
      login(endpoint, {
        ...h.options,
        signal: controller.signal,
        open: async () => controller.abort(new Error('cancelled')),
      }),
      /cancelled/,
    );
    assert.equal(h.tokenParams.length, 0);
  }));

test('server throttling backs off and missing refresh credentials require explicit login', () =>
  isolated(async () => {
    const h = harness({ polls: [json({}, 429, { 'Retry-After': '12' })] });
    await login(endpoint, h.options);
    assert.deepEqual(h.delays, [5000, 12000]);
    const provider = createProvider(endpoint, { clientId: CLI_CLIENT_ID });
    await assert.rejects(
      auth(provider, { serverUrl: endpoint, fetchFn: h.options.fetchFn }),
      /auth login/,
    );
  }));

test('device login preserves endpoint through OIDC discovery fallback', () =>
  isolated(async () => {
    const h = harness();
    const originalFetch = h.options.fetchFn;
    const fetchFn = async (input, init) => {
      const url = new URL(input);
      if (url.pathname.includes('oauth-authorization-server'))
        return json({}, 404);
      if (url.pathname.includes('openid-configuration')) {
        const response = await originalFetch(
          `${issuer}/.well-known/oauth-authorization-server`,
          init,
        );
        return json({
          ...(await response.json()),
          jwks_uri: `${issuer}/jwks`,
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        });
      }
      return originalFetch(input, init);
    };
    await login(endpoint, { ...h.options, fetchFn });
    assert.equal(h.requests, 1);
    assert.equal(
      (await loadCredentials(endpoint)).tokens.access_token,
      'access',
    );
  }));
