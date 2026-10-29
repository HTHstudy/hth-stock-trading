import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PAPER_API } from '@shared/api/paper';
import { formatTime } from '@shared/lib/format';
import { strategyComparison } from './strategy-comparison';

export function StrategyHistory({ id, revision, onClose }: { id: string; revision: number; onClose: () => void }) {
  const [cursors, setCursors] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const before = cursors.at(-1);
  const query = useQuery({
    queryKey: ['paper-strategy-history', id, revision, before ?? null],
    queryFn: ({ signal }) => PAPER_API.strategyHistory(id, before, signal),
    staleTime: 5000,
  });
  const data = query.isError ? undefined : query.data;
  const previous =
    data?.entries.find((item) => item.revision === selected) ??
    data?.entries.find((item) => item.revision !== data.strategy.revision) ??
    data?.entries[0];
  const comparison = data && previous ? strategyComparison(previous, data.strategy) : [];
  return (
    <section aria-label="전략 변경 이력" className="mt-5 rounded-xl border border-teal-300/20 bg-slate-950/30 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{id} · 변경 이력</h3>
        <div className="flex gap-3 text-xs">
          <button
            disabled={query.isFetching}
            className="text-teal-200 disabled:opacity-40"
            onClick={() => void query.refetch()}
          >
            다시 읽기
          </button>
          <button className="text-slate-400" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs leading-6 text-slate-400">
        저장된 과거 조건과 같은 조회 시점의 현재 설정을 비교합니다. 등록 활성이 실행 중이라는 뜻은 아닙니다. 조회로
        설정을 복원하거나 거래를 재개하지 않습니다.
      </p>
      {query.isPending && (
        <p role="status" className="py-8 text-center text-xs text-slate-500">
          변경 이력을 읽고 있습니다…
        </p>
      )}
      {query.isError && (
        <p role="alert" className="mt-4 text-xs text-rose-300">
          이력 조회나 무결성 확인에 실패했습니다. 현재 설정과 실행 상태는 변경하지 않았습니다.
        </p>
      )}
      {data && (
        <>
          <p className="mt-3 text-xs text-slate-400">
            현재 리비전 {data.strategy.revision} ·{' '}
            {data.source === 'toss-readonly'
              ? '실제 시세 Paper'
              : data.source === 'synthetic-only'
                ? '합성 Paper'
                : '출처 미확인 계좌 · 조회 전용'}
          </p>
          {!data.entries.length && (
            <p className="py-8 text-center text-xs text-slate-500">
              이 구간에 저장된 변경 이력이 없습니다. 기록되지 않은 과거 조건을 추정하지 않습니다.
            </p>
          )}
          {data.entries.length > 0 && (
            <>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full whitespace-nowrap text-left text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {['리비전', '저장 시각(한국)', '변경 주체', '등록 활성', '구현 버전'].map((label) => (
                        <th key={label} className="px-3 py-3">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((item) => (
                      <tr
                        key={item.revision}
                        className={`border-t border-slate-800 ${previous?.revision === item.revision ? 'bg-teal-300/5' : ''}`}
                      >
                        <td className="px-3 py-3">
                          <button
                            aria-pressed={previous?.revision === item.revision}
                            className="text-teal-200 underline underline-offset-4"
                            onClick={() => setSelected(item.revision)}
                          >
                            리비전 {item.revision}
                          </button>
                        </td>
                        <td className="px-3 py-3">{formatTime(item.createdAt)}</td>
                        <td className="px-3 py-3">{item.actor === 'owner' ? '소유자 저장' : '시스템 설정'}</td>
                        <td className="px-3 py-3">{item.enabled ? '활성' : '비활성'}</td>
                        <td className="px-3 py-3">{item.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previous && (
                <div className="mt-5 overflow-x-auto">
                  <h4 className="mb-3 text-xs font-semibold">선택 이력 ↔ 현재 설정</h4>
                  <table className="w-full whitespace-nowrap text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="px-3 py-3">항목</th>
                        <th className="px-3 py-3">리비전 {previous.revision}</th>
                        <th className="px-3 py-3">현재 리비전 {data.strategy.revision}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.map((row) => (
                        <tr
                          key={row.label}
                          className={`border-t border-slate-800 ${row.changed ? 'text-teal-200' : 'text-slate-400'}`}
                        >
                          <td className="px-3 py-3">
                            {row.label}
                            {row.changed ? ' · 변경' : ''}
                          </td>
                          <td className="px-3 py-3">{row.before}</td>
                          <td className="px-3 py-3">{row.after}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
            <button
              disabled={!cursors.length || query.isFetching}
              className="text-teal-200 disabled:opacity-35"
              onClick={() => {
                setCursors(cursors.slice(0, -1));
                setSelected(null);
              }}
            >
              이전 구간
            </button>
            <button
              disabled={!data.nextBeforeRevision || query.isFetching}
              className="text-teal-200 disabled:opacity-35"
              onClick={() => {
                if (data.nextBeforeRevision) setCursors([...cursors, data.nextBeforeRevision]);
                setSelected(null);
              }}
            >
              더 오래된 이력
            </button>
            <button
              disabled={!cursors.length || query.isFetching}
              className="text-slate-400 disabled:opacity-35"
              onClick={() => {
                setCursors([]);
                setSelected(null);
              }}
            >
              최신 이력
            </button>
            <span className="text-slate-500">페이지당 최대 20개</span>
          </div>
        </>
      )}
    </section>
  );
}
