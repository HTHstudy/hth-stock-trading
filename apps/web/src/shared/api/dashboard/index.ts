import { getDashboard } from './endpoints/get-dashboard';
import { refreshDashboard } from './endpoints/refresh-dashboard';

export const DASHBOARD_API = { get: getDashboard, refresh: refreshDashboard };
export type { DashboardSnapshot, DashboardState } from '@hth/contracts';
export type { DataBlocker, MarketDataQuality } from '@hth/contracts';
