import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {randomBytes, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, selectResourceURL} from '@modelcontextprotocol/sdk/client/auth.js';
import {OAuthTokensSchema} from '@modelcontextprotocol/sdk/shared/auth.js';

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const DEFAULT_CLIENT_ID = 'https://hyper3d.ai/oauth_cimd/cli.json';
export function clientMetadata(clientId) {
  const url = new URL(clientId);
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash || url.username || url.password)
    throw new Error('CIMD client ID must be an HTTPS document URL without credentials or fragment');
  return {
    client_id: clientId, client_name: 'Hyper3D CLI',
    client_uri: 'https://github.com/DeemosTech/hyper3d-cli',
    application_type: 'native', redirect_uris: [],
    grant_types: [DEVICE_GRANT_TYPE, 'refresh_token'], response_types: [],
    token_endpoint_auth_method: 'none', scope: 'rodin:generate rodin:read offline_access',
  };
}
export function credentialPath(endpoint) {
  const key = createHash('sha256').update(new URL(endpoint).href).digest('hex');
  return join(process.env.HYPER3D_CONFIG_DIR ?? join(homedir(), '.hyper3d'), `${key}.json`);
}
export async function loadCredentials(endpoint) {
  try { return JSON.parse(await readFile(credentialPath(endpoint), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function saveCredentials(endpoint, data) {
  const path = credentialPath(endpoint);
  await mkdir(join(path, '..'), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, {mode: 0o600, flag: 'wx'});
    await rename(temporary, path);
  } finally { await rm(temporary, {force: true}); }
}
export async function logout(endpoint) { await rm(credentialPath(endpoint), {force: true}); }

export function createProvider(endpoint, data) {
  const metadata = clientMetadata(data.clientId);
  return {
    clientMetadataUrl: data.clientId,
    get clientMetadata() { const {client_id, ...rest} = metadata; return rest; },
    clientInformation: () => ({client_id: data.clientId}),
    tokens: () => data.tokens,
    saveTokens: async tokens => {
      data.tokens = {...tokens, refresh_token: tokens.refresh_token ?? data.tokens?.refresh_token};
      data.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      await saveCredentials(endpoint, data);
    },
    prepareTokenRequest: () => {
      if (!data.tokens?.refresh_token) throw new Error('Authentication expired. Run hyper3d auth login.');
      return new URLSearchParams({grant_type: 'refresh_token', refresh_token: data.tokens.refresh_token});
    },
    redirectToAuthorization: () => { throw new Error('Run hyper3d auth login to authorize this device.'); },
    invalidateCredentials: async scope => {
      if (scope === 'all' || scope === 'tokens') {
        delete data.tokens; delete data.expiresAt;
        await saveCredentials(endpoint, data);
      }
    },
  };
}

function secureUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('OAuth URLs must use HTTPS (HTTP is allowed for localhost tests).');
  return url;
}

async function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await promisify(execFile)(command, args, {timeout: 5000});
}

function oauthFailure(body, status) {
  const messages = {
    access_denied: 'Authorization denied.',
    expired_token: 'Device code expired. Run hyper3d auth login again.',
    invalid_grant: 'Device authorization is invalid or already used. Run hyper3d auth login again.',
    unauthorized_client: 'Device Flow is not enabled for this CLI client.',
    invalid_client: 'CLI client metadata was rejected. Check the published CIMD.',
  };
  return new Error(messages[body?.error] ?? `OAuth request failed (HTTP ${status}).`);
}

export async function login(endpoint, clientId = DEFAULT_CLIENT_ID, {
  browser = true, fetchFn = fetch, open = openBrowser,
  write = text => process.stderr.write(text), wait = sleep, now = Date.now,
  signal,
} = {}) {
  secureUrl(endpoint);
  const provider = createProvider(endpoint, {clientId});
  const cancelled = new AbortController();
  const stop = () => cancelled.abort(new Error('Login cancelled'));
  process.once('SIGINT', stop);
  const active = signal ? AbortSignal.any([signal, cancelled.signal]) : cancelled.signal;
  // Bound discovery and issuance too, not only the polling phase.
  const setupSignal = AbortSignal.any([active, AbortSignal.timeout(60000)]);
  const request = (input, init = {}) => {
    secureUrl(input);
    return fetchFn(input, {...init, redirect: 'error', signal: AbortSignal.any([
      init.signal ?? setupSignal, AbortSignal.timeout(15000),
    ])});
  };
  const post = (url, fields, requestSignal) => request(url, {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
    body: new URLSearchParams(fields), signal: requestSignal,
  });
  try {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(endpoint, undefined, request);
    const issuer = resourceMetadata.authorization_servers?.[0];
    if (!issuer) throw new Error('MCP discovery did not advertise an authorization server.');
    secureUrl(issuer);
    // SDK's OIDC schema strips Device Flow extension fields. Preserve the
    // endpoint from the same successful document while retaining SDK validation.
    let deviceAuthorizationEndpoint;
    const metadata = await discoverAuthorizationServerMetadata(issuer, {fetchFn: async (input, init) => {
      const response = await request(input, init);
      if (response.ok) deviceAuthorizationEndpoint = (await response.clone().json()).device_authorization_endpoint;
      return response;
    }});
    if (!metadata || new URL(metadata.issuer).href !== new URL(issuer).href)
      throw new Error('OAuth discovery issuer mismatch.');
    if (typeof deviceAuthorizationEndpoint !== 'string' || !metadata.grant_types_supported?.includes(DEVICE_GRANT_TYPE))
      throw new Error('The server does not advertise Device Flow. Deploy and enable the backend before logging in.');
    secureUrl(metadata.token_endpoint);
    const resource = String(await selectResourceURL(new URL(endpoint), provider, resourceMetadata));
    const scope = [...new Set([...(resourceMetadata.scopes_supported ?? ['rodin:generate', 'rodin:read']), 'offline_access'])].join(' ');
    const response = await post(deviceAuthorizationEndpoint, {client_id: clientId, resource, scope});
    const device = await response.json();
    if (!response.ok) throw oauthFailure(device, response.status);
    if (typeof device.device_code !== 'string' || !device.device_code ||
        typeof device.user_code !== 'string' || !/^[A-Za-z0-9 -]{1,64}$/.test(device.user_code) ||
        !Number.isSafeInteger(device.expires_in) || device.expires_in <= 0 || device.expires_in > 86400 ||
        (device.interval !== undefined && (!Number.isSafeInteger(device.interval) || device.interval <= 0 || device.interval > 86400)))
      throw new Error('Invalid device authorization response.');
    const verification = secureUrl(device.verification_uri);
    const complete = device.verification_uri_complete ? secureUrl(device.verification_uri_complete) : verification;
    if (complete.origin !== verification.origin) throw new Error('Verification URL origin mismatch.');
    const deadline = now() + device.expires_in * 1000;
    const pollSignal = AbortSignal.any([active, AbortSignal.timeout(device.expires_in * 1000)]);
    let interval = (device.interval ?? 5) * 1000;
    write(`Confirm that the browser shows this same code: ${device.user_code}\nOpen this URL on this or another device:\n${complete.href}\n`);
    if (browser) {
      try { await open(complete.href); }
      catch { write('Could not open a browser. Open the link above manually; login is still waiting.\n'); }
    }
    write('Waiting for authorization…\n');
    while (now() < deadline) {
      active.throwIfAborted();
      await wait(Math.min(interval, deadline - now()), undefined, {signal: pollSignal});
      if (now() >= deadline) break;
      let tokenResponse;
      try {
        tokenResponse = await post(metadata.token_endpoint, {
          grant_type: DEVICE_GRANT_TYPE, client_id: clientId, device_code: device.device_code,
        }, pollSignal);
      } catch (error) {
        pollSignal.throwIfAborted();
        if (error.name !== 'TimeoutError' && !(error instanceof TypeError)) throw error;
        interval = Math.min(interval * 2, device.expires_in * 1000);
        continue;
      }
      if (tokenResponse.status === 429 || tokenResponse.status >= 500) {
        const retry = Number(tokenResponse.headers.get('Retry-After'));
        interval = Math.max(interval + 5000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0);
        await tokenResponse.body?.cancel();
        continue;
      }
      const tokens = await tokenResponse.json();
      if (tokenResponse.ok) {
        await provider.saveTokens(OAuthTokensSchema.parse(tokens));
        return;
      }
      if (tokens.error === 'authorization_pending') continue;
      if (tokens.error === 'slow_down') { interval += 5000; continue; }
      throw oauthFailure(tokens, tokenResponse.status);
    }
    throw new Error('Device code expired. Run hyper3d auth login again.');
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') throw new Error('Login timed out. Run hyper3d auth login again.');
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
  }
}
