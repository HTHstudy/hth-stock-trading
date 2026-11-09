import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ResearchDisclosure, ResearchPage } from './index';
import { researchFixture } from './research-fixture';
import { executionDescription, executionKey, filterRows, strategyParametersLabel } from './model';
import { ResearchMetricsTable, ResearchResults } from './results';
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
  const capital = renderToString(
    createElement(ResearchMetricsTable, { snapshot, rows: snapshot.rows, view: 'capital' }),
  );
  expect(capital).toContain('투자 없음');
  expect(capital).toContain('미검증 · 전략 0체결');
  expect(capital).toContain('벤치마크 자체 행 · 0체결 미검증');
  expect(html.indexOf('이동평균 교차')).toBeLessThan(html.indexOf('매수 후 보유'));
  const disclosure = renderToString(
    createElement(ResearchDisclosure, { entryAfterClosedCandles: snapshot.benchmark.entryAfterClosedCandles }),
  );
  for (const text of [
    'pointInTime=false',
    '사후 수집한 과거 자료',
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
      createElement(ResearchMetricsTable, {
        snapshot,
        view: 'capital',
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
    const visibleText = html.replace(/<details[\s\S]*?<\/details>/g, '').replace(/<[^>]*>/g, '');
    expect(visibleText).not.toContain(snapshot.snapshotHash);
    expect(html).toContain(`snapshot ${snapshot.snapshotHash}`);
    expect(html).not.toContain('ma-base-validation');
    expect(html).not.toContain('ma-base-stress');
    expect(filterRows(snapshot.rows, '', '')).toHaveLength(12);
    expect(filterRows(snapshot.rows, 'research', '')).toHaveLength(8);
  } finally {
    client.clear();
  }
});

it('성과가 기본이며 두 지표 보기 버튼과 이동 안내를 표 앞에 제공한다', () => {
  const snapshot = researchFixture();
  const html = renderToString(createElement(ResearchResults, { snapshot, rows: snapshot.rows }));
  expect(html).toMatch(/aria-pressed="true"[^>]*>성과<\/button>/);
  expect(html).toMatch(/aria-pressed="false"[^>]*>투자금·보유 시간<\/button>/);
  expect(html.indexOf('투자금·보유 시간</button>')).toBeLessThan(html.indexOf('<table'));
  expect(html).toContain('전략명은 고정됩니다');
  expect(html).not.toContain('scope="col" class="px-4 py-4 font-medium">최대 투자 원가');
});

it('두 보기는 각 8열로 모든 기존 지표를 나누고 행 순서와 서버 표시값을 유지한다', () => {
  const snapshot = researchFixture();
  const row = snapshot.rows[0]!;
  const rows = [
    {
      ...row,
      metrics: {
        ...row.metrics,
        initialCash: '12345.67',
        netPnl: '-12.34',
        cumulativeReturnPct: '-0.1234',
        maxDrawdownPct: '1.2345',
        fillCount: 3,
        totalFees: '2.34',
        totalTax: '0.56',
        endingQuantity: '7.25',
      },
      unfilledAtEnd: 2,
      comparisonStatus: 'compared' as const,
      netPnlDifference: '-4.56',
      exposure: {
        ...row.exposure,
        holdingMilliseconds: 90061000,
        holdingPct: '12.3456',
        maxInvestedCapital: '2345.67',
        averageInvestedCapital: '345.67',
        netPnlOverMaxInvestedCapitalPct: '-0.5261',
      },
    },
    snapshot.rows[1]!,
  ];
  const render = (view: 'performance' | 'capital') =>
    renderToString(createElement(ResearchMetricsTable, { snapshot, rows, view })).replaceAll('<!-- -->', '');
  const performance = render('performance');
  const capital = render('capital');
  for (const html of [performance, capital]) {
    expect(html.match(/scope="col"/g)).toHaveLength(8);
    expect(html.match(/scope="row"/g)).toHaveLength(2);
    expect(html.indexOf('이동평균 교차')).toBeLessThan(html.indexOf('매수 후 보유'));
    expect(html).toContain('sticky left-0');
    const metricCells = [...html.matchAll(/<td class="([^"]*)"/g)];
    expect(metricCells).toHaveLength(rows.length * 7);
    for (const cell of metricCells) expect(cell[1]?.split(' ')).toContain('whitespace-nowrap');
    const rowHeaders = [...html.matchAll(/<th scope="row" class="([^"]*)"/g)];
    expect(rowHeaders).toHaveLength(rows.length);
    for (const header of rowHeaders) expect(header[1]?.split(' ')).not.toContain('whitespace-nowrap');
    expect(html).toContain('isolate overflow-x-auto');
    expect(html).toContain('−12.34');
    expect(html).toContain('2026-10-01 ~ 2026-10-02');
    expect(html).not.toContain(row.reportHash);
  }
  for (const value of ['12,345.67', '−0.1234%', '1.2345%', '3 / 2', '2.34', '0.56', '−4.56'])
    expect(performance).toContain(value);
  for (const value of ['1일 1시간 1분 1초', '12.3456%', '2,345.67', '345.67', '−0.5261%', '7.2500'])
    expect(capital).toContain(value);
  expect(performance).not.toContain('보유 기간 (달력)</th>');
  expect(capital).not.toContain('MDD</th>');
});

it('연구 한계의 핵심 안내는 상세 밖에 남기고 긴 설명은 기본 닫힘이다', () => {
  const html = renderToString(createElement(ResearchDisclosure, { entryAfterClosedCandles: 21 }));
  expect(html).toContain('사후 수집한 과거 자료를 사용한 탐색 연구');
  expect(html).not.toContain('이미 열람한');
  expect(html.indexOf('사후 수집한 과거 자료')).toBeLessThan(html.indexOf('<details'));
  expect(html).toContain('독립 검증이나 전략 선정·운용 승인이 아닙니다');
  expect(html.indexOf('Paper 설정을 변경하지 않습니다')).toBeLessThan(html.indexOf('<details'));
  expect(html).not.toMatch(/<details[^>]* open/);
  expect(html.indexOf('pointInTime=false')).toBeGreaterThan(html.indexOf('<details'));
  expect(html).toContain('야간·주말');
});

it('선택 체결 규칙의 JSON은 행 상세에서만 제공하고 비용 필터의 문자열 구분은 보존한다', () => {
  const snapshot = researchFixture();
  const row = snapshot.rows[0]!;
  row.execution.executionRules = {
    formatVersion: 'execution-rules-v1',
    priceRule: 'fixed',
    venueAssumption: 'unspecified',
    boardAssumption: 'unspecified',
    assetClassAssumption: 'unspecified',
    buyFee: { rounding: 'ceil', minimum: '0', maximum: null },
    sellFee: { rounding: 'floor', minimum: '0', maximum: '1' },
  };
  expect(executionDescription(row)).toContain('별도 체결 규칙 적용');
  expect(executionDescription(row)).not.toContain('formatVersion');
  const other = {
    ...row,
    execution: {
      ...row.execution,
      executionRules: {
        ...row.execution.executionRules,
        buyFee: { rounding: 'ceil' as const, minimum: '1', maximum: null },
      },
    },
  };
  expect(filterRows([other, row], row.dataset, executionKey(row))).toEqual([row]);
  for (const view of ['performance', 'capital'] as const) {
    const html = renderToString(createElement(ResearchMetricsTable, { snapshot, rows: [row], view }));
    expect(html).toContain('formatVersion');
    expect(html.replace(/<details[\s\S]*?<\/details>/g, '')).not.toContain('formatVersion');
  }
});

it('전체 기간의 각 행은 날짜로 구분하고 raw 데이터셋·조건 ID는 상세에만 둔다', () => {
  const snapshot = researchFixture();
  const first = snapshot.rows[1]!;
  const nextDataset = {
    ...snapshot.datasets[0]!,
    id: 'raw-validation-id',
    request: { ...snapshot.datasets[0]!.request, from: '2025-01-01', to: '2025-12-31' },
  };
  snapshot.datasets.push(nextDataset);
  const rows = [
    { ...first, variant: 'hold-raw-hash-first' },
    { ...first, dataset: nextDataset.id, variant: 'hold-raw-hash-second', reportHash: '1'.repeat(64) },
  ];
  for (const view of ['performance', 'capital'] as const) {
    const html = renderToString(createElement(ResearchMetricsTable, { snapshot, rows, view })).replaceAll(
      '<!-- -->',
      '',
    );
    const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(visible).toContain('2026-10-01 ~ 2026-10-02');
    expect(visible).toContain('2025-01-01 ~ 2025-12-31');
    expect(visible.indexOf('2026-10-01')).toBeLessThan(visible.indexOf('2025-01-01'));
    expect(visible).not.toContain('raw-validation-id');
    expect(visible).not.toContain('hold-raw-hash');
    expect(html).toContain('데이터셋 ID: research · 조건 ID: hold-raw-hash-first');
    expect(html).toContain('데이터셋 ID: raw-validation-id · 조건 ID: hold-raw-hash-second');
  }
});
