import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import type { RouterHistory } from '@tanstack/react-router';
import { PATHS } from '@shared/routes/paths';
import { Layout } from './layout';
import { legacyRouteTarget } from './legacy-route';

const rootRoute = createRootRoute({
  component: Layout,
});
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PATHS.HOME,
  component: lazyRouteComponent(() => import('@pages/overview'), 'OverviewPage'),
});
const backtestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PATHS.BACKTESTS,
  component: lazyRouteComponent(() => import('@pages/backtests'), 'BacktestsPage'),
});
const paperRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PATHS.PAPER,
  component: lazyRouteComponent(() => import('@pages/paper'), 'PaperPage'),
});
const observationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PATHS.OBSERVATIONS,
  component: lazyRouteComponent(() => import('@pages/observations'), 'ObservationsPage'),
});
const routeTree = rootRoute.addChildren([overviewRoute, backtestsRoute, paperRoute, observationsRoute]);

export function createAppRouter(history: RouterHistory = createBrowserHistory()) {
  const target = legacyRouteTarget(history.location);
  if (target) history.replace(target);
  return createRouter({
    routeTree,
    history,
    defaultPendingComponent: () => (
      <p role="status" className="p-10 text-sm text-slate-400 xl:ml-56">
        화면을 불러오고 있습니다…
      </p>
    ),
    defaultErrorComponent: () => (
      <p role="alert" className="p-10 text-sm text-rose-200 xl:ml-56">
        화면을 불러오지 못했습니다. 새로고침해 주세요.
      </p>
    ),
    defaultNotFoundComponent: () => (
      <p role="alert" className="p-10 text-sm text-slate-400 xl:ml-56">
        존재하지 않는 페이지입니다.
      </p>
    ),
    defaultPreload: false,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
