import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';

import type { Credentials } from './types.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
interface LoginOptions {
  browser?: boolean;
  fetchFn?: typeof fetch;
  open?: (url: string) => Promise<void>;
  write?: (text: string) => unknown;
  wait?: typeof sleep;
  now?: () => number;
  signal?: AbortSignal;
}

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export const CLI_CLIENT_ID = 'https://hyper3d.ai/oauth_cimd/cli.json';
export const CLI_SCOPES =
  'rodin:generate rodin:read account:read offline_access';
export function clientMetadata() {
  return {
    client_id: CLI_CLIENT_ID,
    client_name: 'Hyper3D CLI',
    client_uri: 'https://github.com/DeemosTech/hyper3d-cli',
    application_type: 'native',
    redirect_uris: [],
    grant_types: [DEVICE_GRANT_TYPE, 'refresh_token'],
    response_types: [],
    token_endpoint_auth_method: 'none',
    scope: CLI_SCOPES,
  };
}
export function credentialPath(endpoint: string) {
  const key = createHash('sha256').update(new URL(endpoint).href).digest('hex');
  return join(
    process.env.HYPER3D_CONFIG_DIR ?? join(homedir(), '.hyper3d'),
    `${key}.json`,
  );
}
export async function loadCredentials(endpoint: string): Promise<Credentials> {
  try {
    return JSON.parse(await readFile(credentialPath(endpoint), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
async function saveCredentials(endpoint: string, data: Credentials) {
  const path = credentialPath(endpoint);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function logout(endpoint: string) {
  await rm(credentialPath(endpoint), { force: true });
}

export function createProvider(endpoint: string, data: Credentials) {
  if (data.clientId && data.clientId !== CLI_CLIENT_ID)
    throw new Error(
      'Stored credentials belong to a different client. Run hyper3d auth login again.',
    );
  data = { ...data, clientId: CLI_CLIENT_ID };
  const metadata = clientMetadata();
  return {
    redirectUrl: undefined,
    saveCodeVerifier: async () => {
      throw new Error('Use Device Flow via hyper3d auth login.');
    },
    codeVerifier: async (): Promise<string> => {
      throw new Error('Use Device Flow via hyper3d auth login.');
    },
    clientMetadataUrl: CLI_CLIENT_ID,
    get clientMetadata() {
      return Object.fromEntries(
        Object.entries(metadata).filter(([key]) => key !== 'client_id'),
      ) as Omit<typeof metadata, 'client_id'>;
    },
    clientInformation: () => ({ client_id: CLI_CLIENT_ID }),
    tokens: () => data.tokens,
    saveTokens: async (tokens: OAuthTokens) => {
      data.tokens = {
        ...tokens,
        refresh_token: tokens.refresh_token ?? data.tokens?.refresh_token,
      };
      data.expiresAt = tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined;
      await saveCredentials(endpoint, data);
    },
    prepareTokenRequest: () => {
      if (!data.tokens?.refresh_token)
        throw new Error('Authentication expired. Run hyper3d auth login.');
      return new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: data.tokens.refresh_token,
      });
    },
    redirectToAuthorization: () => {
      throw new Error('Run hyper3d auth login to authorize this device.');
    },
    invalidateCredentials: async (scope: string) => {
      if (scope === 'all' || scope === 'tokens') {
        delete data.tokens;
        delete data.expiresAt;
        await saveCredentials(endpoint, data);
      }
    },
  };
}

export function secureUrl(value: string | URL | Request) {
  const url = new URL(value instanceof Request ? value.url : value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error(
      'OAuth URLs must use HTTPS (HTTP is allowed for localhost tests).',
    );
  return url;
}

async function openBrowser(url: string) {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await promisify(execFile)(command, args, { timeout: 5000 });
}

function oauthFailure(body: { error?: string }, status: number) {
  const messages: Record<string, string> = {
    access_denied: 'Authorization denied.',
    expired_token: 'Device code expired. Run hyper3d auth login again.',
    invalid_grant:
      'Device authorization is invalid or already used. Run hyper3d auth login again.',
    unauthorized_client: 'Device Flow is not enabled for this CLI client.',
    invalid_client:
      'The server rejected this CLI. Update Hyper3D CLI or contact support.',
  };
  return new Error(
    messages[body?.error ?? ''] ?? `OAuth request failed (HTTP ${status}).`,
  );
}

export async function login(
  endpoint: string,
  {
    browser = true,
    fetchFn = fetch,
    open = openBrowser,
    write = (text) => process.stderr.write(text),
    wait = sleep,
    now = Date.now,
    signal,
  }: LoginOptions = {},
) {
  secureUrl(endpoint);
  const provider = createProvider(endpoint, {});
  const cancelled = new AbortController();
  const stop = () => cancelled.abort(new Error('Login cancelled'));
  process.once('SIGINT', stop);
  const active = signal
    ? AbortSignal.any([signal, cancelled.signal])
    : cancelled.signal;
  // Bound discovery and issuance too, not only the polling phase.
  const setupSignal = AbortSignal.any([active, AbortSignal.timeout(60000)]);
  const request: typeof fetch = async (input, init = {}) => {
    secureUrl(input);
    return fetchFn(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        init.signal ?? setupSignal,
        AbortSignal.timeout(15000),
      ]),
    });
  };
  const post = async (
    url: string,
    fields: Record<string, string>,
    requestSignal?: AbortSignal,
  ) =>
    request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(fields),
      signal: requestSignal,
    });
  try {
    const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      endpoint,
      undefined,
      request,
    );
    const issuer = resourceMetadata.authorization_servers?.[0];
    if (!issuer)
      throw new Error(
        'MCP discovery did not advertise an authorization server.',
      );
    secureUrl(issuer);
    // SDK's OIDC schema strips Device Flow extension fields. Preserve the
    // endpoint from the same successful document while retaining SDK validation.
    let deviceAuthorizationEndpoint;
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: async (input, init) => {
        const response = await request(input, init);
        if (response.ok)
          deviceAuthorizationEndpoint = (await response.clone().json())
            .device_authorization_endpoint;
        return response;
      },
    });
    if (!metadata || new URL(metadata.issuer).href !== new URL(issuer).href)
      throw new Error('OAuth discovery issuer mismatch.');
    if (
      typeof deviceAuthorizationEndpoint !== 'string' ||
      !metadata.grant_types_supported?.includes(DEVICE_GRANT_TYPE)
    )
      throw new Error(
        'The server does not advertise Device Flow. Deploy and enable the backend before logging in.',
      );
    if (!metadata.token_endpoint)
      throw new Error('Missing OAuth token endpoint');
    secureUrl(metadata.token_endpoint);
    const resource = String(
      await selectResourceURL(new URL(endpoint), provider, resourceMetadata),
    );
    const scope = CLI_SCOPES;
    const response = await post(deviceAuthorizationEndpoint, {
      client_id: CLI_CLIENT_ID,
      resource,
      scope,
    });
    const device = await response.json();
    if (!response.ok) throw oauthFailure(device, response.status);
    if (
      typeof device.device_code !== 'string' ||
      !device.device_code ||
      typeof device.user_code !== 'string' ||
      !/^[A-Za-z0-9 -]{1,64}$/.test(device.user_code) ||
      !Number.isSafeInteger(device.expires_in) ||
      device.expires_in <= 0 ||
      device.expires_in > 86400 ||
      (device.interval !== undefined &&
        (!Number.isSafeInteger(device.interval) ||
          device.interval <= 0 ||
          device.interval > 86400))
    )
      throw new Error('Invalid device authorization response.');
    const verification = secureUrl(device.verification_uri);
    const complete = device.verification_uri_complete
      ? secureUrl(device.verification_uri_complete)
      : verification;
    if (complete.origin !== verification.origin)
      throw new Error('Verification URL origin mismatch.');
    const deadline = now() + device.expires_in * 1000;
    const pollSignal = AbortSignal.any([
      active,
      AbortSignal.timeout(device.expires_in * 1000),
    ]);
    let interval = (device.interval ?? 5) * 1000;
    write(
      `Confirm that the browser shows this same code: ${device.user_code}\nOpen this URL on this or another device:\n${complete.href}\n`,
    );
    if (browser) {
      try {
        await open(complete.href);
      } catch {
        write(
          'Could not open a browser. Open the link above manually; login is still waiting.\n',
        );
      }
    }
    write('Waiting for authorization…\n');
    while (now() < deadline) {
      active.throwIfAborted();
      await wait(Math.min(interval, deadline - now()), undefined, {
        signal: pollSignal,
      });
      if (now() >= deadline) break;
      let tokenResponse;
      try {
        tokenResponse = await post(
          metadata.token_endpoint,
          {
            grant_type: DEVICE_GRANT_TYPE,
            client_id: CLI_CLIENT_ID,
            device_code: device.device_code,
          },
          pollSignal,
        );
      } catch (error) {
        pollSignal.throwIfAborted();
        if (
          (error as Error).name !== 'TimeoutError' &&
          !(error instanceof TypeError)
        )
          throw error;
        interval = Math.min(interval * 2, device.expires_in * 1000);
        continue;
      }
      if (tokenResponse.status === 429 || tokenResponse.status >= 500) {
        const retry = Number(tokenResponse.headers.get('Retry-After'));
        interval = Math.max(
          interval + 5000,
          Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0,
        );
        await tokenResponse.body?.cancel();
        continue;
      }
      const tokens = await tokenResponse.json();
      if (tokenResponse.ok) {
        await provider.saveTokens(OAuthTokensSchema.parse(tokens));
        return;
      }
      if (tokens.error === 'authorization_pending') continue;
      if (tokens.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw oauthFailure(tokens, tokenResponse.status);
    }
    throw new Error('Device code expired. Run hyper3d auth login again.');
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' ||
        (error.cause as Error)?.name === 'TimeoutError')
    )
      throw new Error('Login timed out. Run hyper3d auth login again.');
    throw error;
  } finally {
    process.removeListener('SIGINT', stop);
  }
}
