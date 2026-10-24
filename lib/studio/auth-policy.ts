const HUB_ORIGINS = new Set(['https://humanstudy-hub.com', 'https://www.humanstudy-hub.com', 'https://forum.humanstudy-hub.com']);

export function accountReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 92)) return undefined;
  try {
    const url = new URL(value);
    const local = process.env.NODE_ENV !== 'production' && process.env.HUB_AUTH_ALLOW_LOCAL_RETURN === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
    if ((!HUB_ORIGINS.has(url.origin) && !local) || url.username || url.password || url.hash) return undefined;
    if (url.pathname === '/account' || url.pathname.startsWith('/account/') || url.pathname.startsWith('/auth/')) return undefined;
    for (const key of ['access_token', 'refresh_token', 'token_hash', 'token', 'code']) if (url.searchParams.has(key)) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function sharedCookieDomain(): string | undefined {
  const domain = process.env.HUB_AUTH_COOKIE_DOMAIN;
  if (!domain) return undefined;
  if (process.env.NODE_ENV !== 'production' || domain !== '.humanstudy-hub.com' || process.env.HUB_AUTH_ORIGIN !== 'https://humanstudy-hub.com') throw new Error('Invalid shared account cookie configuration');
  return domain;
}

export function accountPath(returnTo?: string, path = '/account'): string {
  const destination = accountReturnTo(returnTo);
  return destination ? `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(destination)}` : path;
}

export function emailCallbackReturnTo(params: Record<string, string | string[] | undefined>, destination: 'confirm' | 'reset'): string | undefined {
  const direct = accountReturnTo(params.returnTo);
  if (direct) return direct;
  const callback = params.callback;
  if (typeof callback !== 'string' || callback.length > 8192 || [...callback].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 92)) return undefined;
  try {
    const url = new URL(callback);
    if (url.origin !== 'https://humanstudy-hub.com' || url.pathname !== `/auth/${destination}` || url.username || url.password || url.hash) return undefined;
    if (url.searchParams.getAll('returnTo').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'returnTo')) return undefined;
    return accountReturnTo(url.searchParams.get('returnTo'));
  } catch { return undefined; }
}
