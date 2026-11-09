import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const bootstrap = readFileSync(new URL('../apps/web/public/theme-init.js', import.meta.url), 'utf8');

it('첫 화면 전에 저장한 설정을 적용하고 시스템 테마보다 우선한다', () => {
  for (const [saved, systemDark, expected] of [
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    [null, false, 'light'],
    ['invalid', true, 'dark'],
  ] as const) {
    const element = { dataset: {}, style: {} };
    runInNewContext(bootstrap, {
      document: { documentElement: element },
      window: { localStorage: { getItem: () => saved }, matchMedia: () => ({ matches: systemDark }) },
    });
    expect(element).toEqual({ dataset: { theme: expected }, style: { colorScheme: expected } });
  }
});

it('저장소 차단이나 matchMedia 미지원에도 첫 화면 초기화가 실패하지 않는다', () => {
  const element = { dataset: {}, style: {} };
  runInNewContext(bootstrap, {
    document: { documentElement: element },
    window: {
      get localStorage() {
        throw new Error('storage disabled');
      },
    },
  });
  expect(element).toEqual({ dataset: { theme: 'light' }, style: { colorScheme: 'light' } });
});
