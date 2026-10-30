import { PATHS } from '@shared/routes/paths';

const legacyPaths: Record<string, string> = {
  '#overview': PATHS.HOME,
  '#backtests': PATHS.BACKTESTS,
  '#paper': PATHS.PAPER,
  '#observations': PATHS.OBSERVATIONS,
};

export function legacyRouteTarget(location: { pathname: string; hash: string; search: string }) {
  if (location.pathname !== '/' || !Object.hasOwn(legacyPaths, location.hash)) return null;
  return legacyPaths[location.hash]! + location.search;
}
