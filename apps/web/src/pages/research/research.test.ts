import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ResearchDisclosure, ResearchPage } from './index';
import { researchFixture } from './research-fixture';
import { executionKey, filterRows, strategyParametersLabel } from './model';
import { ResearchResults } from './results';
import { researchSnapshotOptions } from './api';

afterEach(() => vi.unstubAllGlobals());

it('설정 문자열 필터는 비용 숫자 비교 없이 원본 순서와 벤치마크 행을 유지한다', () => {
  const snapshot = researchFixture();
  const stress = {
    ...snapshot.rows[0]!,
    variant: 'ma-stress',
    execution: { ...snapshot.rows[0]!.execution, buyFeeBps: '10' },
  };
  const rows = [stress, ...snapshot.rows];
  expect(filterRows(rows, '', '')).toEqual(rows);
  expect(filterRows(rows, 'research', executionKey(snapshot.rows[0]!))).toEqual(snapshot.rows);
  expect(filterRows(rows, 'missing', '')).toEqual([]);
  expect(filterRows(rows, '', executionKey(stress))).toEqual([stress]);
});

it('0체결·투자 없음·벤치마크 자체 행과 연구 한계를 숨기지 않는다', () => {
  const snapshot = researchFixture();
  const html = renderToString(createElement(ResearchResults, { snapshot, rows: snapshot.rows }));
  expect(html).toContain('미검증 · 전략 0체결');
  expect(html).toContain('벤치마크 자체 행 · 0체결 미검증');
  expect(html).toContain('투자 없음');
  expect(html.indexOf('이동평균 교차')).toBeLessThan(html.indexOf('매수 후 보유'));
  const disclosure = renderToString(
    createElement(ResearchDisclosure, { entryAfterClosedCandles: snapshot.benchmark.entryAfterClosedCandles }),
  );
  for (const text of [
    'pointInTime=false',
    '이미 열람한',
    '21개',
    '수량·초기 자금',
    '전액 투자',
    '다음 체결 가능 시가',
    '강제 청산',
    '야간·주말',
    '시간 가중',
    '위험 조정 알파',
    '연율화',
    'Paper 설정',
  ])
    expect(disclosure).toContain(text);
});

it('제외·목록 제한과 빈 목록을 함께 표시한다', () => {
  const client = new QueryClient();
  try {
    client.setQueryData(['strategy-research-list'], { reports: [], rejectedCount: 2, limited: true });
    const html = renderToString(createElement(QueryClientProvider, { client, children: createElement(ResearchPage) }));
    expect(html.replaceAll('<!-- -->', '')).toContain('검증 제외 2개');
    expect(html).toContain('일부 목록만');
    expect(html).toContain('리포트가 없습니다');
  } finally {
    client.clear();
  }
});

it('AAPL의 늦은 응답이 MSFT 선택에 표시되지 않으며 이전 요청 signal을 취소한다', async () => {
  const a = researchFixture();
  const b = researchFixture('b'.repeat(64), 'MSFT');
  let resolveA!: (response: Response) => void;
  let firstSignal!: AbortSignal;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (fetchMock.mock.calls.length === 1) {
      firstSignal = init.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveA = resolve;
      });
    }
    return Promise.resolve(Response.json(b));
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient();
  const observer = new QueryObserver(client, researchSnapshotOptions(a.snapshotHash));
  const unsubscribe = observer.subscribe(() => {});
  try {
    observer.setOptions(researchSnapshotOptions(b.snapshotHash));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.snapshotHash).toBe(b.snapshotHash));
    expect(firstSignal.aborted).toBe(true);
    resolveA(Response.json(a));
    await Promise.resolve();
    expect(observer.getCurrentResult().data?.datasets[0]?.request.instrument.symbol).toBe('MSFT');
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  } finally {
    unsubscribe();
    client.clear();
  }
});

it('요청 hash와 다른 상세 DTO를 거부한다', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(researchFixture('b'.repeat(64)))));
  const client = new QueryClient();
  try {
    await expect(client.fetchQuery(researchSnapshotOptions('a'.repeat(64)))).rejects.toThrow('RESEARCH_HASH_MISMATCH');
  } finally {
    client.clear();
  }
});

