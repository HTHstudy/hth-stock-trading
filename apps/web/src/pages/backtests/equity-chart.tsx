import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, LineStyle, createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { getChartTheme } from '@shared/lib/chart-theme';
import { useTheme } from '@shared/lib/theme';
import type { BacktestArtifact } from '@shared/api/backtests';
import { chartPoints } from './model';

export function EquityChart({ reports }: { reports: BacktestArtifact[] }) {
  const container = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const chartInstance = useRef<{ chart: IChartApi; series: ISeriesApi<'Line'>[] } | null>(null);
  const unavailable = reports.some((report) => chartPoints(report.report.equity) === null);
  useEffect(() => {
    if (!container.current || unavailable) return;
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { attributionLogo: true },
      timeScale: { timeVisible: true },
      localization: {
        locale: 'ko-KR',
        timeFormatter: (time: number) => new Date(time * 1000).toLocaleString('ko-KR', { timeZone: 'UTC' }),
      },
    });
    const chartSeries: ISeriesApi<'Line'>[] = [];
    chartInstance.current = { chart, series: chartSeries };
    reports.forEach((artifact, index) => {
      const points = chartPoints(artifact.report.equity);
      if (!points) return;
      const series = chart.addSeries(LineSeries, {
        lineWidth: 2,
        lineStyle: index ? LineStyle.Dashed : LineStyle.Solid,
        priceFormat: { type: 'percent', precision: 4, minMove: 0.0001 },
        title: `${index ? '비교' : '기준'} ${artifact.report.strategy.parameters.fastPeriod}/${artifact.report.strategy.parameters.slowPeriod}`,
      });
      chartSeries.push(series);
      series.setData(points.map((point) => ({ ...point, time: point.time as UTCTimestamp })));
    });
    chart.timeScale().fitContent();
    return () => {
      chartInstance.current = null;
      chart.remove();
    };
  }, [reports, unavailable]);

  useEffect(() => {
    const instance = chartInstance.current;
    if (!instance) return;
    const palette = getChartTheme(theme);
    instance.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: palette.background }, textColor: palette.text },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.border },
      timeScale: { borderColor: palette.border },
      crosshair: { vertLine: { color: palette.text }, horzLine: { color: palette.text } },
    });
    instance.series.forEach((series, index) =>
      series.applyOptions({ color: index ? palette.comparisonLine : palette.line }),
    );
  }, [theme, reports, unavailable]);
  if (unavailable)
    return (
      <p role="status" className="p-10 text-sm text-warning">
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
