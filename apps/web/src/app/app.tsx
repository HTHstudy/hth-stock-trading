import { OverviewPage } from '@pages/overview';
import './global.css';
import { Providers } from './providers';

export function App() {
  return (
    <Providers>
      <OverviewPage />
    </Providers>
  );
}
