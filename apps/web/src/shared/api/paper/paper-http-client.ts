import { notifyUnauthorized } from '@shared/lib/auth-events';
import { ENV } from '@shared/config/env';

export async function paperRequest(
  path: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
  body: unknown = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${ENV.API_URL}/v1/paper${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(method === 'POST'
      ? { headers: { 'Content-Type': 'application/json', 'x-hth-dashboard': '1' }, body: JSON.stringify(body) }
      : {}),
  });
  notifyUnauthorized(response.status);
  if (!response.ok)
    throw new Error(
      method === 'GET' && path.startsWith('/strategies/')
        ? 'PAPER_STRATEGY_HISTORY_UNAVAILABLE'
        : response.status === 409
          ? 'PAPER_STRATEGY_REVISION_CONFLICT'
          : path.startsWith('/strategies/')
            ? 'PAPER_STRATEGY_UPDATE_UNCONFIRMED'
            : method === 'POST'
              ? 'PAPER_STOP_UNCONFIRMED'
              : 'PAPER_UNAVAILABLE',
    );
  return response.json();
}