it('파라미터를 전략별 문구로 표시하고 보유 진입 대기는 snapshot 설정을 따른다', () => {
  const snapshot = researchFixture();
  const row = snapshot.rows[0]!;
  expect(strategyParametersLabel(row, 37)).toBe('단기 5 / 장기 20봉');
  expect(
    strategyParametersLabel(
      {
        ...row,
        strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 20, exitPeriod: 10 } },
      },
      37,
    ),
  ).toBe('진입 20 / 청산 10봉');
  expect(
    strategyParametersLabel(
      {
        ...row,
        strategy: { id: 'mean-reversion', version: '1.0.0', parameters: { period: 20, entryDeviationBps: '200' } },
      },
      37,
    ),
  ).toBe('20봉 · 이탈 200bps');
  snapshot.benchmark.entryAfterClosedCandles = 37;
  const html = renderToString(createElement(ResearchResults, { snapshot, rows: snapshot.rows }));
  expect(html).toContain('37개 종료봉 후 1회 진입');
  expect(html).not.toContain('fastPeriod');
  expect(html).not.toContain('entryAfterClosedCandles');
  const disclosure = renderToString(createElement(ResearchDisclosure, { entryAfterClosedCandles: 37 }));
  expect(disclosure).toContain('종료된 봉 37개');
  expect(disclosure).not.toContain('21개');
  const pending = renderToString(createElement(ResearchDisclosure));
  expect(pending).not.toContain('21개');
});

it('순손익 비율이 null이면 측정 구간 부재와 구간 내 투자 없음을 구분한다', () => {
  const snapshot = researchFixture();
  const row = snapshot.rows[0]!;
  const render = (windowMilliseconds: number) =>
    renderToString(
      createElement(ResearchResults, {
        snapshot,
        rows: [{ ...row, exposure: { ...row.exposure, windowMilliseconds } }],
      }),
    );
  expect(render(0)).toContain('측정 구간 없음');
  expect(render(0)).not.toContain('투자 없음');
  expect(render(86400000)).toContain('투자 없음');
  expect(render(86400000)).not.toContain('측정 구간 없음');
});

it('첫 화면은 첫 데이터셋·첫 비용의 네 행만 표시하고 전체 선택 옵션을 유지한다', () => {
  const snapshot = researchFixture();
  const row = snapshot.rows[0]!;
  snapshot.rows.splice(
    1,
    0,
    {
      ...row,
      variant: 'breakout-base',
      reportHash: '1'.repeat(64),
      strategy: { id: 'channel-breakout', version: '1.0.0', parameters: { entryPeriod: 20, exitPeriod: 10 } },
    },
    {
      ...row,
      variant: 'reversion-base',
      reportHash: '2'.repeat(64),
      strategy: { id: 'mean-reversion', version: '1.0.0', parameters: { period: 20, entryDeviationBps: '200' } },
    },
  );
  const expectedRows = [...snapshot.rows];
  snapshot.datasets.push({ ...snapshot.datasets[0]!, id: 'validation', role: 'validation' });
  snapshot.rows.push(
    ...expectedRows.map((item) => ({
      ...item,
      dataset: 'validation',
      variant: `${item.variant}-validation`,
      reportHash: `3${item.reportHash.slice(1)}`,
    })),
  );
  snapshot.rows.push(
    ...expectedRows.map((item) => ({
      ...item,
      variant: `${item.variant}-stress`,
      reportHash: `4${item.reportHash.slice(1)}`,
      execution: { ...item.execution, buyFeeBps: '10' },
    })),
  );
  const client = new QueryClient();
  try {
    client.setQueryData(['strategy-research-list'], {
      reports: [
        {
          snapshotHash: snapshot.snapshotHash,
          sourceResultHash: snapshot.sourceResultHash,
          instrument: { market: 'US', symbol: 'AAPL' },
          interval: '1m',
          currency: 'USD',
          periods: 2,
          rows: snapshot.rows.length,
        },
      ],
      rejectedCount: 0,
      limited: false,
    });
    client.setQueryData(['strategy-research-snapshot', snapshot.snapshotHash], snapshot);
    const html = renderToString(
      createElement(QueryClientProvider, { client, children: createElement(ResearchPage) }),
    ).replaceAll('<!-- -->', '');
    expect(html).toContain('후보와 벤치마크 · 4행');
    expect(html).toContain('value="research" selected=""');
    expect(html).toContain(`value="${executionKey(row).replaceAll('"', '&quot;')}" selected=""`);
    expect(html).toContain('전체 데이터셋');
    expect(html).toContain('전체 비용 설정');
    expect(html).not.toContain('ma-base-validation');
    expect(html).not.toContain('ma-base-stress');
    expect(filterRows(snapshot.rows, '', '')).toHaveLength(12);
    expect(filterRows(snapshot.rows, 'research', '')).toHaveLength(8);
  } finally {
    client.clear();
  }
});
