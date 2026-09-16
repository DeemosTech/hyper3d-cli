import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import {loadCredentials, createProvider, secureUrl} from './auth.js';

export async function accountInfo(endpoint, {token = process.env.HYPER3D_ACCESS_TOKEN, fetchFn = fetch} = {}) {
  const base = secureUrl(endpoint);
  if (!base.pathname.replace(/\/$/, '').endsWith('/mcp'))
    throw new Error('Account lookup requires a Hyper3D endpoint ending in /mcp.');
  base.pathname = base.pathname.replace(/\/mcp\/?$/, '/');
  base.search = '';
  const data = token ? {} : await loadCredentials(endpoint);
  const provider = !token && data.clientId ? createProvider(endpoint, data) : undefined;
  let accessToken = token || data.tokens?.access_token;
  if (!accessToken) return {authenticated: false};
  let refreshed = false;
  const request = (input, init = {}) => {
    secureUrl(input);
    return fetchFn(input, {...init, redirect: 'error', signal: AbortSignal.timeout(15000)});
  };
  const post = async (path, body) => {
    const send = () => request(new URL(path, base), {
      method: 'POST', headers: {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(body),
    });
    let response = await send();
    if (response.status === 401 && !refreshed && provider && data.tokens?.refresh_token) {
      refreshed = true;
      await response.body?.cancel();
      await auth(provider, {serverUrl: endpoint, fetchFn: request});
      accessToken = provider.tokens()?.access_token;
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status))
        throw new Error('Account access denied. Run hyper3d auth login to authorize account:read and an available billing workspace.');
      throw new Error(`Account lookup failed (HTTP ${response.status}).`);
    }
    const result = await response.json();
    if (result.error) throw new Error(`Account lookup failed: ${result.error}`);
    return result;
  };
  const {meta, billing_workspace: workspace} = await post('user/get_info', {});
  if (typeof meta?.user_uuid !== 'string' || !meta.user_uuid || typeof meta.username !== 'string')
    throw new Error('Invalid user information returned by server.');
  let wallet;
  if (workspace?.type === 'personal') {
    wallet = {type: 'personal', balance: meta.balance, frozen: meta.frozen};
  } else if (workspace?.type === 'group' && typeof workspace.group_uuid === 'string' && workspace.group_uuid) {
    const result = await post('group/group_info', {group_uuid: workspace.group_uuid});
    if (result.group_meta?.uuid !== workspace.group_uuid)
      throw new Error('The returned wallet does not match the authorized billing workspace.');
    wallet = {type: 'group', group_uuid: workspace.group_uuid, name: result.group_meta.name,
      balance: result.balance, frozen: result.group_meta.frozen};
  } else {
    throw new Error('Server did not return the authorized billing workspace. Deploy account:read support and run hyper3d auth login.');
  }
  if (!Number.isFinite(wallet.balance) || !Number.isFinite(wallet.frozen))
    throw new Error('Server did not return a valid balance for the authorized wallet.');
  return {authenticated: true, user: {uuid: meta.user_uuid, username: meta.username}, wallet};
}
