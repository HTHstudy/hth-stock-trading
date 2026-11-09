import { Link, Outlet } from '@tanstack/react-router';
import { PATHS } from '@shared/routes/paths';

const navigation = [
  { path: PATHS.HOME, label: '계좌 현황' },
  { path: PATHS.BACKTESTS, label: '백테스트' },
  { path: PATHS.RESEARCH, label: '전략 연구' },
  { path: PATHS.PAPER, label: 'Paper 모의매매' },
  { path: PATHS.OBSERVATIONS, label: '시세 관측' },
];

export function Layout() {
  return (
    <>
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-line/80 bg-panel px-5 py-8 xl:flex">
        <Link to={PATHS.HOME} className="flex items-center gap-3 text-lg font-bold tracking-tight">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-fill text-sm text-on-accent">H</span>HTH
          Trading
        </Link>
        <p className="mt-10 px-3 text-[10px] font-semibold tracking-[0.2em] text-subtle">WORKSPACE</p>
        <nav aria-label="주 메뉴" className="mt-4 space-y-2 text-sm">
          {navigation.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              activeOptions={{ exact: true }}
              className="block rounded-lg px-3 py-3"
              activeProps={{ className: 'bg-accent-fill/10 font-medium text-accent' }}
              inactiveProps={{ className: 'text-muted hover:bg-hover' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <p className="mt-auto rounded-xl border border-line p-4 text-xs leading-6 text-muted">
          <span className="font-medium text-warning">실제 주문 비활성</span>
          <br />
          Paper는 별도 모의 원장으로 운영합니다.
        </p>
      </aside>
      <nav
        aria-label="모바일 주 메뉴"
        className="flex gap-3 overflow-x-auto whitespace-nowrap border-b border-line px-5 py-3 text-xs xl:hidden"
      >
        {navigation.map((item) => (
          <Link
            key={item.path}
            to={item.path}
            activeOptions={{ exact: true }}
            className="rounded-lg px-4 py-2"
            activeProps={{ className: 'bg-accent-fill/10 text-accent' }}
            inactiveProps={{ className: 'text-muted' }}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
