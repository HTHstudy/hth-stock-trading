import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { paperStrategyUpdateSchema } from '@hth/contracts';
import { PAPER_API } from '@shared/api/paper';
import type { PaperDashboardSnapshot } from '@shared/api/paper';

export function StrategyEditor({
  strategy,
  onClose,
  onSaved,
}: {
  strategy: PaperDashboardSnapshot['strategies'][number];
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const [revision] = useState(strategy.revision);
  const [definition, setDefinition] = useState(
    strategy.definition ?? {
      kind: 'moving-average-cross' as const,
      instrument: { market: 'KR' as 'KR' | 'US', symbol: '005930' },
      parameters: { fastPeriod: 1, slowPeriod: 2 },
      quantity: '2',
      maxFillQuantity: '1',
    },
  );
  const [enabled, setEnabled] = useState(strategy.enabled);
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: (input: unknown) => PAPER_API.updateStrategy(strategy.id, input),
    retry: false,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['paper-dashboard'] });
      onSaved();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['paper-dashboard'] });
    },
  });
  const conflict = strategy.revision !== revision || save.error?.message === 'PAPER_STRATEGY_REVISION_CONFLICT';
  const inputClass =
    'mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-teal-300 disabled:opacity-40';
  function submit() {
    const input = paperStrategyUpdateSchema.safeParse({ expectedRevision: revision, definition, enabled });
    setInvalid(!input.success);
    if (input.success && !conflict) save.mutate(input.data);
  }
  return (
    <form
      className="mt-5 rounded-xl border border-teal-300/20 bg-slate-950/30 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) submit();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{strategy.id} · 설정 편집</h3>
        <span className="text-[11px] text-slate-500">리비전 {revision}</span>
      </div>
      <p className="mt-3 text-xs leading-6 text-amber-100">
        저장하면 모의 실행 전체가 정지됩니다. 활성화도 자동 재개를 의미하지 않습니다. 종목을 바꾸어도 기존 보유분은 자동
        매도하지 않습니다.
      </p>
      {!strategy.definition && (
        <p className="mt-2 text-xs leading-6 text-slate-400">
          아직 DB에 저장된 매매 조건이 없습니다. 아래 기본값을 검토한 뒤 저장해 주세요.
        </p>
      )}
      <fieldset disabled={save.isPending || conflict} className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs text-slate-400">
          시장
          <select
            className={inputClass}
            value={definition.instrument.market}
            onChange={(event) =>
              setDefinition({
                ...definition,
                instrument: { ...definition.instrument, market: event.target.value as 'KR' | 'US' },
              })
            }
          >
            <option value="KR">국내 · 합성 데모</option>
            <option value="US" disabled>
              미국 · 시세 연결 후 지원
            </option>
          </select>
        </label>
        <label className="text-xs text-slate-400">
          종목 코드
          <input
            className={inputClass}
            value={definition.instrument.symbol}
            maxLength={40}
            required
            onChange={(event) =>
              setDefinition({
                ...definition,
                instrument: { ...definition.instrument, symbol: event.target.value.toUpperCase() },
              })
            }
          />
        </label>
        <label className="text-xs text-slate-400">
          1회 주문 수량
          <input
            className={inputClass}
            value={definition.quantity}
            inputMode="numeric"
            pattern="[1-9][0-9]{0,11}"
            required
            onChange={(event) => setDefinition({ ...definition, quantity: event.target.value })}
          />
        </label>
        <label className="text-xs text-slate-400">
          단기 이동평균 기간
          <input
            className={inputClass}
            type="number"
            min={1}
            max={1999}
            required
            value={definition.parameters.fastPeriod}
            onChange={(event) =>
              setDefinition({
                ...definition,
                parameters: { ...definition.parameters, fastPeriod: Number(event.target.value) },
              })
            }
          />
        </label>
        <label className="text-xs text-slate-400">
          장기 이동평균 기간
          <input
            className={inputClass}
            type="number"
            min={2}
            max={2000}
            required
            value={definition.parameters.slowPeriod}
            onChange={(event) =>
              setDefinition({
                ...definition,
                parameters: { ...definition.parameters, slowPeriod: Number(event.target.value) },
              })
            }
          />
        </label>
        <label className="text-xs text-slate-400">
          관측당 최대 체결 수량
          <input
            className={inputClass}
            value={definition.maxFillQuantity}
            inputMode="numeric"
            pattern="[1-9][0-9]{0,11}"
            required
            onChange={(event) => setDefinition({ ...definition, maxFillQuantity: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="accent-teal-300"
          />
          전략 등록 활성
        </label>
      </fieldset>
      {invalid && (
        <p role="alert" className="mt-4 text-xs text-rose-200">
          단기 기간은 장기보다 작고, 최대 체결 수량은 주문 수량 이하여야 합니다. 종목·정수 수량도 확인해 주세요.
        </p>
      )}
      {conflict && (
        <p role="alert" className="mt-4 text-xs text-amber-200">
          다른 변경이 먼저 저장되었습니다. 편집을 닫고 최신 설정으로 다시 열어 주세요.
        </p>
      )}
      {save.isError && !conflict && (
        <p role="alert" className="mt-4 text-xs text-rose-200">
          저장 여부를 확인하지 못했습니다. 최신 리비전을 확인한 뒤 다시 시도해 주세요.
        </p>
      )}
      <div className="mt-5 flex gap-3">
        <button
          type="submit"
          disabled={save.isPending || conflict}
          className="rounded-lg bg-teal-300 px-4 py-2.5 text-xs font-semibold text-slate-950 disabled:opacity-40"
        >
          {save.isPending ? '저장 확인 중…' : '저장하고 정지'}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={save.isPending}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-xs text-slate-300"
        >
          편집 닫기
        </button>
      </div>
    </form>
  );
}
