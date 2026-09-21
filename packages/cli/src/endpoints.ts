import { secureUrl } from './auth.js';

export const DEFAULT_BASE_URL = 'https://api.hyper3d.com/api';

export function resolveEndpoints(value = DEFAULT_BASE_URL) {
  const base = secureUrl(value);
  if (base.search) throw new Error('BASE_URL must not contain a query string.');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return {
    baseUrl: base.href,
    mcp: new URL('mcp', base).href,
    userInfo: new URL('user/get_info', base).href,
    groupInfo: new URL('group/group_info', base).href,
  };
}
