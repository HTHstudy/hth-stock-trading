import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StrategyResearchSnapshot } from '@hth/contracts';
import { researchListOptions, researchSnapshotOptions } from './api';
import { executionDescription, executionKey, filterRows } from './model';
import { ResearchResults } from './results';

const selectClass = 'mt-2 w-full rounded-lg border border-line-strong bg-inset p-3 text-xs text-primary';

// App mounts its router inside OwnerAccess; no private loaders or route prefetch are used.
export function ResearchPage() {
  const [selected, setSelected] = useState('');
  const list = useQuery(researchListOptions());
  const reports = list.isError ? [] : (list.data?.reports ?? []);
  const primary = reports.find((report) => report.snapshotHash === selected) ?? reports[0];
  const hash = primary?.snapshotHash ?? '';
  const detail = useQuery(researchSnapshotOptions(hash));
  const snapshot = !detail.isError && detail.data?.snapshotHash === hash ? detail.data : undefined;
  return (
    <main className="mx-auto max-w-[1800px] px-5 py-7 text-primary sm:px-9 xl:ml-56 xl:px-10">
      <header className="flex flex-wrap items-center justify-between gap-5 border-b border-line pb-7">
        <div>
          <p className="text-xs tracking-wider text-subtle">HTH TRADING / RESEARCH</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">전략 연구</h1>
          <p className="mt-2 text-xs text-muted">저장된 후보와 매수 후 보유 벤치마크의 성과·자본 노출을 확인합니다.</p>
        </div>
        <span className="rounded-full border border-accent/20 bg-accent-fill/5 px-3 py-2 text-xs text-accent">
          탐색 연구 · 조회 전용
        </span>
      </header>
      <ResearchDisclosure
        {...(snapshot ? { entryAfterClosedCandles: snapshot.benchmark.entryAfterClosedCandles } : {})}
      />
      {list.isPending && (
        <p role="status" className="py-8">
          연구 리포트 목록을 불러오고 있습니다…
        </p>
      )}
      {list.isError && (
        <p role="alert" className="my-5 text-sm text-negative">
          연구 목록을 읽을 수 없습니다. 연결 또는 검증 상태를 확인해 주세요.
        </p>
      )}
      {list.data && (
        <p role="status" className="my-4 text-xs text-warning">
          검증 제외 {list.data.rejectedCount}개 ·{' '}
          {list.data.limited ? '읽기 한도에 도달해 일부 목록만 표시합니다.' : '목록 읽기 한도 미도달'}
        </p>
      )}
      {!list.isError && list.data && reports.length === 0 && (
        <p className="rounded-xl border border-dashed border-line-strong p-10 text-sm text-muted">
          조회할 전략 연구 리포트가 없습니다.
        </p>
      )}
      {reports.length > 0 && (
        <label className="mt-5 block rounded-xl border border-line bg-surface p-5 text-xs text-accent">
          연구 리포트
          <select className={selectClass} value={hash} onChange={(event) => setSelected(event.target.value)}>
            {reports.map((report, index) => (
              <option key={report.snapshotHash} value={report.snapshotHash}>
                {report.instrument.symbol} · {report.interval} · {report.currency} · {report.periods}개 기간 ·{' '}
                {report.rows}행 · 리포트 {index + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      {hash && detail.isPending && (
        <p role="status" className="py-8">
          선택한 연구 리포트를 불러오고 있습니다…
        </p>
      )}
      {hash && detail.isError && (
        <p role="alert" className="my-5 text-sm text-negative">
          선택한 연구 리포트를 읽거나 검증할 수 없습니다. 이전 결과를 표시하지 않습니다.
        </p>
      )}
      {snapshot && <SnapshotView key={snapshot.snapshotHash} snapshot={snapshot} />}
    </main>
  );
}

function SnapshotView({ snapshot }: { snapshot: StrategyResearchSnapshot }) {
  const [dataset, setDataset] = useState(() => snapshot.datasets[0]?.id ?? '');
  const configs = [...new Map(snapshot.rows.map((row) => [executionKey(row), row])).values()];
  const [execution, setExecution] = useState(() => (configs[0] ? executionKey(configs[0]) : ''));
  const rows = filterRows(snapshot.rows, dataset, execution);
  return (
    <>
      <section aria-label="연구 필터" className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="text-xs text-muted">
          데이터셋
          <select className={selectClass} value={dataset} onChange={(event) => setDataset(event.target.value)}>
            <option value="">전체 데이터셋</option>
            {snapshot.datasets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {item.role} · {item.request.from} ~ {item.request.to}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          체결 비용 (base / stress 등 원본 설정)
          <select className={selectClass} value={execution} onChange={(event) => setExecution(event.target.value)}>
            <option value="">전체 비용 설정</option>
            {configs.map((row, index) => (
              <option key={executionKey(row)} value={executionKey(row)}>
                설정 {index + 1} · {executionDescription(row)}
              </option>
            ))}
          </select>
        </label>
      </section>
      <ResearchResults snapshot={snapshot} rows={rows} />
      <details className="mt-5 break-all rounded-xl border border-line p-5 text-xs leading-6 text-muted">
        <summary className="cursor-pointer text-secondary">조회 근거와 평가 구간</summary>
        <p>snapshot {snapshot.snapshotHash}</p>
        <p>원본 결과 {snapshot.sourceResultHash}</p>
        <p>파일 무결성 검증 · 데이터셋 파일 재검증 없음 · 엔진 재실행 없음 · 독립 holdout 검증 없음</p>
        {snapshot.datasets.map((item) => (
          <p key={item.id}>
            {item.id} · {item.request.instrument.symbol} · {item.request.interval} · {item.request.from} ~{' '}
            {item.request.to}
          </p>
        ))}
      </details>
    </>
  );
}

export function ResearchDisclosure({ entryAfterClosedCandles }: { entryAfterClosedCandles?: number }) {
  return (
    <aside
      aria-label="연구 해석과 한계"
      className="my-5 rounded-xl border border-warning/15 bg-warning/5 p-5 text-xs leading-6 text-warning"
    >
      <p>
        사후 수집한 과거 자료를 사용한 탐색 연구이며 독립 검증이나 전략 선정·운용 승인이 아닙니다. 실제 주문을
        실행하거나 Paper 설정을 변경하지 않습니다.
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium">비교 조건과 자본 노출 해석</summary>
        <p className="mt-2">사후 수집 입력 · pointInTime=false</p>
        <p className="mt-2">
          연결된 후보와 벤치마크는 각 행의 수량·초기 자금 조건이 같으며,{' '}
          {entryAfterClosedCandles === undefined
            ? '선택한 리포트의 종료봉 대기 조건을 충족한 뒤'
            : `종료된 봉 ${entryAfterClosedCandles}개를 기다린 뒤`}{' '}
          같은 최초 판단 가능 시점부터 비교합니다. 신호 이후 다음 체결 가능 시가를 사용하고 종료 시 강제 청산하지
          않습니다. 초기 현금은 고정이며 전액 투자 가정이 아닙니다.
        </p>
        <p>
          수수료·매도세·슬리피지·호가 및 선택 규칙은 각 행의 체결 비용 가정입니다. 실제 유동성·과거
          비용·정산·배당·환전을 검증한 결과가 아닙니다. 0체결은 벤치마크 비교 미검증으로 남깁니다.
        </p>
        <p>
          보유 기간과 보유 비율은 야간·주말을 포함한 달력 시간입니다. 최대 투자 원가는 취득 대금과 매수 수수료를
          포함하고, 평균 투자 원가는 전체 평가 구간의 시간 가중 원가입니다. 최대 투자 원가 대비 순손익은 위험 조정
          알파나 연율화 비율이 아닙니다. 측정 구간이 없으면 ‘측정 구간 없음’, 구간 내 투자 원가가 없으면 ‘투자 없음’으로
          표시합니다.
        </p>
      </details>
    </aside>
  );
}
