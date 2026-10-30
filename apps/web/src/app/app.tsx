import { useEffect } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import './global.css';
import { Providers } from './providers';
import { OwnerAccess } from './owner-access';
import { createAppRouter } from './router';
import { legacyRouteTarget } from './legacy-route';

// Browser history owns window listeners; create it once outside StrictMode renders.
const router = createAppRouter();
if (import.meta.hot) import.meta.hot.dispose(() => router.history.destroy());

export function App() {
  useEffect(() => {
    const migrate = () => {
      const target = legacyRouteTarget(window.location);
      if (target) router.history.replace(target);
    };
    window.addEventListener('hashchange', migrate);
    return () => window.removeEventListener('hashchange', migrate);
  }, []);
  return (
    <Providers>
      <OwnerAccess>
        <RouterProvider router={router} />
      </OwnerAccess>
    </Providers>
  );
}
