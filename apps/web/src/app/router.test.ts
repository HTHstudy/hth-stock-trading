import { createMemoryHistory } from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { createAppRouter } from './router.js';
import { legacyRouteTarget } from './legacy-route.js';

it('기존 해시 링크를 검색 조건을 보존한 일반 경로로 교체하고 이력을 늘리지 않는다', () => {
  for (const [hash, path] of [
    ['#overview', '/'],
    ['#backtests', '/backtests'],
    ['#paper', '/paper'],
    ['#observations', '/observations'],
  ]) {
    expect(legacyRouteTarget({ pathname: '/', hash: hash!, search: '?filter=recent' })).toBe(path + '?filter=recent');
  }
  const history = createMemoryHistory({ initialEntries: ['/#observations?ignored', '/?filter=recent#observations'] });
  createAppRouter(history);
  expect(history.location.href).toBe('/observations?filter=recent');
  expect(history.length).toBe(2);
  history.back();
  expect(history.location.href).toBe('/#observations?ignored');
  for (const path of ['/paper', '/backtests', '/observations']) {
    expect(legacyRouteTarget({ pathname: path, hash: '#paper', search: '' })).toBeNull();
  }
  for (const hash of ['#unknown', '#constructor', '#__proto__']) {
    expect(legacyRouteTarget({ pathname: '/', hash, search: '' })).toBeNull();
  }
});

it('일반 경로를 매칭하고 뒤로가기·앞으로가기로 같은 화면 경로를 복원한다', async () => {
  const history = createMemoryHistory({ initialEntries: ['/'] });
  const router = createAppRouter(history);
  for (const path of ['/backtests', '/paper', '/observations']) {
    history.push(path);
    expect(router.matchRoutes(history.location.pathname).at(-1)?.routeId).toBe(path);
  }
  history.back();
  expect(history.location.pathname).toBe('/paper');
  history.forward();
  expect(history.location.pathname).toBe('/observations');
  const missingRouter = createAppRouter(createMemoryHistory({ initialEntries: ['/missing-page'] }));
  await missingRouter.load();
  expect(missingRouter.state.matches.some((match) => match._notFound || match.status === 'notFound')).toBe(true);
});
