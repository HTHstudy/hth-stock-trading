import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { watchlistUpdateSchema } from '@hth/contracts';
import type { WatchlistState } from '@hth/contracts';
import { WATCHLIST_API } from '@shared/api/watchlist';

const inputClass =
  'rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-200 disabled:opacity-40';
function WatchlistForm({
  state,
  onClose,
  onSaved,
}: {
  state: WatchlistState;
  onClose: () => void;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const [revision] = useState(state.revision);
  const [draft, setDraft] = useState(state.instruments.map((item) => ({ ...item })));
  const [invalid, setInvalid] = useState(false);
  const save = useMutation({
    mutationFn: WATCHLIST_API.save,
    retry: false,
    onMutate: () => client.cancelQueries({ queryKey: ['watchlist'] }),
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey: ['watchlist'] });
      client.setQueryData(['watchlist'], result);
      onSaved();
      await client.cancelQueries({ queryKey: ['dashboard'] });
      await client.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
  const conflict = state.revision !== revision || save.error?.message === 'WATCHLIST_REVISION_CONFLICT';
  function submit() {
    const input = watchlistUpdateSchema.safeParse({ expectedRevision: revision, instruments: draft });
    setInvalid(!input.success);
    if (input.success && !conflict) save.mutate(input.data);
  }
  return (
    <form
      className="mt-4 rounded-xl border border-teal-300/20 bg-slate-950/30 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) submit();
      }}
    >
      <p className="text-xs leading-6 text-slate-400">
        조회할 종목 코드만 저장합니다. 전략·보유분은 변경하지 않습니다. 저장 후 상단 새로고침으로 시세를 조회해 주세요.
      </p>
      <fieldset disabled={save.isPending || conflict} className="mt-3 space-y-2">
        {draft.map((item, index) => (
          <div key={index} className="flex gap-2">
            <select
              aria-label={`${index + 1}번 시장`}
              className={`${inputClass} w-16 shrink-0`}
              value={item.market}
              onChange={(event) =>
                setDraft(
                  draft.map((old, i) => (i === index ? { ...old, market: event.target.value as 'KR' | 'US' } : old)),
                )
              }
            >
              <option value="KR">국내</option>
              <option value="US">미국</option>
            </select>
            <input
              aria-label={`${index + 1}번 종목 코드`}
              className={`${inputClass} min-w-0 flex-1 uppercase`}
              value={item.symbol}
              maxLength={40}
              placeholder={item.market === 'KR' ? '종목 코드' : '티커'}
              onChange={(event) =>
                setDraft(
                  draft.map((old, i) => (i === index ? { ...old, symbol: event.target.value.toUpperCase() } : old)),
                )
              }
            />
            <button
              type="button"
              aria-label={`${index + 1}번 종목 삭제`}
              className="shrink-0 px-1 text-xs text-rose-300"
              onClick={() => setDraft(draft.filter((_, i) => i !== index))}
            >
              삭제
            </button>
          </div>
        ))}
        {!draft.length && (
          <p className="py-2 text-xs text-slate-500">빈 목록으로 저장할 수 있습니다. 기본 종목을 다시 넣지 않습니다.</p>
        )}
        <button
          type="button"
          disabled={draft.length >= 20}
          className="mt-2 text-xs text-teal-200 disabled:opacity-40"
          onClick={() => setDraft([...draft, { market: 'KR', symbol: '' }])}
        >
          + 종목 추가 ({draft.length}/20)
        </button>
      </fieldset>
      {invalid && (
        <p role="alert" className="mt-3 text-xs leading-5 text-rose-300">
          중복 없이 최대 20개까지 저장합니다. 코드는 영문·숫자·점·하이픈으로 입력해 주세요.
        </p>
      )}
      {conflict && (
        <p role="alert" className="mt-3 text-xs leading-5 text-amber-200">
          다른 창에서 목록이 변경됐습니다. 취소 후 최신 목록으로 다시 편집해 주세요.
        </p>
      )}
      {save.isError && !conflict && (
        <p role="alert" className="mt-3 text-xs leading-5 text-rose-300">
          저장 여부를 확인하지 못했습니다. 자동으로 재전송하지 않습니다. 취소 후 목록을 다시 조회해 주세요.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={save.isPending || conflict}
          className="rounded-md bg-teal-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40"
        >
          {save.isPending ? '저장 확인 중…' : '저장'}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          onClick={onClose}
          className="rounded-md border border-slate-700 px-3 py-2 text-xs"
        >
          취소
        </button>
      </div>
    </form>
  );
}
export function WatchlistEditor() {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: ['watchlist'],
    queryFn: ({ signal }) => WATCHLIST_API.get(signal),
    staleTime: 5000,
  });
  return (
    <div className="mt-3 border-b border-slate-800 pb-4">
      <p className="text-[11px] leading-5 text-slate-500">
        {!query.data
          ? '조회용 관심종목 설정'
          : query.data.origin === 'environment'
            ? '서버 초기 설정을 표시합니다. 직접 저장하기 전까지 기본값입니다.'
            : '저장한 관심종목 · 매매 대상과 별도'}
      </p>
      {query.data && (
        <p className="mt-2 break-words text-xs text-slate-400">
          {query.data.instruments.length
            ? query.data.instruments.map((item) => `${item.market}:${item.symbol}`).join(' · ')
            : '등록한 관심종목 없음'}
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          disabled={!query.data || query.isError || editing}
          className="text-xs text-teal-200 disabled:opacity-40"
          onClick={() => {
            setEditing(true);
            setSaved(false);
          }}
        >
          관심종목 관리
        </button>
        <button
          type="button"
          disabled={query.isFetching}
          className="text-xs text-slate-400"
          onClick={() => void query.refetch()}
        >
          설정 다시 읽기
        </button>
      </div>
      {query.isError && (
        <p role="alert" className="mt-2 text-xs text-rose-300">
          관심종목 설정을 조회하지 못했습니다.
        </p>
      )}
      {query.isPending && (
        <p role="status" className="mt-2 text-xs text-slate-500">
          관심종목 설정을 읽고 있습니다…
        </p>
      )}
      {saved && (
        <p role="status" className="mt-3 text-xs leading-5 text-teal-200">
          관심종목을 저장했습니다. 상단 새로고침으로 새 목록의 시세를 조회해 주세요. 기존 30초 조회 간격은 유지됩니다.
          거래는 시작하지 않았습니다.
        </p>
      )}
      {editing && query.data && (
        <WatchlistForm
          state={query.data}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            setSaved(true);
          }}
        />
      )}
    </div>
  );
}
