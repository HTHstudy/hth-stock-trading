import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, parseThemePreference } from '@shared/lib/theme';
import { ThemeControl } from './theme-control';

afterEach(() => vi.unstubAllGlobals());

it('테마 입력은 라이트·다크만 명시 값으로 허용하고 나머지는 시스템 설정을 따른다', () => {
  expect(parseThemePreference('light')).toBe('light');
  expect(parseThemePreference('dark')).toBe('dark');
  for (const value of [null, undefined, 'system', 'unexpected', {}, '<script>'])
    expect(parseThemePreference(value)).toBe('system');
});

it('저장한 테마를 선택하고 키는 화면 설정만 읽는다', () => {
  const getItem = vi.fn(() => 'light');
  vi.stubGlobal('window', { localStorage: { getItem }, matchMedia: () => ({ matches: true }) });
  const html = renderToStaticMarkup(createElement(ThemeProvider, { children: createElement(ThemeControl) }));
  expect(html.match(/<button[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/)?.[1]).toBe('라이트');
  expect(html).toContain('라이트');
  expect(html).toContain('화면 테마');
  expect(getItem).toHaveBeenCalledExactlyOnceWith('hth-theme');
});

it('저장소가 차단돼도 테마 선택 UI를 표시한다', () => {
  vi.stubGlobal('window', {
    get localStorage() {
      throw new Error('storage disabled');
    },
    matchMedia: () => ({ matches: false }),
  });
  const html = renderToStaticMarkup(createElement(ThemeProvider, { children: createElement(ThemeControl) }));
  expect(html.match(/<button[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/)?.[1]).toBe('시스템');
});
