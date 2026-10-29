import { ENV } from '@shared/config/env';
import { notifyUnauthorized } from '@shared/lib/auth-events';

export async function observationsRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`${ENV.API_URL}/v1/observations${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  notifyUnauthorized(response.status);
  if (!response.ok) throw new Error(response.status === 404 ? 'OBSERVATION_NOT_FOUND' : 'OBSERVATIONS_UNAVAILABLE');
  return response.json();
}
