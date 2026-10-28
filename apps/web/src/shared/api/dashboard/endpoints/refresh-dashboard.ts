import { dashboardStateSchema } from '@hth/contracts';
import { dashboardRequest } from '../dashboard-http-client';

export async function refreshDashboard() {
  return dashboardStateSchema.parse(await dashboardRequest('/v1/dashboard/refresh', 'POST'));
}
