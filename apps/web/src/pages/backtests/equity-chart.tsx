import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, LineStyle, createChart } from 'lightweight-charts';
import type { UTCTimestamp } from 'lightweight-charts';
import type { BacktestArtifact } from '@shared/api/backtests';
import { chartPoints } from './model';

export function EquityChart({ reports }: { reports: BacktestArtifact[] }) {
  const container = useRef<HTMLDivElement>(null);
  const unavailable = reports.some((report) => chartPoints(report.report.equity) === null);
  useEffect(() => {
    if (!container.current || unavailable) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#111a2b' }, textColor: '#94a3b8', attributionLogo: true },
      grid: { vertLines: { color: '#1b2639' }, horzLines: { color: '#1b2639' } },
      timeScale: { timeVisible: true, borderColor: '#263247' },
      rightPriceScale: { borderColor: '#263247' },
      localization: {
        locale: 'ko-KR',
        timeFormatter: (time: number) => new Date(time * 1000).toLocaleString('ko-KR', { timeZone: 'UTC' }),
      },
    });
    reports.forEach((artifact, index) => {
      const points = chartPoints(artifact.report.equity);
      if (!points) return;
      const series = chart.addSeries(LineSeries, {
        color: index ? '#a78bfa' : '#5eead4',
        lineWidth: 2,
        lineStyle: index ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat: { type: 'percent', precision: 4, minMove: 0.0001 },
        title: `${index ? '비교' : '기준'} ${artifact.report.strategy.parameters.fastPeriod}/${artifact.report.strategy.parameters.slowPeriod}`,
      });
      series.setData(points.map((point) => ({ ...point, time: point.time as UTCTimestamp })));
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [reports, unavailable]);
  if (unavailable)
    return (
      <p role="status" className="p-10 text-sm text-amber-200">
        차트로 표시할 수 있는 숫자 범위를 초과했습니다. 정확한 값은 성과 표에서 확인하세요.
      </p>
    );
  return (
    <div
      ref={container}
      className="h-80 w-full"
      role="img"
      aria-label="백테스트 누적 수익률 곡선. 정확한 성과는 위 지표와 아래 비교 표에서 확인할 수 있습니다."
    />
  );
}
