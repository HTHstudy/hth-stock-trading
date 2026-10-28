import { notifyUnauthorized } from '@shared/lib/auth-events';
import { ENV } from '@shared/config/env';

export async function backtestsRequest(path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(`${ENV.API_URL}/v1/backtests${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  notifyUnauthorized(response.status);
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'REPORT_NOT_FOUND'
        : response.status === 503
          ? 'REPORTS_UNAVAILABLE'
          : 'REPORT_REQUEST_FAILED',
    );
  return response.json();
}
