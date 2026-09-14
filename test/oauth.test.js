import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {createProvider, loadCredentials, redirectUrl} from '../packages/cli/src/auth.js';

test('SDK CIMD flow preserves resource, uses PKCE, saves tokens and refreshes', async () => {
  const config = await mkdtemp(join(tmpdir(), 'hyper3d-oauth-'));
  const previous = process.env.HYPER3D_CONFIG_DIR;
  process.env.HYPER3D_CONFIG_DIR = config;
  const endpoint = 'https://api.example.com/mcp';
  const clientId = 'https://example.com/cli.json';
  const provider = createProvider(endpoint, {clientId}, true);
  let authorize, exchanges = 0;
  provider.redirectToAuthorization = url => { authorize = url; };
  const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
  const fetchFn = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.includes('oauth-protected-resource')) return json({resource: endpoint, authorization_servers: ['https://auth.example.com'], scopes_supported: ['rodin:read']});
    if (url.pathname.includes('oauth-authorization-server')) return json({
      issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true,
    });
    assert.equal(url.href, 'https://auth.example.com/token');
    const params = new URLSearchParams(init.body);
    assert.equal(params.get('client_id'), clientId);
    assert.equal(params.get('resource'), endpoint);
    assert.equal(params.has('client_secret'), false);
    if (exchanges++ === 0) {
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('redirect_uri'), redirectUrl);
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorize.searchParams.get('code_challenge'));
    } else {
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'fixture-refresh');
    }
    return json({access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600});
  };
  try {
    assert.equal(await auth(provider, {serverUrl: endpoint, fetchFn}), 'REDIRECT');
    assert.equal(authorize.searchParams.get('state'), provider.state());
    assert.equal(authorize.searchParams.get('client_id'), clientId);
    assert.equal(authorize.searchParams.get('resource'), endpoint);
    assert.equal(await auth(provider, {serverUrl: endpoint, authorizationCode: 'test-code', fetchFn}), 'AUTHORIZED');
    assert.equal((await loadCredentials(endpoint)).tokens.access_token, 'fixture-access');
    assert.equal(await auth(provider, {serverUrl: endpoint, fetchFn}), 'AUTHORIZED');
    assert.equal(exchanges, 2);
  } finally {
    if (previous === undefined) delete process.env.HYPER3D_CONFIG_DIR; else process.env.HYPER3D_CONFIG_DIR = previous;
    await rm(config, {recursive: true, force: true});
  }
});
