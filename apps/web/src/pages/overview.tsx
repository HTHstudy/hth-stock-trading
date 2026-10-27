const milestones = [
  ['01', '기반 구축', '설계 문서와 프로젝트 실행 환경을 구성하고 있습니다.'],
  ['02', '데이터 연동', '국내·미국 시세와 계좌의 읽기 전용 연동을 준비합니다.'],
  ['03', '전략 검증', '이동평균 교차 전략을 백테스트와 Paper Trading으로 검증합니다.'],
] as const;

export function OverviewPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <span className="text-sm font-semibold tracking-widest text-slate-300">HTH / TRADING</span>
        <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-xs text-amber-200">
          PAPER · 실행 기능 미구현
        </span>
      </header>
      <section className="py-14">
        <p className="text-sm text-teal-300">국내 · 미국주식 통합 관리</p>
        <h1 className="mt-4 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
          전략을 검증하고,
          <br />
          거래를 관리하는 공간.
        </h1>
        <p className="mt-6 max-w-xl leading-7 text-slate-400">
          현재는 프로젝트 기반 구축 단계입니다. 계좌 연결, 시세 수집, 주문 실행은 아직 제공하지 않습니다.
        </p>
      </section>
      <section aria-label="개발 단계" className="grid gap-4 sm:grid-cols-3">
        {milestones.map(([step, title, description]) => (
          <article key={step} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
            <span className="font-mono text-xs text-teal-300">{step}</span>
            <h2 className="mt-5 text-lg font-medium">{title}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-400">{description}</p>
          </article>
        ))}
      </section>
      <footer className="mt-10 text-xs leading-6 text-slate-500">
        이 화면은 서버의 실시간 운영 상태를 표시하지 않습니다. 실제 자산으로 주문하지 않습니다.
      </footer>
    </main>
  );
}
