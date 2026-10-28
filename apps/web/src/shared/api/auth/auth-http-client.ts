import { ENV } from '@shared/config/env';

export async function authRequest(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${ENV.API_URL}/v1/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json', 'x-hth-dashboard': '1' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'OWNER_RATE_LIMITED' : 'OWNER_REQUEST_FAILED');
  return response.json();
}
