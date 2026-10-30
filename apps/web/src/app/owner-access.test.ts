import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { OwnerAccess } from './owner-access.js';

it('미인증·인증 미설정·세션 확인 중에는 보호된 라우트를 렌더링하지 않는다', () => {
  for (const configured of [undefined, false, true]) {
    const client = new QueryClient();
    if (configured !== undefined)
      client.setQueryData(['owner-session'], { configured, authenticated: false, expiresAt: null });
    const privatePage = vi.fn(() => createElement('p', null, 'PRIVATE_ROUTE'));
    const html = renderToString(
      createElement(QueryClientProvider, {
        client,
        children: createElement(OwnerAccess, { children: createElement(privatePage) }),
      }),
    );
    expect(privatePage).not.toHaveBeenCalled();
    expect(html).not.toContain('PRIVATE_ROUTE');
    client.clear();
  }
});

it('인증을 확인한 세션에만 보호된 라우트를 렌더링한다', () => {
  const client = new QueryClient();
  client.setQueryData(['owner-session'], { configured: true, authenticated: true, expiresAt: null });
  const html = renderToString(
    createElement(QueryClientProvider, {
      client,
      children: createElement(OwnerAccess, { children: createElement('p', null, 'PRIVATE_ROUTE') }),
    }),
  );
  expect(html).toContain('PRIVATE_ROUTE');
  client.clear();
});
