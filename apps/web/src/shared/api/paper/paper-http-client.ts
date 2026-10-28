import { ENV } from '@shared/config/env';

export async function paperRequest(path: string, method: 'GET' | 'POST', signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${ENV.API_URL}/v1/paper${path}`, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(method === 'POST'
      ? { headers: { 'Content-Type': 'application/json', 'x-hth-dashboard': '1' }, body: '{}' }
      : {}),
  });
  if (!response.ok) throw new Error(method === 'POST' ? 'PAPER_STOP_UNCONFIRMED' : 'PAPER_UNAVAILABLE');
  return response.json();
}
