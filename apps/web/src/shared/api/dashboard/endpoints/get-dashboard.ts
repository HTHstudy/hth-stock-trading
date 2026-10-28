import { dashboardStateSchema } from '@hth/contracts';
import { dashboardRequest } from '../dashboard-http-client';

export async function getDashboard(signal?: AbortSignal) {
  return dashboardStateSchema.parse(await dashboardRequest('/v1/dashboard', 'GET', signal));
}
