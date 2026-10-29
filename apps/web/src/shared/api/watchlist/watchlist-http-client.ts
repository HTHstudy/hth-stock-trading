import { ENV } from '@shared/config/env';
import { notifyUnauthorized } from '@shared/lib/auth-events';
export async function watchlistRequest(method: 'GET' | 'POST', signal?: AbortSignal, body?: unknown): Promise<unknown> {
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(`${ENV.API_URL}/v1/watchlist`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'content-type': 'application/json', 'x-hth-dashboard': '1' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  notifyUnauthorized(response.status);
  if (!response.ok) throw new Error(response.status === 409 ? 'WATCHLIST_REVISION_CONFLICT' : 'WATCHLIST_UNCONFIRMED');
  return response.json();
}
