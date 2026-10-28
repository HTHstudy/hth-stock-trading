import { lazy, Suspense, useEffect, useState } from 'react';
import { OverviewPage } from '@pages/overview';
import { PATHS } from '@shared/routes/paths';
import './global.css';
import { Providers } from './providers';

const BacktestsPage = lazy(() => import('@pages/backtests').then((module) => ({ default: module.BacktestsPage })));
const PaperPage = lazy(() => import('@pages/paper').then((module) => ({ default: module.PaperPage })));

export function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const change = () => setHash(window.location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const backtests = hash === PATHS.BACKTESTS;
  const paper = hash === PATHS.PAPER;
  const navigation = [
    { path: PATHS.HOME, label: '계좌 현황', active: !backtests && !paper },
    { path: PATHS.BACKTESTS, label: '백테스트', active: backtests },
    { path: PATHS.PAPER, label: 'Paper 모의매매', active: paper },
  ];
  return (
    <Providers>
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-slate-800/80 bg-[#0d1424] px-5 py-8 xl:flex">
        <a href={PATHS.HOME} className="flex items-center gap-3 text-lg font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-teal-300 text-sm text-slate-950">H</span>HTH
          Trading
        </a>
        <p className="mt-10 px-3 text-[10px] font-semibold tracking-[0.2em] text-slate-500">WORKSPACE</p>
        <nav aria-label="주 메뉴" className="mt-4 space-y-2 text-sm">
          {navigation.map((item) => (
            <a
              key={item.path}
              href={item.path}
              aria-current={item.active ? 'page' : undefined}
              className={`block rounded-lg px-3 py-3 ${item.active ? 'bg-teal-300/10 font-medium text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <p className="mt-auto rounded-xl border border-slate-800 p-4 text-xs leading-6 text-slate-400">
          <span className="font-medium text-amber-200">실제 주문 비활성</span>
          <br />
          Paper는 별도 모의 원장으로 운영합니다.
        </p>
      </aside>
      <nav aria-label="모바일 주 메뉴" className="flex gap-3 border-b border-slate-800 px-5 py-3 text-xs xl:hidden">
        {navigation.map((item) => (
          <a
            key={item.path}
            href={item.path}
            aria-current={item.active ? 'page' : undefined}
            className={`rounded-lg px-4 py-2 ${item.active ? 'bg-teal-300/10 text-teal-200' : 'text-slate-400'}`}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <Suspense fallback={<p className="p-10 text-sm text-slate-400 xl:ml-56">화면을 불러오고 있습니다…</p>}>
        {paper ? <PaperPage /> : backtests ? <BacktestsPage /> : <OverviewPage />}
      </Suspense>
    </Providers>
  );
}
