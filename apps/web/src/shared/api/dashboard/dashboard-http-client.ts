import { ENV } from '@shared/config/env';

export async function dashboardRequest(path: string, method: 'GET' | 'POST', signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(`${ENV.API_URL}${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', 'X-HTH-Dashboard': '1' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'REFRESH_NOT_AVAILABLE' : 'DASHBOARD_UNAVAILABLE');
  return response.json();
}
