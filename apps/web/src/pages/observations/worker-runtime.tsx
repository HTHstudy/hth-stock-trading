import { useQuery } from '@tanstack/react-query';
import { workerStatusSchema } from '@hth/contracts';
import { ENV } from '@shared/config/env';
import { notifyUnauthorized } from '@shared/lib/auth-events';
import { formatTime } from '@shared/lib/format';
const modes = { idle: '대기', observe: '시세 관측', paper: 'Paper 관측·정지 복구' };
const states = {
  idle: '대기 중',
  starting: '시작 확인 중',
  observing: '관측 작업 중',
  paused: 'Paper 매매 정지',
  waiting: '시장 대기',
  completed: '작업 완료',
  failed: '작업 실패',
  stopped: '정지',
  'awaiting-request': '이미 처리한 요청 · 새 요청 대기',
};
export function WorkerRuntimePanel() {
  const query = useQuery({
    queryKey: ['worker-runtime'],
    refetchInterval: 10000,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${ENV.API_URL}/v1/worker`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      notifyUnauthorized(response.status);
      if (!response.ok) throw new Error('WORKER_STATUS_UNAVAILABLE');
      return workerStatusSchema.parse(await response.json());
    },
  });
  const status = query.isError ? undefined : query.data;
  const runtime = status?.runtime;
  const warning = Boolean(
    status &&
    (status.availability === 'stale' ||
      status.availability === 'clock-unverified' ||
      status.progress === 'overdue' ||
      runtime?.state === 'failed'),
  );
  return (
    <section
      className={`mb-5 rounded-xl border p-5 ${warning ? 'border-amber-300/30 bg-amber-300/5' : 'border-slate-800 bg-[#0d1424]'}`}
    >
      <h2 className="text-sm font-semibold">worker 운영 상태</h2>
      {query.isPending && <p className="mt-3 text-xs text-slate-400">상태 기록을 확인하고 있습니다…</p>}
      {query.isError && (
        <p role="alert" className="mt-3 text-xs text-rose-200">
          현재 상태를 조회하지 못했습니다. 이전 기록을 정상 상태로 표시하지 않습니다.
        </p>
      )}
      {status && !runtime && (
        <p className="mt-3 text-xs text-slate-400">
          확인 가능한 worker 상태 기록이 없습니다. 종료·미실행·파일 검증 실패를 구분할 증거가 없습니다.
        </p>
      )}
      {status && runtime && (
        <>
          <p className="mt-3 text-sm">
            {modes[runtime.mode]} · {states[runtime.state]} ·{' '}
            {runtime.source === 'synthetic-only' ? '합성 데이터' : '실제 시세 원천 선택'}
          </p>
          {warning && (
            <p role="alert" className="mt-3 text-xs leading-6 text-amber-100">
              {status.availability === 'stale' ? '상태 기록 갱신이 45초 넘게 지연됐습니다. ' : ''}
              {status.availability === 'clock-unverified' ? '기록 시각이 불확실합니다. ' : ''}
              {status.progress === 'overdue' ? '최근 작업 응답이 설정 기한을 넘겼습니다. ' : ''}
              {runtime.state === 'failed'
                ? `작업이 실패했습니다: ${runtime.code ?? 'WORKER_OPERATION_FAILED'}. 자동 재시도하지 않습니다.`
                : ''}
            </p>
          )}
          <dl className="mt-4 grid gap-4 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-slate-500">프로세스 상태 기록</dt>
              <dd className="mt-2">{formatTime(runtime.heartbeatAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">마지막 작업 응답</dt>
              <dd className="mt-2">{runtime.lastProgressAt ? formatTime(runtime.lastProgressAt) : '아직 없음'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">판정 시각</dt>
              <dd className="mt-2">{formatTime(status.asOf)}</dd>
            </div>
          </dl>
          {runtime.state === 'awaiting-request' && (
            <p className="mt-3 text-xs text-amber-100">
              이 관측 요청 ID는 이미 사용됐습니다. 재시작으로 같은 수집을 반복하지 않습니다.
            </p>
          )}
        </>
      )}
      <p className="mt-4 text-xs leading-6 text-slate-500">
        파일에 기록된 상태이며 거래 준비·시세 신선도·실제 프로세스 생존 보장이 아닙니다. Paper 서비스는 부팅 시 매매
        정지이며 이 화면에서 실행하거나 재개하지 않습니다.
      </p>
    </section>
  );
}
