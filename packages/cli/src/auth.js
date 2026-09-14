import {createServer} from 'node:http';
import {randomBytes, createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {auth} from '@modelcontextprotocol/sdk/client/auth.js';

export const redirectUrl = 'http://127.0.0.1:43817/callback';
export function clientMetadata(clientId) {
  const url = new URL(clientId);
  if (url.protocol !== 'https:' || url.pathname === '/' || url.hash || url.username || url.password)
    throw new Error('CIMD client ID must be an HTTPS document URL without credentials or fragment');
  return {
    client_id: clientId, client_name: 'Hyper3D CLI',
    client_uri: 'https://github.com/DeemosTech/hyper3d-cli',
    application_type: 'native', redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    token_endpoint_auth_method: 'none', scope: 'rodin:generate rodin:read',
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

export function createProvider(endpoint, data, interactive = false) {
  const metadata = clientMetadata(data.clientId);
  const state = randomBytes(32).toString('hex');
  let verifier;
  return {
    redirectUrl, clientMetadataUrl: data.clientId,
    get clientMetadata() { const {client_id, ...rest} = metadata; return rest; },
    clientInformation: () => ({client_id: data.clientId}),
    state: () => state,
    tokens: () => data.tokens,
    saveTokens: async tokens => {
      data.tokens = tokens;
      data.expiresAt = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined;
      await saveCredentials(endpoint, data);
    },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => { if (!verifier) throw new Error('Missing PKCE verifier'); return verifier; },
    redirectToAuthorization: url => {
      if (!interactive) throw new Error('Authentication expired. Run hyper3d auth login.');
      process.stderr.write(`Open this URL in your browser to sign in:\n${url.href}\n`);
    },
    invalidateCredentials: async scope => {
      if (scope === 'all' || scope === 'tokens') {
        delete data.tokens; delete data.expiresAt;
        await saveCredentials(endpoint, data);
      }
    },
  };
}

export function parseCallback(requestUrl, expectedState) {
  const url = new URL(requestUrl, redirectUrl);
  if (url.pathname !== '/callback') throw new Error('Unexpected callback path');
  if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState)
    throw new Error('Invalid OAuth state');
  if (url.searchParams.has('error')) throw new Error('Authorization was denied');
  if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) throw new Error('Missing authorization code');
  return url.searchParams.get('code');
}

export async function login(endpoint, clientId) {
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:' && !(endpointUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname)))
    throw new Error('OAuth endpoint must use HTTPS (HTTP is allowed for localhost tests).');
  if (!clientId) throw new Error('Set HYPER3D_CLIENT_ID to the published CIMD URL, or use --client-id.');
  const provider = createProvider(endpoint, {clientId}, true);
  const expectedState = provider.state();
  let resolveCode, rejectCode;
  const code = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach immediately so timeout during network discovery is handled.
  code.catch(() => {});
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    try {
      const value = parseCallback(req.url, expectedState);
      res.writeHead(200, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store'}).end('Authorization received. Return to the terminal.');
      resolveCode(value);
    } catch {
      res.writeHead(400, {'Content-Type': 'text/plain'}).end('Invalid OAuth callback.');
      const denied = new URL(req.url, redirectUrl);
      if (denied.pathname === '/callback' && denied.searchParams.getAll('state').length === 1 && denied.searchParams.get('state') === expectedState && denied.searchParams.has('error'))
        rejectCode(new Error('Authorization was denied'));
    }
  });
  const timeout = setTimeout(() => rejectCode(new Error('Login timed out after 5 minutes')), 300000);
  const stop = () => rejectCode(new Error('Login cancelled'));
  process.once('SIGINT', stop);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(43817, '127.0.0.1', resolve);
    });
    const fetchFn = (url, init) => fetch(url, {...init, signal: AbortSignal.timeout(15000)});
    const result = await auth(provider, {serverUrl: endpoint, fetchFn});
    if (result === 'REDIRECT') await auth(provider, {serverUrl: endpoint, authorizationCode: await code, fetchFn});
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', stop);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
