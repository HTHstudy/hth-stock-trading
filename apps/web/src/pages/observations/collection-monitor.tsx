import type { ObservationReport } from '@hth/contracts';
import { formatTime } from '@shared/lib/format';

const labels = {
  recent: '최근 기록 수신',
  overdue: '기록 갱신 지연',
  'awaiting-finalization': '최종 종료 기록 대기',
  terminal: '종료 기록 확인',
  'clock-unverified': '기록 시각 검토 필요',
};
const seconds = (value: number) => new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(value / 1000);
export function CollectionMonitor({ report }: { report: ObservationReport }) {
  const item = report.monitoring;
  if (!item) return null;
  const warning = item.state === 'overdue' || item.state === 'clock-unverified' || item.gapCount > 0;
  return (
    <section
      className={`mb-5 rounded-xl border p-5 ${warning ? 'border-amber-300/30 bg-amber-300/5' : 'border-slate-800 bg-[#0d1424]'}`}
    >
      <h2 className="text-sm font-semibold">수집 연속성 · {labels[item.state]}</h2>
      {warning && (
        <p role="alert" className="mt-3 text-xs leading-6 text-amber-100">
          {item.state === 'overdue' ? '기록 갱신 기한을 넘겼습니다. 프로세스·절전·저장 상태를 확인하세요. ' : ''}
          {item.gapCount > 0
            ? `설정 간격을 초과한 수집 공백이 ${item.gapCount}회 있습니다. 데이터 품질이 정상이어도 연속 수집 검증 완료는 아닙니다.`
            : ''}
          {item.state === 'clock-unverified' ? '시각 역행·미래 기록이 있어 현재 수집 상태를 판정할 수 없습니다.' : ''}
        </p>
      )}
      <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-slate-500">마지막 저장</dt>
          <dd className="mt-2">{item.lastRecordedAt ? formatTime(item.lastRecordedAt) : '기록 없음'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">마지막 수집 성공</dt>
          <dd className="mt-2">{item.lastSuccessfulAt ? formatTime(item.lastSuccessfulAt) : '성공 기록 없음'}</dd>
        </div>
        <div>
          <dt className="text-slate-500">기록 / 요청</dt>
          <dd className="mt-2">
            {report.recordedSamples} / {report.manifest.samples}회
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">갱신 기한</dt>
          <dd className="mt-2">{item.deadlineAt ? formatTime(item.deadlineAt) : '대상 없음'}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs leading-6 text-slate-400">
        {item.evidence === 'provisional'
          ? '최종 해시 검증 전의 임시 기록입니다. 완료·프로세스 생존·거래 준비를 의미하지 않습니다.'
          : '최종 해시가 확인된 기록의 수집 간격입니다.'}{' '}
        판정 시각 {formatTime(item.asOf)} · 허용 추가 지연 {seconds(item.graceMs)}초.
        {item.partialWrite ? ' 마지막 쓰기가 진행 중일 수 있어 미완성 줄은 제외했습니다.' : ''}
      </p>
      {item.recentGaps.length > 0 && (
        <ul className="mt-3 space-y-2 text-xs text-amber-100">
          {item.recentGaps.map((gap) => (
            <li key={gap.beforeIndex}>
              {gap.afterIndex} → {gap.beforeIndex}회 · {formatTime(gap.from)} → {formatTime(gap.to)} · 대기{' '}
              {seconds(gap.waitMs)}초 / 예정 간격 초과 {seconds(gap.excessWaitMs)}초
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs leading-6 text-slate-500">
        공백만으로 원인을 확정하지 않습니다. PC·API가 절전/중단되면 화면도 갱신되지 않으며, 이 표시는 자동 복구나 매매
        재개를 수행하지 않습니다.
      </p>
    </section>
  );
}
