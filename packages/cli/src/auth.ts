import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
} from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { lock } from 'proper-lockfile';

import { secureUrl } from './endpoints.js';
import { getConfigDir } from './utils.js';

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
  return join(getConfigDir(), `${key}.json`);
}
export async function loadCredentials(endpoint: string): Promise<Credentials> {
  try {
    return JSON.parse(await readFile(credentialPath(endpoint), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
async function atomicWrite(path: string, contents: string) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, contents, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function saveCredentials(endpoint: string, data: Credentials) {
  await atomicWrite(credentialPath(endpoint), `${JSON.stringify(data)}\n`);
}

async function assertCredentialsWritable(endpoint: string) {
  // Exercise the same create/rename/remove operations as token persistence.
  // Permission bits alone cannot detect a sandbox denying directory writes.
  const probe = `${credentialPath(endpoint)}.${randomBytes(8).toString('hex')}.probe`;
  try {
    await atomicWrite(probe, '');
    await rm(probe, { force: true });
  } catch (cause) {
    throw new Error(
      'Cannot write the credential store. Allow writes to the Hyper3D config directory before retrying; no token refresh was attempted.',
      { cause },
    );
  }
}
export async function logout(endpoint: string) {
  await withCredentialLock(endpoint, async () => {
    await rm(credentialPath(endpoint), { force: true });
  });
}

async function withCredentialLock<T>(
  endpoint: string,
  action: (signal: AbortSignal) => Promise<T>,
) {
  await assertCredentialsWritable(endpoint);
  const path = credentialPath(endpoint);
  const canonical = join(await realpath(dirname(path)), basename(path));
  const compromised = new AbortController();
  const release = await lock(canonical, {
    realpath: false,
    stale: 60000,
    update: 10000,
    retries: {
      retries: 40,
      factor: 1,
      minTimeout: 250,
      maxTimeout: 250,
      randomize: true,
    },
    onCompromised: (error) => compromised.abort(error),
  });
  try {
    const result = await action(compromised.signal);
    compromised.signal.throwIfAborted();
    return result;
  } finally {
    // proper-lockfile already relinquishes compromised locks. Never remove a
    // replacement owner's lock from a resumed process.
    if (!compromised.signal.aborted) await release();
  }
}

export function createProvider(
  endpoint: string,
  data: Credentials,
  fetchFn: typeof fetch = fetch,
) {
  if (data.clientId && data.clientId !== CLI_CLIENT_ID)
    throw new Error(
      'Stored credentials belong to a different client. Run hyper3d auth login again.',
    );
  data = { ...data, clientId: CLI_CLIENT_ID };
  const metadata = clientMetadata();
  const persistedResponses = new Map<string, number>();
  const acknowledgeLater = (tokens: OAuthTokens) => {
    const key = tokens.access_token;
    persistedResponses.set(key, (persistedResponses.get(key) ?? 0) + 1);
  };
  const persist = async (tokens: OAuthTokens) => {
    const updated = {
      ...data,
      tokens: {
        ...tokens,
        refresh_token: tokens.refresh_token ?? data.tokens?.refresh_token,
      },
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
    };
    await saveCredentials(endpoint, updated);
    data = updated;
  };
  return {
    // Both account HTTP requests and MCP's internal SDK auth use this fetch.
    // The token response is validated and persisted before releasing the lock;
    // saveTokens below acknowledges it without writing stale data a second time.
    fetch: (async (input, init) => {
      const params =
        init?.body instanceof URLSearchParams ? init.body : undefined;
      if (params?.get('grant_type') !== 'refresh_token')
        return fetchFn(input, init);
      const requestedAccessToken = data.tokens?.access_token;
      return withCredentialLock(endpoint, async (signal) => {
        const latest = await loadCredentials(endpoint);
        if (latest.clientId !== CLI_CLIENT_ID || !latest.tokens?.refresh_token)
          throw new Error(
            'Credentials changed or were removed. Run hyper3d auth login.',
          );
        if (
          (latest.tokens.access_token !== requestedAccessToken ||
            latest.tokens.refresh_token !== params.get('refresh_token')) &&
          latest.tokens.access_token &&
          (latest.expiresAt === undefined ||
            latest.expiresAt > Date.now() + 30000)
        ) {
          data = latest;
          acknowledgeLater(latest.tokens);
          return Response.json({
            ...latest.tokens,
            expires_in:
              latest.expiresAt === undefined
                ? undefined
                : Math.max(
                    0,
                    Math.floor((latest.expiresAt - Date.now()) / 1000),
                  ),
          });
        }
        data = latest;
        const body = new URLSearchParams(params);
        body.set('refresh_token', latest.tokens.refresh_token);
        signal.throwIfAborted();
        const response = await fetchFn(input, {
          ...init,
          body,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(15000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        // Consume success and error bodies under the lock and request timeout.
        // SDK parsing happens later, after this fetch returns.
        const text = await response.text();
        signal.throwIfAborted();
        if (response.ok) {
          const tokens = OAuthTokensSchema.parse(JSON.parse(text));
          await persist(tokens);
          acknowledgeLater(tokens);
        }
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      });
    }) as typeof fetch,
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
      const acknowledgments = persistedResponses.get(tokens.access_token) ?? 0;
      if (acknowledgments > 0) {
        if (acknowledgments === 1)
          persistedResponses.delete(tokens.access_token);
        else persistedResponses.set(tokens.access_token, acknowledgments - 1);
        return;
      }
      await withCredentialLock(endpoint, async (signal) => {
        // Defensive check for callers that bypass provider.fetch. They must not
        // overwrite credentials changed by another process or by logout.
        const latest = await loadCredentials(endpoint);
        if (
          data.tokens &&
          JSON.stringify(latest.tokens) !== JSON.stringify(data.tokens)
        )
          throw new Error(
            'Credentials changed. Retry using the saved credentials.',
          );
        signal.throwIfAborted();
        await persist(tokens);
      });
    },
    prepareTokenRequest: async () => {
      if (!data.tokens?.refresh_token)
        throw new Error('Authentication expired. Run hyper3d auth login.');
      await assertCredentialsWritable(endpoint);
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
        // SDK recovery is local to this attempt. A failed/stale process must
        // not erase credentials saved on disk by another invocation.
        delete data.tokens;
        delete data.expiresAt;
      }
    },
  };
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

type OAuthPost = (
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
) => Promise<Response>;

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval?: number;
  verificationUrl: URL;
}

async function discoverDeviceFlow(
  endpoint: string,
  provider: ReturnType<typeof createProvider>,
  request: typeof fetch,
) {
  const resourceMetadata = await discoverOAuthProtectedResourceMetadata(
    endpoint,
    undefined,
    request,
  );
  const issuer = resourceMetadata.authorization_servers?.[0];
  if (!issuer)
    throw new Error('MCP discovery did not advertise an authorization server.');
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
      'The server does not advertise Device Flow. Contact the service administrator for login support.',
    );
  if (!metadata.token_endpoint) throw new Error('Missing OAuth token endpoint');
  secureUrl(metadata.token_endpoint);

  const resource = String(
    await selectResourceURL(new URL(endpoint), provider, resourceMetadata),
  );
  return {
    deviceAuthorizationEndpoint,
    tokenEndpoint: metadata.token_endpoint,
    resource,
  };
}

async function requestDeviceAuthorization(
  deviceAuthorizationEndpoint: string,
  resource: string,
  post: OAuthPost,
): Promise<DeviceAuthorization> {
  const response = await post(deviceAuthorizationEndpoint, {
    client_id: CLI_CLIENT_ID,
    resource,
    scope: CLI_SCOPES,
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
  return {
    device_code: device.device_code,
    user_code: device.user_code,
    expires_in: device.expires_in,
    interval: device.interval,
    verificationUrl: complete,
  };
}

async function pollDeviceTokens(
  tokenEndpoint: string,
  device: DeviceAuthorization,
  post: OAuthPost,
  {
    active,
    pollSignal,
    deadline,
    wait,
    now,
  }: {
    active: AbortSignal;
    pollSignal: AbortSignal;
    deadline: number;
    wait: typeof sleep;
    now: () => number;
  },
): Promise<OAuthTokens> {
  let interval = (device.interval ?? 5) * 1000;
  while (now() < deadline) {
    active.throwIfAborted();
    await wait(Math.min(interval, deadline - now()), undefined, {
      signal: pollSignal,
    });
    if (now() >= deadline) break;

    let tokenResponse;
    try {
      tokenResponse = await post(
        tokenEndpoint,
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

    // Back off when the server is rate-limited or temporarily unavailable.
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
      return OAuthTokensSchema.parse(tokens);
    }

    if (tokens.error === 'authorization_pending') continue;
    if (tokens.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw oauthFailure(tokens, tokenResponse.status);
  }

  throw new Error('Device code expired. Run hyper3d auth login again.');
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
  await assertCredentialsWritable(endpoint);
  const provider = createProvider(endpoint, {});

  // Set up cancellation and time limits for OAuth requests.
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

  const post: OAuthPost = async (url, fields, requestSignal) =>
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
    const { deviceAuthorizationEndpoint, tokenEndpoint, resource } =
      await discoverDeviceFlow(endpoint, provider, request);
    const device = await requestDeviceAuthorization(
      deviceAuthorizationEndpoint,
      resource,
      post,
    );

    // Start the expiry clock before opening the browser for authorization.
    const deadline = now() + device.expires_in * 1000;
    const pollSignal = AbortSignal.any([
      active,
      AbortSignal.timeout(device.expires_in * 1000),
    ]);

    write(
      `Confirm that the browser shows this same code: ${device.user_code}\nOpen this URL on this or another device:\n${device.verificationUrl.href}\n`,
    );
    if (browser) {
      try {
        await open(device.verificationUrl.href);
      } catch {
        write(
          'Could not open a browser. Open the link above manually; login is still waiting.\n',
        );
      }
    }

    // Poll for tokens until authorization succeeds or the device code expires.
    write('Waiting for authorization…\n');
    const tokens = await pollDeviceTokens(tokenEndpoint, device, post, {
      active,
      pollSignal,
      deadline,
      wait,
      now,
    });
    await provider.saveTokens(tokens);
  } catch (error) {
    // Surface cancellation and timeouts as login errors.
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
