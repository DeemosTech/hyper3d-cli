export const DEFAULT_BASE_URL = 'https://api.hyper3d.com/api';

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
      'URLs must use HTTPS (HTTP is allowed for localhost tests).',
    );
  return url;
}

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

export let endpoints = resolveEndpoints();

export function configureEndpoints(baseUrl: string) {
  endpoints = resolveEndpoints(baseUrl);
}
