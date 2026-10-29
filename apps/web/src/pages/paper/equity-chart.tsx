import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineSeries } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';
import type { PaperEquityHistory } from '@hth/contracts';
import { equityChartPoints } from './equity-model';
export function EquityChart({ points, currencyIndex }: { points: PaperEquityHistory['points']; currencyIndex: 0 | 1 }) {
  const element = useRef<HTMLDivElement>(null);
  const data = equityChartPoints(points, currencyIndex);
  useEffect(() => {
    if (!element.current) return;
    const values = equityChartPoints(points, currencyIndex);
    if (!values || values.length < 2) return;
    const chart = createChart(element.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0d1424' }, textColor: '#94a3b8', attributionLogo: true },
      grid: { vertLines: { color: '#1b2639' }, horzLines: { color: '#1b2639' } },
      timeScale: { timeVisible: true },
      localization: {
        locale: 'ko-KR',
        timeFormatter: (time: number) => new Date(time * 1000).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      },
    });
    chart
      .addSeries(LineSeries, {
        color: '#5eead4',
        lineWidth: 2,
        priceFormat: { type: 'price', precision: currencyIndex === 0 ? 0 : 2, minMove: currencyIndex === 0 ? 1 : 0.01 },
      })
      .setData(values.map(({ time, value }) => ({ time: time as UTCTimestamp, value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, currencyIndex]);
  if (!data)
    return (
      <p className="py-8 text-xs text-amber-200">
        차트 표시 범위나 시각 순서를 확인할 수 없습니다. 정확한 값은 표에서 확인하세요.
      </p>
    );
  if (data.length < 2)
    return (
      <p className="py-8 text-xs text-slate-500">서로 다른 시각의 평가 기록이 2개 이상 쌓이면 추이를 표시합니다.</p>
    );
  return (
    <div
      ref={element}
      className="h-64 w-full"
      role="img"
      aria-label="선택 통화의 기록된 Paper 자산 추이. 정확한 값은 아래 표에서 확인할 수 있습니다."
    />
  );
}
