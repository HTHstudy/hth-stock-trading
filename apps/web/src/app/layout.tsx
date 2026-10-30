import { Link, Outlet } from '@tanstack/react-router';
import { PATHS } from '@shared/routes/paths';

const navigation = [
  { path: PATHS.HOME, label: '계좌 현황' },
  { path: PATHS.BACKTESTS, label: '백테스트' },
  { path: PATHS.PAPER, label: 'Paper 모의매매' },
  { path: PATHS.OBSERVATIONS, label: '시세 관측' },
];

export function Layout() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-slate-800/80 bg-[#0d1424] px-5 py-8 xl:flex">
        <Link to={PATHS.HOME} className="flex items-center gap-3 text-lg font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-teal-300 text-sm text-slate-950">H</span>HTH
          Trading
        </Link>
        <p className="mt-10 px-3 text-[10px] font-semibold tracking-[0.2em] text-slate-500">WORKSPACE</p>
        <nav aria-label="주 메뉴" className="mt-4 space-y-2 text-sm">
          {navigation.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              activeOptions={{ exact: true }}
              className="block rounded-lg px-3 py-3"
              activeProps={{ className: 'bg-teal-300/10 font-medium text-teal-200' }}
              inactiveProps={{ className: 'text-slate-400 hover:bg-slate-800' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="mt-auto rounded-xl border border-slate-800 p-4 text-xs leading-6 text-slate-400">
          <span className="font-medium text-amber-200">실제 주문 비활성</span>
          <br />
          Paper는 별도 모의 원장으로 운영합니다.
        </p>
      </aside>
      <nav
        aria-label="모바일 주 메뉴"
        className="flex gap-3 overflow-x-auto whitespace-nowrap border-b border-slate-800 px-5 py-3 text-xs xl:hidden"
      >
        {navigation.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            activeOptions={{ exact: true }}
            className="rounded-lg px-4 py-2"
            activeProps={{ className: 'bg-teal-300/10 text-teal-200' }}
            inactiveProps={{ className: 'text-slate-400' }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
