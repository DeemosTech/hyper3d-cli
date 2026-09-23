import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { z } from 'zod';

import { loadCredentials, createProvider } from './auth.js';
import { endpoints, secureUrl } from './endpoints.js';

const WALLET_UNITS_PER_CREDIT = 10;

const identitySchema = z.object({
  user_uuid: z.string().min(1),
  username: z.string(),
});
const personalMetaSchema = identitySchema.extend({
  balance: z.number(),
  frozen: z.number(),
  subscriptions: z.object({
    active_subscriptions: z.array(z.object({ wallet_balance: z.number() })),
  }),
});
const accountResponseSchema = z.object({
  meta: identitySchema.passthrough(),
  billing_workspace: z.discriminatedUnion('type', [
    z.object({ type: z.literal('personal') }),
    z.object({ type: z.literal('group'), group_uuid: z.string().min(1) }),
  ]),
});
const groupResponseSchema = z.object({
  group_meta: z.object({
    uuid: z.string().min(1),
    name: z.string().optional(),
    frozen: z.number(),
  }),
  balance: z.number(),
});

function parseResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid account response: ${details}`);
  }
  return result.data;
}

export async function accountInfo({ fetchFn = fetch } = {}) {
  const endpoint = endpoints.mcp;
  const data = await loadCredentials(endpoint);
  let accessToken = data.tokens?.access_token;
  if (!accessToken) return { authenticated: false };

  const request: typeof fetch = async (input, init = {}) => {
    secureUrl(input);
    return fetchFn(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(init.signal ? [init.signal] : []),
      ]),
    });
  };

  const provider = data.clientId
    ? createProvider(endpoint, data, request)
    : undefined;
  let refreshed = false;
  const post_with_optional_token_refresh = async (
    path: string,
    body: Record<string, unknown>,
  ) => {
    const send = async () =>
      request(path, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    let response = await send();
    if (
      response.status === 401 &&
      !refreshed &&
      provider &&
      data.tokens?.refresh_token
    ) {
      refreshed = true;
      await response.body?.cancel();
      await auth(provider, {
        serverUrl: endpoint,
        fetchFn: provider.fetch,
      });
      accessToken = provider.tokens()?.access_token;
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new Error(
          'Account access denied. Run hyper3d auth login to authorize account:read and an available billing workspace.',
        );
      throw new Error(`Account lookup failed (HTTP ${response.status}).`);
    }
    const result = await response.json();
    if (result.error) throw new Error(`Account lookup failed: ${result.error}`);
    return result;
  };

  const { meta, billing_workspace: workspace } = parseResponse(
    accountResponseSchema,
    await post_with_optional_token_refresh(endpoints.userInfo, {}),
  );
  let wallet:
    | {
        type: 'personal';
        balance: number;
        frozen: number;
        subscription_balance: number;
      }
    | {
        type: 'group';
        balance: number;
        frozen: number;
        group_uuid: string;
        name?: string;
      };
  switch (workspace.type) {
    case 'personal': {
      const personal = parseResponse(personalMetaSchema, meta);
      const subscriptionBalance =
        personal.subscriptions.active_subscriptions.reduce(
          (total, subscription) => total + subscription.wallet_balance,
          0,
        );
      wallet = {
        type: 'personal',
        balance: personal.balance,
        subscription_balance: subscriptionBalance,
        frozen: personal.frozen,
      };
      break;
    }
    case 'group': {
      const result = parseResponse(
        groupResponseSchema,
        await post_with_optional_token_refresh(endpoints.groupInfo, {
          group_uuid: workspace.group_uuid,
        }),
      );
      if (result.group_meta?.uuid !== workspace.group_uuid)
        throw new Error(
          'The returned wallet does not match the authorized billing workspace.',
        );
      wallet = {
        type: 'group',
        group_uuid: workspace.group_uuid,
        name: result.group_meta.name,
        balance: result.balance,
        frozen: result.group_meta.frozen,
      };
      break;
    }
  }
  const displayedWallet = {
    ...wallet,
    balance: wallet.balance / WALLET_UNITS_PER_CREDIT,
    frozen: wallet.frozen / WALLET_UNITS_PER_CREDIT,
    ...(wallet.type === 'personal'
      ? {
          subscription_balance:
            wallet.subscription_balance / WALLET_UNITS_PER_CREDIT,
        }
      : {}),
  };
  return {
    authenticated: true,
    user: { uuid: meta.user_uuid, username: meta.username },
    wallet: displayedWallet,
  };
}
