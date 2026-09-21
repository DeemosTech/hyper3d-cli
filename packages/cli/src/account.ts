import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

import { loadCredentials, createProvider, secureUrl } from './auth.js';
import { resolveEndpoints } from './endpoints.js';

const WALLET_UNITS_PER_CREDIT = 10;

export async function accountInfo(baseUrl: string, { fetchFn = fetch } = {}) {
  const endpoints = resolveEndpoints(baseUrl);
  const endpoint = endpoints.mcp;
  const data = await loadCredentials(endpoint);
  const provider = data.clientId ? createProvider(endpoint, data) : undefined;
  let accessToken = data.tokens?.access_token;
  if (!accessToken) return { authenticated: false };
  let refreshed = false;
  const request: typeof fetch = async (input, init = {}) => {
    secureUrl(input);
    return fetchFn(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  };
  const post = async (path: string, body: Record<string, unknown>) => {
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
      await auth(provider, { serverUrl: endpoint, fetchFn: request });
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
  const { meta, billing_workspace: workspace } = await post(
    endpoints.userInfo,
    {},
  );
  if (
    typeof meta?.user_uuid !== 'string' ||
    !meta.user_uuid ||
    typeof meta.username !== 'string'
  )
    throw new Error('Invalid user information returned by server.');
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
  if (workspace?.type === 'personal') {
    const activeSubscriptions = meta.subscriptions?.active_subscriptions;
    if (!Array.isArray(activeSubscriptions))
      throw new Error(
        'Server did not return valid subscription balances for the authorized wallet.',
      );
    const subscriptionBalance = activeSubscriptions.reduce(
      (total, subscription) => {
        if (!Number.isFinite(subscription?.wallet_balance))
          throw new Error(
            'Server did not return valid subscription balances for the authorized wallet.',
          );
        return total + subscription.wallet_balance;
      },
      0,
    );
    wallet = {
      type: 'personal',
      balance: meta.balance,
      subscription_balance: subscriptionBalance,
      frozen: meta.frozen,
    };
  } else if (
    workspace?.type === 'group' &&
    typeof workspace.group_uuid === 'string' &&
    workspace.group_uuid
  ) {
    const result = await post(endpoints.groupInfo, {
      group_uuid: workspace.group_uuid,
    });
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
  } else {
    throw new Error(
      'Server did not return the authorized billing workspace. Deploy account:read support and run hyper3d auth login.',
    );
  }
  if (!Number.isFinite(wallet.balance) || !Number.isFinite(wallet.frozen))
    throw new Error(
      'Server did not return a valid balance for the authorized wallet.',
    );
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
