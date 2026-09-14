import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {login, createProvider, loadCredentials, DEVICE_GRANT_TYPE, DEFAULT_CLIENT_ID} from '../packages/cli/src/auth.js';

const endpoint = 'https://api.example.com/mcp';
const issuer = 'https://auth.example.com';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json', ...headers}});
function harness({polls = [], supported = true, expires = 600, interval = 5, complete = 'https://auth.example.com/device?user_code=ABCD-EFGH'} = {}) {
  let time = 0, requests = 0;
  const delays = [], output = [], opened = [], tokenParams = [];
  const fetchFn = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('oauth-protected-resource')) return json({resource: endpoint, authorization_servers: [issuer], scopes_supported: ['rodin:read']});
    if (url.pathname.includes('oauth-authorization-server')) return json({issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'], grant_types_supported: supported ? [DEVICE_GRANT_TYPE, 'refresh_token'] : ['authorization_code'],
      device_authorization_endpoint: supported ? `${issuer}/device_authorization` : undefined,
      token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true});
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('client_id'), DEFAULT_CLIENT_ID);
    assert.equal(params.has('client_secret'), false);
    assert.equal(params.has('redirect_uri'), false);
    assert.equal(params.has('code_verifier'), false);
    if (url.pathname === '/device_authorization') {
      requests++;
      assert.equal(params.get('resource'), endpoint);
      assert.equal(params.get('scope'), 'rodin:read offline_access');
      return json({device_code: 'private-device-secret', user_code: 'ABCD-EFGH', verification_uri: `${issuer}/device`, verification_uri_complete: complete, expires_in: expires, interval});
    }
    assert.equal(url.href, `${issuer}/token`);
    tokenParams.push(params);
    if (params.get('grant_type') === 'refresh_token') {
      assert.equal(params.get('refresh_token'), 'refresh');
      assert.equal(params.get('resource'), endpoint);
      return json({access_token: 'renewed', token_type: 'Bearer', expires_in: 3600});
    }
    assert.equal(params.get('grant_type'), DEVICE_GRANT_TYPE);
    assert.equal(params.get('device_code'), 'private-device-secret');
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return next ?? json({access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600});
  };
  return {delays, output, opened, tokenParams, get requests() { return requests; }, options: {
    fetchFn, now: () => time, wait: async ms => { delays.push(ms); time += ms; },
    write: text => output.push(text), open: async url => { opened.push(url); },
  }};
}
async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hyper3d-device-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = directory;
  try { await run(); }
  finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR; else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(directory, {recursive: true, force: true});
  }
}

test('device login opens complete URL, backs off, saves credentials and SDK refreshes without PKCE', () => isolated(async () => {
  const h = harness({polls: [json({error: 'authorization_pending'}, 400), json({error: 'slow_down'}, 400), new TypeError('network failed')]});
  await login(endpoint, undefined, h.options);
  assert.deepEqual(h.delays, [5000, 5000, 10000, 20000]);
  assert.deepEqual(h.opened, [`${issuer}/device?user_code=ABCD-EFGH`]);
  assert.match(h.output.join(''), /ABCD-EFGH/);
  assert.doesNotMatch(h.output.join(''), /private-device-secret/);
  const data = await loadCredentials(endpoint);
  assert.equal(data.tokens.access_token, 'access');
  const provider = createProvider(endpoint, data);
  assert.equal(provider.redirectUrl, undefined);
  assert.equal(await auth(provider, {serverUrl: endpoint, fetchFn: h.options.fetchFn}), 'AUTHORIZED');
  const refreshed = await loadCredentials(endpoint);
  assert.equal(refreshed.tokens.access_token, 'renewed');
  assert.equal(refreshed.tokens.refresh_token, 'refresh');
}));

test('no-browser and browser launch failure both complete the same device flow', () => isolated(async () => {
  const h = harness();
  await login(endpoint, undefined, {...h.options, browser: false});
  assert.deepEqual(h.opened, []);
  const failed = harness();
  await login(endpoint, undefined, {...failed.options, open: async () => { throw new Error('no display'); }});
  assert.equal(failed.requests, 1);
  assert.match(failed.output.join(''), /manually/);
}));

test('denial, expiration and invalid grant are terminal and do not save tokens', () => isolated(async () => {
  for (const error of ['access_denied', 'expired_token', 'invalid_grant']) {
    const h = harness({polls: [json({error}, 400)]});
    await assert.rejects(login(endpoint, undefined, h.options), /denied|expired|invalid/);
    assert.equal(h.tokenParams.length, 1);
    assert.deepEqual(await loadCredentials(endpoint), {});
  }
  const h = harness({expires: 9, polls: [json({error: 'authorization_pending'}, 400)]});
  await assert.rejects(login(endpoint, undefined, h.options), /expired/);
  assert.equal(h.tokenParams.length, 1);
}));

test('unsupported discovery, unsafe URLs and cancellation never start fallback login', () => isolated(async () => {
  const unsupported = harness({supported: false});
  await assert.rejects(login(endpoint, undefined, unsupported.options), /does not advertise Device Flow/);
  assert.equal(unsupported.requests, 0);
  for (const complete of ['javascript:alert(1)', 'https://other.example.com/device']) {
    const h = harness({complete});
    await assert.rejects(login(endpoint, undefined, h.options), /HTTPS|origin mismatch/);
    assert.deepEqual(h.opened, []);
  }
  const h = harness();
  const controller = new AbortController();
  await assert.rejects(login(endpoint, undefined, {...h.options, signal: controller.signal,
    open: async () => controller.abort(new Error('cancelled'))}), /cancelled/);
  assert.equal(h.tokenParams.length, 0);
}));

test('server throttling backs off and missing refresh credentials require explicit login', () => isolated(async () => {
  const h = harness({polls: [json({}, 429, {'Retry-After': '12'})]});
  await login(endpoint, undefined, h.options);
  assert.deepEqual(h.delays, [5000, 12000]);
  const provider = createProvider(endpoint, {clientId: DEFAULT_CLIENT_ID});
  await assert.rejects(auth(provider, {serverUrl: endpoint, fetchFn: h.options.fetchFn}), /auth login/);
}));


test('device login preserves endpoint through OIDC discovery fallback', () => isolated(async () => {
  const h = harness();
  const originalFetch = h.options.fetchFn;
  const fetchFn = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('oauth-authorization-server')) return json({}, 404);
    if (url.pathname.includes('openid-configuration')) {
      const response = await originalFetch(`${issuer}/.well-known/oauth-authorization-server`, init);
      return json({...await response.json(), jwks_uri: `${issuer}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256']});
    }
    return originalFetch(input, init);
  };
  await login(endpoint, undefined, {...h.options, fetchFn});
  assert.equal(h.requests, 1);
  assert.equal((await loadCredentials(endpoint)).tokens.access_token, 'access');
}));
